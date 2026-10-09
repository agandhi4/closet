import { todayIn } from '../../calendar-date';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Layout } from '../layout/layout';
import { CopyableText } from '../share/share-button';
import type { ViewContext } from '../view-context';
import { Field, PostForm } from './form';
import { AGENT_ACCESS_SECTION_ID, profileSection } from './urls';
import {
  MAX_ACTIVE_TOKENS,
  TOKEN_NAME_MAX,
  type TokenListing,
} from './personal-tokens';

/**
 * /auth/tokens, the profile's "Agent access" (#33): personal access tokens
 * for the MCP endpoint. A new token is shown once, in the answer to the
 * create form (a native post, never cached), with the command that connects
 * Claude Code; the list shows each token's name and prefix only. The
 * redesign moves this into a Profile section (docs/plans/2026-09-26-redesign.md).
 */

export type TokenNotice = 'revoked' | 'name-required' | 'too-many';

export interface TokensPageProps {
  ctx: ViewContext;
  tokens: TokenListing[];
  /** APP_TIMEZONE: dates are the household's. */
  timeZone: string;
  /** The token just created: its only showing. */
  created?: { name: string; token: string };
  notice?: TokenNotice;
  /** A refused create: the name as typed and the password's message (never the password). */
  form?: { name: string; passwordError?: string };
}

/** The MCP endpoint on the canonical name (SITE_URL), for the connect command. */
export function mcpUrl(siteUrl: string): string {
  return new URL('/mcp', siteUrl).toString();
}

export function connectCommand(siteUrl: string, token: string): string {
  return `claude mcp add --transport http closet ${mcpUrl(siteUrl)} --header "Authorization: Bearer ${token}"`;
}

function TokenAlert({ notice }: { notice: TokenNotice }) {
  if (notice === 'revoked') {
    return (
      <div role="status" class="alert alert-success mb-4">
        <span>{t('agentAccess.REVOKED')}</span>
      </div>
    );
  }
  return (
    <div role="alert" class="alert alert-error mb-4">
      <span>
        {notice === 'too-many'
          ? t('agentAccess.TOO_MANY', { max: MAX_ACTIVE_TOKENS })
          : t('agentAccess.NAME_REQUIRED')}
      </span>
    </div>
  );
}

export function TokensPage(props: TokensPageProps) {
  const { ctx, tokens, created, timeZone } = props;
  const day = (instant: Date) => todayIn(timeZone, instant);
  return (
    <Layout ctx={ctx} title={t('agentAccess.TITLE')}>
      <AppBar
        ctx={ctx}
        title={t('agentAccess.TITLE')}
        back={profileSection(AGENT_ACCESS_SECTION_ID)}
        formPage
      />
      <main class="p-4 pt-20 pb-24 w-full max-w-2xl mx-auto">
        <p class="text-sm text-base-content/70 mb-6">
          {t('agentAccess.INTRO')}
        </p>

        {props.notice && <TokenAlert notice={props.notice} />}

        {created && (
          <div class="card bg-base-100 shadow-sm mb-6" id="new-token">
            <div class="card-body gap-3">
              <h2 class="card-title text-lg">{created.name}</h2>
              <p class="text-sm text-warning">{t('agentAccess.SHOWN_ONCE')}</p>
              <CopyableText
                value={created.token}
                size="sm"
                label={t('agentAccess.COPY')}
              />
              <p class="text-sm">{t('agentAccess.CONNECT')}</p>
              <CopyableText
                value={connectCommand(ctx.siteUrl, created.token)}
                size="xs"
                label={t('agentAccess.COPY')}
              />
            </div>
          </div>
        )}

        <div class="card bg-base-100 shadow-sm mb-6">
          <div class="card-body">
            <h2 class="card-title text-lg">{t('agentAccess.NEW')}</h2>
            <p class="text-sm text-base-content/70">
              {t('agentAccess.PASSWORD_WHY')}
            </p>
            <PostForm action="/auth/tokens" class="flex flex-col gap-2">
              {/* Tells password managers which account's password this is. */}
              <input
                type="text"
                name="username"
                autocomplete="username"
                value={ctx.user?.email ?? ''}
                class="hidden"
                readonly
              />
              <label class="flex flex-col gap-1">
                <span class="text-sm">{t('agentAccess.NAME')}</span>
                <input
                  type="text"
                  name="name"
                  class="input input-bordered input-sm w-full"
                  placeholder={t('agentAccess.NAME_PLACEHOLDER')}
                  value={props.form?.name}
                  maxlength={TOKEN_NAME_MAX}
                  autocomplete="off"
                  required
                />
              </label>
              <Field
                id="currentPassword"
                label={t('CURRENT_PASSWORD')}
                type="password"
                autocomplete="current-password"
                errors={
                  props.form?.passwordError
                    ? [props.form.passwordError]
                    : undefined
                }
              />
              <button type="submit" class="btn btn-primary btn-sm self-start">
                {t('agentAccess.CREATE')}
              </button>
            </PostForm>
          </div>
        </div>

        <div class="card bg-base-100 shadow-sm">
          <div class="card-body">
            <h2 class="card-title text-lg">{t('agentAccess.YOUR_TOKENS')}</h2>
            {tokens.length === 0 ? (
              <p class="text-sm text-muted">{t('agentAccess.NONE')}</p>
            ) : (
              <ul class="divide-y divide-base-200">
                {tokens.map((token) => (
                  <li class="py-3 flex items-center justify-between gap-2">
                    <div class="flex flex-col gap-1 min-w-0">
                      <span class="font-medium truncate">{token.name}</span>
                      <span class="text-xs text-muted">
                        <code>{token.prefix}…</code>{' '}
                        {t('agentAccess.CREATED_ON', {
                          day: day(token.createdAt),
                        })}
                        {' · '}
                        {token.lastUsedAt
                          ? t('agentAccess.LAST_USED', {
                              day: day(token.lastUsedAt),
                            })
                          : t('agentAccess.NEVER_USED')}
                      </span>
                    </div>
                    <PostForm
                      action={`/auth/tokens/${token.id}/revoke`}
                      confirm={t('agentAccess.REVOKE_CONFIRM', {
                        name: token.name,
                      })}
                    >
                      <button
                        type="submit"
                        class="btn btn-ghost btn-xs text-error"
                      >
                        {t('agentAccess.REVOKE')}
                      </button>
                    </PostForm>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </Layout>
  );
}
