import type { FastifyReply, FastifyRequest } from 'fastify';
import { STATUS_CODES } from 'node:http';
import { t } from './i18n';
import { AppBar } from './layout/app-bar';
import { Dock } from './layout/dock';
import { Layout } from './layout/layout';
import { loggableUrl } from './loggable-url';
import type { Logger } from '../logger';
import type { ErrorTracker } from '../metrics/error-tracker';
import { renderPage } from './render';
import type { ViewContext } from './view-context';

/**
 * What a plain-Fastify handler throws to answer with an error page:
 * `throw new HttpError(404)`. The message is shown on the page, so it is
 * for people (the status text by default), never internals; `logDetail` is
 * what the log line adds (ids, the operation), never shown. Any status,
 * a 5xx included (the owner lock's 503): an HttpError is an answer the code
 * chose, not a crash.
 */
export class HttpError extends Error {
  readonly logDetail?: string;

  constructor(
    readonly statusCode: number,
    message: string = STATUS_CODES[statusCode] ?? 'Error',
    options: { logDetail?: string } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.logDetail = options.logDetail;
  }
}

const INTERNAL_ERROR = 'Internal server error';

export interface ErrorAnswer {
  status: number;
  message: string;
  /** For the log line, never the answer (HttpError.logDetail). */
  logDetail?: string;
  /** A crash, not a chosen answer: logged with its stack. */
  unexpected: boolean;
}

/**
 * Status and page message for anything a route or tool throws: an HttpError
 * keeps its status and message; a Fastify error (a failed body parse, a
 * schema validation, an oversized upload) its 4xx status and message;
 * everything else is an unexpected 500 without detail.
 */
export function describeError(error: unknown): ErrorAnswer {
  if (error instanceof HttpError) {
    return {
      status: error.statusCode,
      message: error.message,
      logDetail: error.logDetail,
      unexpected: false,
    };
  }
  if (error instanceof Error) {
    const { statusCode } = error as Error & { statusCode?: unknown };
    if (
      typeof statusCode === 'number' &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      return { status: statusCode, message: error.message, unexpected: false };
    }
  }
  return { status: 500, message: INTERNAL_ERROR, unexpected: true };
}

/**
 * The app's error handler (set at the root by createApp(), so every route
 * and the not-found handler share it): the error page, in the layout, with
 * the status of the failure. The login redirect and 401 never reach it,
 * requireSession answers those itself.
 *
 * Only an unexpected error (the 500) goes to the error tracker (#117).
 * An HttpError is an answer the code chose, whatever its status: a 4xx
 * refusal, and the owner lock's 503 (OwnerLockTimeout), which asks the
 * person to try again while another write holds their wardrobe. That 503
 * is contention working as designed; what stalled the other writer (a
 * statement or idle-in-transaction timeout) fails its own request with an
 * unexpected error, which is captured there. The 503s themselves stay in
 * the warn line and the request metric's 5xx.
 */
export function createErrorHandler(logger: Logger, errors: ErrorTracker) {
  return async function handleError(
    error: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const { status, message, logDetail, unexpected } = describeError(error);
    const url = loggableUrl(request);
    if (unexpected) {
      logger.error({ err: error }, `${request.method} ${url} -> ${status}`);
      errors.captureException(error, {
        source: 'route',
        tags: {
          route: request.routeOptions.url ?? 'unmatched',
          method: request.method,
        },
        userId: request.auth?.user.id,
      });
    } else {
      logger.warn(
        `${request.method} ${url} -> ${status}: ${message}${logDetail ? ` (${logDetail})` : ''}`,
      );
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
      <AppBar ctx={props.ctx} title={`${t('ERROR')} ${props.status}`} />
      <main class="p-20 flex flex-col justify-center items-center h-full">
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
