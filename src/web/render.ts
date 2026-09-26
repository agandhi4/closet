import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { FRAGMENT_VARY, isFragmentRequest } from '../htmx/fragment-request';

const HTML = 'text/html; charset=utf-8';

interface RenderOptions {
  status?: number;
}

/**
 * Renders JSX to its HTML string. hono/jsx types an element as the string it
 * renders to, but at runtime it is a node whose toString() does the
 * rendering, and returns a Promise as soon as any component in the tree is
 * async; both are awaited here.
 */
export async function renderToString(element: JSX.Element): Promise<string> {
  const node = await element;
  const html = node.toString() as string | Promise<string>;
  return String(await html);
}

/**
 * Sends a whole document: the doctype and a page element (a component that
 * renders <Layout>). Returns the reply, so a handler ends with
 * `return renderPage(reply, <AboutPage ctx={viewContext(reply)} />)`.
 */
export async function renderPage(
  reply: FastifyReply,
  page: JSX.Element,
  options: RenderOptions = {},
): Promise<FastifyReply> {
  return send(reply, `<!DOCTYPE html>${await renderToString(page)}`, options);
}

/** Sends an htmx swap target: markup without the layout around it. */
export async function renderFragment(
  reply: FastifyReply,
  fragment: JSX.Element,
  options: RenderOptions = {},
): Promise<FastifyReply> {
  return send(reply, await renderToString(fragment), options);
}

/**
 * For a route that answers with either a page or a fragment of it: says
 * which one this request wants (src/htmx/fragment-request.ts, shared with the
 * service worker's cache keys) and marks the response as varying on the
 * headers that decide it, whichever branch the handler takes.
 */
export function wantsFragment(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  reply.header('Vary', FRAGMENT_VARY);
  return isFragmentRequest(request.headers);
}

/**
 * The answer to an htmx write that ends on another page (archive, delete):
 * htmx fetches `path` and swaps the body like a boosted link, pushing the
 * URL, so the document, its scripts and the service worker's page stay
 * (https://htmx.org/headers/hx-location/). HX-Redirect reloaded all of it.
 *
 * The follow-up GET says HX-Boosted because it is a whole-page swap:
 * isFragmentRequest (the server's routes and the worker's cache key) reads
 * that header, so the page comes back whole and is cached as the page, and
 * offline the worker answers it with the offline page. `path` is a same-site
 * path the server built, never user input.
 */
export function navigateTo(reply: FastifyReply, path: string): FastifyReply {
  const location = {
    path,
    target: 'body',
    swap: 'innerHTML show:top',
    headers: { 'HX-Boosted': 'true' },
  };
  return reply.header('HX-Location', JSON.stringify(location)).send();
}

function send(
  reply: FastifyReply,
  html: string,
  { status = 200 }: RenderOptions,
): FastifyReply {
  // A second send is a handler bug that Fastify would only log while the
  // client keeps the first response. Fail loudly instead; the error handler
  // sees reply.sent and does not answer again either.
  if (reply.sent) {
    throw new Error(`${reply.request.url}: reply already sent`);
  }
  return reply.status(status).type(HTML).send(html);
}
