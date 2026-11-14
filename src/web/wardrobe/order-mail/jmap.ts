import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  type OutboundFetcher,
  OutboundFetchError,
  type OutboundFetchRefusal,
} from '../../security/outbound-fetch';
import type { OrderEmailFailureScope } from '../../../wardrobe/order-items';
import type { BodyPart } from './links';

/**
 * The order mail's JMAP client (#25; RFC 8620 core, RFC 8621 mail; plan
 * docs/plans/2026-09-28-order-email-import.md, JMAP calls): Fastmail's API,
 * read with the owner's read-only token. Every request goes through the
 * outbound fetcher with `hosts` set to the session URL's host, so the token
 * (sent as `Authorization`) reaches that host and nothing else: a redirect
 * is refused, and an `apiUrl` on another host is `host-not-allowed`.
 *
 * Three steps a poll: the session (the API's URL and the mail account),
 * the inbox's email ids since a watermark (one request, two calls joined
 * by a back-reference), then the emails: their senders first, and bodies
 * only for the ones the trust check admits.
 *
 * The token never leaves this module but in that header: failures are
 * JmapErrors that name the step and the fetcher's reason, never a header
 * or a body, and the fetcher logs hosts only.
 */

/** Production's session resource. The specs pass their stand-in's. */
const FASTMAIL_SESSION_URL = 'https://api.fastmail.com/jmap/session';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';

/** How many inbox ids one poll asks for; the processed ones are then dropped. */
const QUERY_LIMIT = 50;
/**
 * Each body part's value is cut here by the server (`isTruncated`): the
 * size cap of one email. Order confirmations run 50 to 150 KB of HTML; the
 * fetcher's 512 KB cap on a JSON answer leaves room for escaping.
 */
const MAX_BODY_VALUE_BYTES = 200_000;

interface JmapErrorDetails {
  /** The fetcher's refusal, when the request itself was refused. */
  refusal?: OutboundFetchRefusal;
  /** The answer's HTTP status, when the refusal was one. */
  status?: number;
  scope?: OrderEmailFailureScope;
}

/**
 * A JMAP failure: the step and why, never the token or a body. `scope` is
 * `outage` but for one email's own body fetch (#693, #932): a 4xx for that
 * id is the `email`'s, a 5xx or a wrong-shaped answer is the `message`'s
 * (bodyFailureScope); see OrderEmailFailureScope.
 */
export class JmapError extends Error {
  readonly refusal: OutboundFetchRefusal | undefined;
  readonly status: number | undefined;
  readonly scope: OrderEmailFailureScope;

  constructor(message: string, details: JmapErrorDetails = {}) {
    super(message);
    this.name = 'JmapError';
    this.refusal = details.refusal;
    this.status = details.status;
    this.scope = details.scope ?? 'outage';
  }
}

/** Statuses about the token, the account or the server's load, never one email. */
const MAILBOX_STATUSES = new Set([401, 403, 408, 429]);

/**
 * Whose failure one email's body request was. A 4xx for that id is the
 * email's; a 5xx is the message's (a strike); everything else is the
 * outage's: the transport, 401/403/408/429 (the token, the account or the
 * server's load), a method error (serverUnavailable, serverFail,
 * forbidden: RFC 8620 names the server's state, not one email's) and an
 * answer that is not JSON (a maintenance page). The session, the query and
 * the envelopes are never one email's.
 */
function bodyFailureScope(error: JmapError): OrderEmailFailureScope {
  const { status } = error;
  if (status === undefined) return 'outage';
  if (status >= 500) return 'message';
  return status >= 400 && !MAILBOX_STATUSES.has(status) ? 'email' : 'outage';
}

/** What the trust check reads of an email, and when it arrived. */
export interface EmailEnvelope {
  id: string;
  receivedAt: Date;
  from: { email: string | null }[] | null;
  /** Topmost first. */
  authenticationResults: string[];
}

type EmailBody =
  | { kind: 'parts'; parts: BodyPart[] }
  /** Gone between the query and the get. */
  | { kind: 'gone' }
  /** Its answer passed the fetcher's cap for JSON. */
  | { kind: 'too-large' };

/** One poll's view of the account. */
export interface JmapMailbox {
  accountId: string;
  /** The inbox's email ids received at or after `since` (all when undefined), oldest first. */
  inboxIds(since: Date | undefined): Promise<string[]>;
  /** The envelopes of `ids` (those that still exist). */
  envelopes(ids: readonly string[]): Promise<EmailEnvelope[]>;
  /** One email's body parts, HTML where it has one, else its text. */
  body(id: string): Promise<EmailBody>;
}

export interface JmapClient {
  /** Discovers the session: the API's URL and the mail account. */
  open(): Promise<JmapMailbox>;
}

export interface JmapClientOptions {
  fetcher: OutboundFetcher;
  token: string;
  sessionUrl?: string;
}

const Session = Type.Object({
  apiUrl: Type.String(),
  primaryAccounts: Type.Record(Type.String(), Type.String()),
});

const Invocation = Type.Tuple([Type.String(), Type.Unknown(), Type.String()]);
const ApiResponse = Type.Object({
  methodResponses: Type.Array(Invocation),
});

const IdsAnswer = Type.Object({ ids: Type.Array(Type.String()) });

