import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { BUILD_INFO } from '../../build-info';
import { authenticateToken } from '../auth/personal-tokens';
import { MAX_CANDIDATES_PER_ITEM } from '../plans/candidates';
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
// wardrobe with the tools (#269). The README's "Styling with an agent" is
// the owner's side of the same workflow; keep the two in step.
const INSTRUCTIONS = [
  "Closet is the user's self-hosted wardrobe: garments with properties, capsules, outfits, a calendar of planned and worn outfits, wardrobes shared with them, and the user's own wardrobe plans with their gaps and shopping list. Every tool acts as the user; a shared wardrobe is addressed by its owner's id (ownerId, from list_shared_wardrobes). Tools that write say so; nothing deletes.",
  'To style the wardrobe (what to add, what to buy):',
  "1. Read first: get_style_profile (styles, budget band, palette, the week's occasions), get_wardrobe (the whole closet in one read; search_garments filters it), get_garment_photo for the pieces you need to see, and get_plan_gaps (what the active plan already asks for and lacks).",
  "2. Build on what is owned: read wardrobe_stats too (what is worn, what idles). Do not propose what the closet already covers (get_plan_gaps shows what fulfils each item); propose real gaps, and treat pieces in replace_soon condition as gaps. In each item's note, name the closet pieces it is meant to pair with.",
  '3. create_plan with a name and notes giving your rationale. It is your draft, never active, and the owner sees which connection drafted it; do not propose into a plan the owner made unless asked.',
  '4. propose_plan_item per item, with the new plan\'s planId. An item is a target in the garment model\'s terms (category, type, colours, materials, warmth and formality ranges, quantity, priority, budget), not a product; its note says why the wardrobe needs it, and its name says what it is in plain words ("White leather sneakers").',
  `5. Every proposed item gets 2 to ${MAX_CANDIDATES_PER_ITEM} product options before you finish: add_candidate with a product URL per option (or add_garment_from_link with the item's planItemId). A product saved to the wishlist without its item is not part of the plan, and the owner reviews each item by its options. get_plan_feedback's needsProducts lists the items still without one.`,
  '6. goes_with_closet on each candidate: how it pairs with what the closet holds, and what it would duplicate.',
  "7. Design looks: once the items have candidates, propose_look a few looks for each occasion in the style profile's week (its rhythm), each mixing closet garments with this plan's candidates so that every candidate appears in at least one look. A piece is a closet garment or a current candidate of this plan (never a declined item's); the note says why the look works and when to wear it. list_looks shows them.",
  'To iterate on an existing plan (a new conversation about it): read get_plan_feedback first, before anything else. It lists only what waits on you. Change each `revise` item as its ownerNote asks with update_plan_item (it returns to the owner as proposed). Replace the rejected products of an item (`replace`, and `new: true` ones) with others through add_candidate, give each `needsProducts` item its options, and never add a rejected product again, by url or by garment. Never re-propose an item listed under `declined`, nor add candidates to it. It also lists `looks`: change each `revise` look as its ownerNote asks with update_look (it returns to the owner as proposed), mend the `incomplete` ones (a slot lost its candidate) with another piece, and never propose again the exact set of pieces of a look under `declined`.',
  'The owner reviews the plan, accepts, changes or declines each item, and buys in the app. Never assume a purchase: a candidate stays on the wishlist until the owner marks it bought.',
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
