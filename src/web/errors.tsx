import type { FastifyReply, FastifyRequest } from 'fastify';
import { STATUS_CODES } from 'node:http';
import { t } from './i18n';
import { Dock } from './layout/dock';
import { Layout } from './layout/layout';
import { Navbar } from './layout/navbar';
import { loggableUrl } from './loggable-url';
import type { Logger } from '../logger';
import { renderPage } from './render';
import type { ViewContext } from './view-context';

/**
 * What a plain-Fastify handler throws to answer with an error page:
 * `throw new HttpError(404)`. The message is shown on the page, so it is
 * for people (the status text by default), never internals.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string = STATUS_CODES[statusCode] ?? 'Error',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const INTERNAL_ERROR = 'Internal server error';

/**
 * Status and page message for anything a route throws: an HttpError or a
 * Fastify error (a failed body parse, a schema validation, an oversized
 * upload) keeps its 4xx status and message; everything else, and every 5xx,
 * is a 500 without detail.
 */
export function describeError(error: unknown): {
  status: number;
  message: string;
} {
  if (error instanceof Error) {
    const { statusCode } = error as Error & { statusCode?: unknown };
    if (
      typeof statusCode === 'number' &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      return { status: statusCode, message: error.message };
    }
  }
  return { status: 500, message: INTERNAL_ERROR };
}

/**
 * The app's error handler (set at the root by createApp(), so every route
 * and the not-found handler share it): the error page, in the layout, with
 * the status of the failure. The login redirect and 401 never reach it,
 * requireSession answers those itself.
 */
export function createErrorHandler(logger: Logger) {
  return async function handleError(
    error: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const { status, message } = describeError(error);
    const url = loggableUrl(request);
    if (status >= 500) {
      logger.error({ err: error }, `${request.method} ${url} -> ${status}`);
    } else {
      logger.warn(`${request.method} ${url} -> ${status}: ${message}`);
    }

    if (reply.sent) {
      logger.warn(`${url}: response already sent, no error page`);
      return;
    }
    // No page context: a static path (the root hook skips those; their
    // routes, /file/**, /healthz and /manifest.json, answer data), or a
    // failure before the root preValidation hook ran, such as an unparsable
    // body. Data, then.
    if (!reply.locals) {
      return reply.status(status).send({ statusCode: status, message });
    }
    return renderPage(
      reply,
      <ErrorPage
        ctx={reply.locals}
        status={status}
        message={message}
        path={request.url}
      />,
      { status },
    );
  };
}

export function ErrorPage(props: {
  ctx: ViewContext;
  status: number;
  message: string;
  path: string;
}) {
  return (
    <Layout ctx={props.ctx}>
      <Navbar ctx={props.ctx} />
      <main class="p-20 flex flex-col justify-center items-center h-full">
        <h1>
          {t('ERROR')} {props.status}
        </h1>
        <p>{props.message}</p>
        <p>
          <small>
            {t('PATH')}: {props.path}
          </small>
        </p>
        <p>
          <small>
            {t('TIME')}: {new Date().toISOString()}
          </small>
        </p>
        <a href="/" class="btn">
          {t('RETURN_TO_HOME')}
        </a>
      </main>
      <Dock ctx={props.ctx} />
    </Layout>
  );
}
