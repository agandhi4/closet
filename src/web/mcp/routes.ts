import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { BUILD_INFO } from '../../build-info';
import { authenticateToken } from '../auth/personal-tokens';
import { MCP_PATH } from '../page-cache';
import type { WebOptions } from '../plugin';
import { MCP_LIMIT, MCP_LINK_IMPORT_LIMIT } from '../security/rate-limit';
import { requestOrigin } from '../security/origin';
import { registerTools, type ToolContext } from './tool';
import { MCP_TOOLS } from './tools';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

// Every refusal of the credential is this one answer, whatever was wrong
// (no header, a malformed one, an unknown or revoked token), so a probe
// learns nothing about which tokens exist.
const UNAUTHORIZED = { statusCode: 401, message: 'Unauthorized' };

const INSTRUCTIONS =
  "Closet is the user's self-hosted wardrobe: garments with properties, capsules, outfits, a calendar of planned and worn outfits, and wardrobes shared with them. Every tool acts as the user; a shared wardrobe is addressed by its owner's id (ownerId, from list_shared_wardrobes). Tools that write say so; nothing deletes.";

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
  const { db, photos, cutouts, fetcher, config, logger, mcpLogger } = options;
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
        webLogger: logger,
        timeZone: config.timeZone,
        userId: auth.user.id,
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
      registerTools(server, MCP_TOOLS, context, {
        logger: mcpLogger,
        tokenId: auth.tokenId,
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
