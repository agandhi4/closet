import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type * as z from 'zod/v4';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { McpOutcome, Metrics } from '../../metrics/metrics';
import { describeError } from '../errors';
import type { Photos } from '../files/photos';
import type { OutboundFetcher } from '../security/outbound-fetch';
import { authorizeWardrobe, type WardrobeNeed } from '../sharing/access';
import type { WeatherService } from '../weather/service';

/**
 * The MCP tools' shared shape (#33). A tool is data (name, description,
 * input schema, whether it writes) plus `run`, which calls the same query
 * and write functions the pages use and returns plain data; registerTools
 * turns each into an SDK tool that answers JSON text and logs the call.
 * A tool that answers a picture returns an ImageAnswer instead
 * (get_garment_photo). Refusals are thrown as HttpError, as in a route,
 * and follow the same policy (src/web/sharing/access.ts): a wardrobe,
 * garment, capsule, outfit or entry the caller cannot see is "not found"
 * like an unknown id; one they can see but may not change is "not allowed".
 */

/** What every tool gets: the app's services and who is calling. */
export interface ToolContext {
  db: Db;
  photos: Photos;
  cutouts: { wake(): void };
  fetcher: OutboundFetcher;
  /** The weather; undefined with WEATHER_ENABLED=false (no weather tool is listed then). */
  weather: WeatherService | undefined;
  /** The Web logger: the writers the tools call log through it, as for a page. */
  webLogger: Logger;
  /** APP_TIMEZONE: "today" is the household's. */
  timeZone: string;
  /** The token's user: every tool acts exactly as them. */
  userId: number;
  /**
   * add_garment_from_link's budget (MCP_LINK_IMPORT_LIMIT, per user): false
   * when this call would pass it.
   */
  allowLinkImport(): Promise<boolean>;
}

export interface ClosetTool<Input extends z.ZodObject> {
  name: string;
  title: string;
  /** Says what the tool does and, for a write, that it writes. */
  description: string;
  input: Input;
  /** Changes stored data. Nothing deletes: there is no destructive tool. */
  writes: boolean;
  /** Calling it again with the same arguments changes nothing more. */
  idempotent?: boolean;
  /** Reaches beyond the app (add_garment_from_link fetches a shop's page). */
  openWorld?: boolean;
  run(args: z.output<Input>, ctx: ToolContext): Promise<unknown>;
}

/** Typed identity: each tools module lists its tools through it. */
export function defineTool<Input extends z.ZodObject>(
  tool: ClosetTool<Input>,
): ClosetTool<Input> {
  return tool;
}

/**
 * The wardrobe a tool addresses (`ownerId` absent: the caller's own),
 * resolved and refused exactly as a page's `?ownerId=` is.
 */
export async function wardrobeFor(
  ctx: ToolContext,
  ownerId: number | undefined,
  need: WardrobeNeed,
) {
  const { access } = await authorizeWardrobe(
    ctx.db,
    ctx.userId,
    ownerId,
    need,
    'Wardrobe not found',
  );
  return access;
}

/**
 * A tool's answer that is a picture: an MCP image content block (base64,
 * its MIME type), after a text block with `about` (what the picture is of).
 * The bytes go to the client only, never to a log line.
 */
export class ImageAnswer {
  constructor(
    readonly about: unknown,
    readonly data: Buffer,
    readonly mimeType: string,
  ) {}
}

/**
 * Why a call ended, for the log line: a 4xx is 'refused', a chosen 5xx (the
 * owner lock's 503) 'failed', either with the error's log detail.
 */
type Outcome = 'ok' | 'error' | `${'refused' | 'failed'} ${number}${string}`;

// The metric's outcome drops the refusal's status (a closed label set).
function metricOutcome(outcome: Outcome): McpOutcome {
  return outcome === 'ok' || outcome === 'error' ? outcome : 'refused';
}

function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError && { isError: true }),
  };
}

function toolResult(value: unknown): CallToolResult {
  if (!(value instanceof ImageAnswer)) return textResult(value);
  return {
    content: [
      { type: 'text', text: JSON.stringify(value.about) },
      {
        type: 'image',
        data: value.data.toString('base64'),
        mimeType: value.mimeType,
      },
    ],
  };
}

/**
 * Registers `tools` on this request's server. One log line per call
 * (context Mcp): the tool, the user, the token's row id, the outcome and
 * the time; never the arguments (a link can carry a token of its own),
 * never the caller's token and never an answer (an image's bytes
 * included). A refusal (a 4xx HttpError, as a route would answer) is a tool error with its message; anything else is logged with
 * its stack and answered without detail.
 */
export function registerTools(
  server: McpServer,
  tools: readonly ClosetTool<z.ZodObject>[],
  ctx: ToolContext,
  log: { logger: Logger; tokenId: number; metrics: Metrics },
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.writes,
          destructiveHint: false,
          idempotentHint: tool.idempotent ?? !tool.writes,
          openWorldHint: tool.openWorld ?? false,
        },
      },
      async (args: Record<string, unknown>) => {
        const started = performance.now();
        let outcome: Outcome = 'ok';
        try {
          return toolResult(await tool.run(args, ctx));
        } catch (error) {
          const { status, message, logDetail, unexpected } =
            describeError(error);
          if (unexpected) {
            outcome = 'error';
            log.logger.error(
              { err: error },
              `MCP ${tool.name} failed for user ${ctx.userId}`,
            );
          } else {
            outcome = `${status >= 500 ? 'failed' : 'refused'} ${status}${logDetail ? ` (${logDetail})` : ''}`;
          }
          return textResult({ error: message }, true);
        } finally {
          const elapsedMs = performance.now() - started;
          log.logger.info(
            `MCP ${tool.name} by user ${ctx.userId} (token ${log.tokenId}): ${outcome} ${elapsedMs.toFixed(1)}ms`,
          );
          log.metrics.observeMcpCall(
            tool.name,
            metricOutcome(outcome),
            elapsedMs / 1000,
          );
        }
      },
    );
  }
}
