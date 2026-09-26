import { HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { STATUS_CODES } from 'node:http';
import { t } from './i18n';
import { Dock } from './layout/dock';
import { Layout } from './layout/layout';
import { Navbar } from './layout/navbar';
import type { WebLogger } from './logger';
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
 * Status and page message for anything a route throws, as ErrorViewFilter
 * decides them for Nest routes: an HttpError or a Fastify error (a failed
 * body parse, a schema validation) keeps its 4xx status and message;
 * everything else, and every 5xx, is a 500 without detail.
 */
export function describeError(error: unknown): {
  status: number;
  message: string;
} {
  // Services not yet ported still throw Nest's exceptions (NotFoundException
  // from a query, ForbiddenException from resolveAccess); a ported handler
  // calling one must answer as the Nest route did. Goes with Nest.
  if (error instanceof HttpException) {
    return {
      status: error.getStatus(),
      message: httpExceptionMessage(error),
    };
  }
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

// getResponse() is the string or body the exception was built with; a
// ValidationPipe's BadRequestException carries one message per failure.
function httpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const { message } = response as { message?: unknown };
  if (Array.isArray(message)) return message.join(',');
  return typeof message === 'string' ? message : exception.message;
}

/**
 * The plugin-scoped error handler (src/web/plugin.ts): the error page, in
 * the layout, with the status of the failure. Twin of ErrorViewFilter for
 * Nest routes; the login redirect and 401 never reach it, requireSession
 * answers those itself.
 */
export function createErrorHandler(logger: WebLogger) {
  return async function handleError(
    error: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const { status, message } = describeError(error);
    if (status >= 500) {
      logger.error(
        `${request.method} ${request.url} -> ${status}`,
        error instanceof Error ? error.stack : String(error),
      );
    } else {
      logger.warn(`${request.method} ${request.url} -> ${status}: ${message}`);
    }

    if (reply.sent) {
      logger.warn(`${request.url}: response already sent, no error page`);
      return;
    }
    // No page context: a static path (the session hook skips those; their
    // routes, /healthz and /manifest.json, answer data), or a failure before
    // the root preValidation hook ran, such as an unparsable body. Data, then.
    // ErrorViewFilter renders a page without app name or session there.
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
