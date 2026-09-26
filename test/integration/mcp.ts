import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { TEST_PASSWORD, type TestApp } from './harness';

/**
 * An MCP client for the integration specs: what Claude Code sends to
 * POST /mcp (Streamable HTTP, JSON-RPC), with a personal access token and
 * nothing else: no session cookie, no Origin (tools send none). Tokens are
 * created the way a person does, on the profile's Agent access page.
 */

/** The token in a page: `closet_` and 43 base64url characters. */
const TOKEN = /closet_[A-Za-z0-9_-]{43}/;

/**
 * POST /auth/tokens as `cookie`'s user (the owner by default), with the
 * harness's password (the step-up); the new token.
 */
export async function createAccessToken(
  t: TestApp,
  { cookie, name = 'Claude Code' }: { cookie?: string; name?: string } = {},
): Promise<string> {
  const res = await t.inject({
    method: 'POST',
    url: '/auth/tokens',
    payload: { name, currentPassword: TEST_PASSWORD },
    headers: cookie ? { cookie } : {},
  });
  expect(res.statusCode).toBe(200);
  const token = TOKEN.exec(res.body)?.[0];
  if (!token) throw new Error(`No token on the page:\n${res.body}`);
  return token;
}

let requestId = 0;

/** One JSON-RPC request to /mcp, as a client sends it. */
export function mcpRequest(
  t: TestApp,
  token: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  requestId += 1;
  return t.inject({
    method: 'POST',
    url: '/mcp',
    anonymous: true,
    sameOrigin: false,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    payload: { jsonrpc: '2.0', id: requestId, method, params },
  });
}

export interface ToolAnswer {
  /** The tool's JSON answer (or `{ error }` for a refusal). */
  value: Record<string, unknown> & { error?: string };
  isError: boolean;
}

/** tools/call: the parsed answer; the HTTP exchange itself must succeed. */
export async function callTool(
  t: TestApp,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolAnswer> {
  const res = await mcpRequest(t, token, 'tools/call', {
    name,
    arguments: args,
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<{
    result?: { content: { type: string; text: string }[]; isError?: boolean };
    error?: { message: string };
  }>();
  if (!body.result) {
    // A JSON-RPC error: the SDK refused the arguments before the tool ran.
    return { value: { error: body.error?.message }, isError: true };
  }
  const { text } = body.result.content[0];
  const isError = body.result.isError === true;
  // The SDK answers arguments outside the schema itself, in plain text.
  if (isError && !text.startsWith('{'))
    return { value: { error: text }, isError };
  return { value: JSON.parse(text) as ToolAnswer['value'], isError };
}

/** callTool that must succeed; its answer. */
export async function tool<T = Record<string, unknown>>(
  t: TestApp,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const answer = await callTool(t, token, name, args);
  expect(answer.isError, JSON.stringify(answer.value)).toBe(false);
  return answer.value as T;
}