const AUTH_RESULTS = 'header:Authentication-Results:asText:all';
const EnvelopeAnswer = Type.Object({
  list: Type.Array(
    Type.Object({
      id: Type.String(),
      receivedAt: Type.String(),
      from: Type.Union([
        Type.Array(
          Type.Object({ email: Type.Union([Type.String(), Type.Null()]) }),
        ),
        Type.Null(),
      ]),
      [AUTH_RESULTS]: Type.Array(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
});

const BodyAnswer = Type.Object({
  list: Type.Array(
    Type.Object({
      id: Type.String(),
      htmlBody: Type.Array(
        Type.Object({
          partId: Type.Union([Type.String(), Type.Null()]),
          type: Type.String(),
        }),
      ),
      bodyValues: Type.Record(
        Type.String(),
        Type.Object({ value: Type.String() }),
      ),
    }),
  ),
});

export function createJmapClient({
  fetcher,
  token,
  sessionUrl = FASTMAIL_SESSION_URL,
}: JmapClientOptions): JmapClient {
  const hosts = [new URL(sessionUrl).hostname];
  const authorization = `Bearer ${token}`;

  async function fetchJson(
    step: string,
    url: string,
    json?: unknown,
  ): Promise<unknown> {
    try {
      const { body } = await fetcher.fetch(url, {
        accept: ['json'],
        hosts,
        authorization,
        json,
      });
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof OutboundFetchError) {
        throw new JmapError(
          `JMAP ${step} refused (${error.reason}${error.status ? ` ${error.status}` : ''})`,
          { refusal: error.reason, status: error.status },
        );
      }
      if (error instanceof SyntaxError) {
        throw new JmapError(`JMAP ${step} answered something not JSON`);
      }
      throw error;
    }
  }

  return {
    async open() {
      const session = checked(
        'session',
        Session,
        await fetchJson('session', sessionUrl),
      );
      const accountId = session.primaryAccounts[MAIL];
      if (!accountId) {
        throw new JmapError('JMAP session has no mail account');
      }
      const apiUrl = new URL(session.apiUrl, sessionUrl).href;

      async function call(
        step: string,
        methodCalls: [string, Record<string, unknown>, string][],
      ): Promise<Map<string, unknown>> {
        const answer = checked(
          step,
          ApiResponse,
          await fetchJson(step, apiUrl, { using: [CORE, MAIL], methodCalls }),
        );
        const byTag = new Map<string, unknown>();
        for (const [name, args, tag] of answer.methodResponses) {
          if (name === 'error') {
            const type = (args as { type?: unknown } | null)?.type;
            throw new JmapError(
              `JMAP ${step} failed: ${typeof type === 'string' ? type : 'error'}`,
            );
          }
          byTag.set(tag, args);
        }
        return byTag;
      }

      return {
        accountId,
        async inboxIds(since) {
          // Two requests: a result reference replaces a whole argument, and
          // the inbox's id sits inside Email/query's filter.
          const mailboxes = await call('inbox', [
            [
              'Mailbox/query',
              { accountId, filter: { role: 'inbox' } },
              'inbox',
            ],
          ]);
          const [inbox] = checked(
            'inbox',
            IdsAnswer,
            mailboxes.get('inbox'),
          ).ids;
          if (!inbox) throw new JmapError('JMAP account has no inbox');
          const emails = await call('query', [
            [
              'Email/query',
              {
                accountId,
                filter: {
                  inMailbox: inbox,
                  // Inclusive (RFC 8621): the email at the watermark is
                  // queried again, and dropped as processed.
                  ...(since && { after: utcDate(since) }),
                },
                sort: [{ property: 'receivedAt', isAscending: true }],
                collapseThreads: false,
                limit: QUERY_LIMIT,
              },
              'emails',
            ],
          ]);
          return checked('query', IdsAnswer, emails.get('emails')).ids;
        },
        async envelopes(ids) {
          if (ids.length === 0) return [];
          const answers = await call('envelopes', [
            [
              'Email/get',
              {
                accountId,
                ids,
                properties: ['id', 'receivedAt', 'from', AUTH_RESULTS],
              },
              'envelopes',
            ],
          ]);
          return checked(
            'envelopes',
            EnvelopeAnswer,
            answers.get('envelopes'),
          ).list.map((email) => ({
            id: email.id,
            receivedAt: receivedAt(email.receivedAt),
            from: email.from,
            authenticationResults: email[AUTH_RESULTS].filter(
              (value): value is string => value !== null,
            ),
          }));
        },
        async body(id) {
          let answers: Map<string, unknown>;
          try {
            answers = await call('body', [
              [
                'Email/get',
                {
                  accountId,
                  ids: [id],
                  properties: ['id', 'htmlBody', 'bodyValues'],
                  bodyProperties: ['partId', 'type'],
                  fetchHTMLBodyValues: true,
                  maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
                },
                'body',
              ],
            ]);
          } catch (error) {
            if (!(error instanceof JmapError)) throw error;
            if (error.refusal === 'too-large') return { kind: 'too-large' };
            throw new JmapError(error.message, {
              refusal: error.refusal,
              status: error.status,
              scope: bodyFailureScope(error),
            });
          }
          const [email] = checked(
            'body',
            BodyAnswer,
            answers.get('body'),
            'message',
          ).list;
          if (!email) return { kind: 'gone' };
          const parts = email.htmlBody.flatMap(({ partId, type }) => {
            const value =
              partId === null ? undefined : email.bodyValues[partId];
            return value
              ? [{ type: type.toLowerCase(), value: value.value }]
              : [];
          });
          return { kind: 'parts', parts };
        },
      };
    },
  };
}

function checked<S extends TSchema>(
  step: string,
  schema: S,
  value: unknown,
  scope: OrderEmailFailureScope = 'outage',
): Static<S> {
  if (!Value.Check(schema, value)) {
    throw new JmapError(`JMAP ${step} answered an unexpected shape`, {
      scope,
    });
  }
  return value;
}

function receivedAt(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new JmapError('JMAP envelopes answered an unreadable receivedAt');
  }
  return date;
}

/** RFC 8620's UTCDate: a zero fraction of a second must be left out. */
function utcDate(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, 'Z');
}
