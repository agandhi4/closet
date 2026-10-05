import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { BUILD_INFO } from '../../build-info';
import { authenticateToken } from '../auth/personal-tokens';
import { MAX_OPTIONS_PER_GROUP } from '../../wardrobe/suggestions';
import { MCP_PATH } from '../page-cache';
import type { WebOptions } from '../plugin';
import { MCP_LIMIT, MCP_LINK_IMPORT_LIMIT } from '../security/rate-limit';
import { requestOrigin } from '../security/origin';
import { registerTools, type ToolContext } from './tool';
import { mcpTools } from './tools';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

// Every refusal of the credential is this one answer, whatever was wrong
// (no header, a malformed one, an unknown or revoked token), so a probe
// learns nothing about which tokens exist.
const UNAUTHORIZED = { statusCode: 401, message: 'Unauthorized' };

// What the client's model reads first: the server, and how to style a
// wardrobe with the tools (#269, Muse's workflow since #337). The README's
// "Styling with an agent" is the owner's side of the same workflow; keep
// the two in step.
const INSTRUCTIONS = [
  "Closet is the user's self-hosted wardrobe: garments with properties, capsules, outfits, a calendar of planned and worn outfits, a wishlist, and wardrobes shared with them. Every tool acts as the user; a shared wardrobe is addressed by its owner's id (ownerId, from list_shared_wardrobes). Tools that write say so; nothing deletes.",
  'To style the wardrobe (what to add, what to buy), work in rounds. The owner decides in the app; you learn from each decision.',
  '1. Start every conversation with get_suggestion_feedback (what the owner decided since your last call: choices, purchases, outfits loved or declined, and every reason and note), then list_suggestions (what is open, chosen and set aside). Act on every reason: too_pricey, colour, style, already_have, fit_size, not_now.',
  "2. Read the wardrobe: get_style_profile (styles, budget band, palette, the week's occasions), get_wardrobe (the whole closet; search_garments filters it), wardrobe_stats (what is worn, what idles), get_sizes (the owner's size per brand) and get_garment_photo for the pieces you need to see.",
  '3. Find real gaps: get_closet_coverage with the targets you have in mind. Propose only what is missing or partly owned; pieces in replace_soon condition are gaps.',
  '4. create_option_group per need: its name in plain words ("A navy blazer"), the budget, and a note naming the closet pieces it pairs with.',
  `5. Give every need 2 to ${MAX_OPTIONS_PER_GROUP} real products before you finish: suggest_garment per product URL, each with note (material, fit and sizing, price against the budget, what it pairs with; short, it is shown on the option), rank (1 is your pick), the listed price and the size to buy. Research each one; do not just collect links. list_suggestions' stillLooking lists the needs still without one.`,
  '6. goes_with_closet on each option: how it pairs with the closet, and what it would duplicate.',
  '7. suggest_outfit a few outfits for each occasion of the week, mixing closet garments with your options so that every option is in at least one; outfits of closet garments only are welcome too. The owner judges a piece by what it does with their closet, so outfits come first for them.',
  "8. finish_round once at the end, with a one-line summary and feedbackUntil, the `until` of this conversation's get_suggestion_feedback: the owner gets one card on Today and one notification, and what you were told is not told again. Call it even when you suggested nothing new (it then only ends the round).",
  'Rules: never buy, mark anything owned (add_garment_from_link with destination closet is for what the owner already owns), archive or delete; the owner buys in the app. Never propose again anything the owner set aside: a need by its name, a product by its link, an outfit by its garments (the tools refuse them). A need the owner chose an option for is decided: leave it.',
].join('\n');

/**
 * POST /mcp, the MCP endpoint (#33): Streamable HTTP in stateless mode,
 * the SDK's own transport with JSON answers (no SSE, no session id), a
 * server and transport per request. The tools (./tools) call the page's
 * query and write functions as the token's user (src/web/mcp/tool.ts).
 *
 * An API, not a page (`config.bearer`, src/web/auth/require-session.ts):
 * authenticated by a personal access token (src/web/auth/personal-tokens.ts)
 * in `Authorization: Bearer`, never the session cookie; no page context, so
 * errors are JSON; the same-origin check lets a request without Origin
 * through and refuses a foreign one; the service worker never handles it
 * (bypassesWorker). Rate-limited per token (MCP_LIMIT). The path is logged
 * as the pattern (secretPath), so a client that puts a token in the query
 * string never writes it to app.log.
 */
export const mcpRoutes: FastifyPluginCallback<WebOptions> = (
  app,
  options,
  done,
) => {
  const {
    db,
    photos,
    cutouts,
    fetcher,
    weather,
    push,
    config,
    logger,
    mcpLogger,
    metrics,
  } = options;
  const tools = mcpTools({ weather: weather !== undefined });
  const linkImportLimit = app.createRateLimit(MCP_LINK_IMPORT_LIMIT);

  async function requireToken(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const presented = header ? BEARER.exec(header)?.[1] : undefined;
    const auth = presented ? await authenticateToken(db, presented) : undefined;
    if (!auth) {
      mcpLogger.warn(
        `MCP ${request.method} refused: ${presented ? 'unknown or revoked token' : 'no bearer token'} from ${request.ip}`,
      );
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Bearer realm="closet"')
        .send(UNAUTHORIZED);
    }
    request.accessToken = auth;
  }

  const route = {
    config: { bearer: true, secretPath: true },
    preValidation: requireToken,
  } as const;

  app.post(
    MCP_PATH,
    { ...route, config: { ...route.config, rateLimit: MCP_LIMIT } },
    async (request, reply) => {
      const auth = request.accessToken!;
      const context: ToolContext = {
        db,
        photos,
        cutouts,
        fetcher,
        push,
        weather,
        webLogger: logger,
        timeZone: config.timeZone,
        userId: auth.user.id,
        tokenId: auth.tokenId,
        // `isAllowed` is the plugin's allow list; the count is isExceeded.
        allowLinkImport: async () => {
          const verdict = await linkImportLimit(request);
          return verdict.isAllowed || !verdict.isExceeded;
        },
      };
      const server = new McpServer(
        { name: config.appName, version: BUILD_INFO.version },
        { instructions: INSTRUCTIONS },
      );
      registerTools(server, tools, context, {
        logger: mcpLogger,
        metrics,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        // Stateless: every request stands alone, nothing is kept between.
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        const response = await transport.handleRequest(
          new Request(`${requestOrigin(request)}${MCP_PATH}`, {
            method: request.method,
            headers: webHeaders(request),
          }),
          { parsedBody: request.body },
        );
        // Read before closing: closing ends the transport's streams.
        const body = await response.text();
        reply.status(response.status);
        response.headers.forEach((value, name) => {
          // Fastify sets the length of what it sends (compressed or not).
          if (name !== 'content-length') reply.header(name, value);
        });
        return reply.send(body || undefined);
      } finally {
        await server.close();
      }
    },
  );

  // Stateless: no server-to-client stream (GET) and no session to end
  // (DELETE), the SDK's answer for both.
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .status(405)
      .header('Allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
  app.get(MCP_PATH, route, notAllowed);
  app.delete(MCP_PATH, route, notAllowed);
  done();
};

/** The request's headers for the SDK's Web Request (repeated ones joined). */
function webHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}
