import { sharedBy } from '../share/share-page';
import type { Child } from 'hono/jsx';
import { PostForm } from '../auth/form';
import type { SharePermission } from '../../db/schema';
import { t, type StringKey } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import type { ViewContext } from '../view-context';
import type { AcceptRefusal, ShareParty, ShareView } from './queries';

/** Views of /wardrobe-share: the manage page, the invite landing, the new-link fragment. */

export const REFUSAL_MESSAGES: Record<AcceptRefusal, StringKey> = {
  'not-found': 'SHARE_ERROR_NOT_FOUND',
  'own-invite': 'SHARE_ERROR_OWN_INVITE',
  'wrong-recipient': 'SHARE_ERROR_WRONG_RECIPIENT',
  'already-shared': 'SHARE_ERROR_ALREADY_SHARED',
};

export function inviteUrl(origin: string, token: string): string {
  return `${origin}/wardrobe-share/invite/${token}`;
}

function permissionLabel(permission: SharePermission): string {
  return t(permission === 'VIEW' ? 'PERMISSION_VIEW' : 'PERMISSION_MANAGE');
}

function PermissionBadge(props: {
  permission: SharePermission;
  class?: string;
}) {
  const tone = props.permission === 'VIEW' ? 'badge-outline' : 'badge-primary';
  return (
    <span class={`badge badge-sm ${tone} ${props.class ?? ''}`.trim()}>
      {permissionLabel(props.permission)}
    </span>
  );
}

/**
 * The invite URL in a read-only input plus a copy button. The URL reaches
 * the script as a data attribute (`@data-invite-url`), never spliced into
 * the hyperscript source.
 */
function CopyableLink(props: {
  url: string;
  size: 'xs' | 'sm';
  label: string;
}) {
  return (
    <div class="flex items-center gap-2">
      <input
        type="text"
        class={`input input-bordered input-${props.size} flex-1`}
        value={props.url}
        readonly
        _="on click call me.select()"
      />
      <button
        type="button"
        class={`btn btn-ghost btn-${props.size}`}
        data-invite-url={props.url}
        _="on click
             call navigator.clipboard.writeText(@data-invite-url)
             then add .btn-success then remove .btn-ghost
             wait 1s
             then remove .btn-success then add .btn-ghost"
      >
        {props.label}
      </button>
    </div>
  );
}

/** The answer to the create-invite form (htmx swaps it into #invite-link-result). */
export function InviteLinkResult(props: { url: string }) {
  return (
    <div class="flex flex-col gap-3" id="invite-link-result">
      <CopyableLink url={props.url} size="sm" label={t('COPY_TEXT')} />
    </div>
  );
}

function PostButton(props: {
  action: string;
  label: string;
  class: string;
  formClass?: string;
}) {
  return (
    <PostForm action={props.action} class={props.formClass ?? 'inline'}>
      <button type="submit" class={props.class}>
        {props.label}
      </button>
    </PostForm>
  );
}

function partyName(party: ShareParty): string {
  return party.email ?? '';
}

function ShareCard(props: { title: string; children: Child }) {
  return (
    <div class="card bg-base-100 shadow-sm mb-6">
      <div class="card-body">
        <h2 class="card-title text-lg">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

export function ManagePage(props: {
  ctx: ViewContext;
  outbound: ShareView[];
  inbound: ShareView[];
  pending: ShareView[];
  /** Origin the invite links are built on (the one this page was requested on). */
  origin: string;
  refusal?: AcceptRefusal;
}) {
  const { ctx, outbound, inbound, pending } = props;
  const empty = !outbound.length && !inbound.length && !pending.length;
  return (
    <Layout ctx={ctx} title={t('WARDROBE_SHARING')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 max-w-2xl mx-auto">
        <h1 class="text-2xl font-bold mb-6">{t('WARDROBE_SHARING')}</h1>

        {props.refusal && (
          <div role="alert" class="alert alert-error mb-4">
            <span>{t(REFUSAL_MESSAGES[props.refusal])}</span>
          </div>
        )}

        <ShareCard title={t('SHARE_WARDROBE')}>
          <p class="text-sm text-base-content/60 mb-4">
            {t('SHARE_WARDROBE_DESC')}
          </p>
          <form
            hx-post="/wardrobe-share/create-invite-link"
            hx-target="#invite-link-result"
            hx-swap="outerHTML"
            class="flex gap-2 items-center"
          >
            <select name="permission" class="select select-bordered select-sm">
              <option value="VIEW">{t('PERMISSION_VIEW')}</option>
              <option value="MANAGE">{t('PERMISSION_MANAGE')}</option>
            </select>
            <button type="submit" class="btn btn-primary btn-sm">
              {t('CREATE_INVITE_LINK')}
            </button>
          </form>
          <div id="invite-link-result"></div>
        </ShareCard>

        {outbound.length > 0 && (
          <ShareCard title={t('YOUR_SHARED_WARDROBES')}>
            <ul class="divide-y divide-base-200">
              {outbound.map((share) => (
                <li class="py-3 flex items-center justify-between">
                  <div class="flex flex-col gap-1">
                    <div class="flex items-center gap-2">
                      <span class="font-medium">
                        {share.grantee
                          ? partyName(share.grantee)
                          : t('PENDING_INVITE')}
                      </span>
                      <PermissionBadge permission={share.permission} />
                      {!share.acceptedAt && (
                        <span class="badge badge-ghost badge-sm">
                          {t('PENDING')}
                        </span>
                      )}
                    </div>
                    {share.inviteToken && (
                      <CopyableLink
                        url={inviteUrl(props.origin, share.inviteToken)}
                        size="xs"
                        label={t('COPY_INVITE_LINK')}
                      />
                    )}
                  </div>
                  <PostButton
                    action={`/wardrobe-share/${share.id}/remove`}
                    label={t('REVOKE')}
                    class="btn btn-ghost btn-xs text-error"
                  />
                </li>
              ))}
            </ul>
          </ShareCard>
        )}

        {pending.length > 0 && (
          <ShareCard title={t('PENDING_INVITES')}>
            <ul class="divide-y divide-base-200">
              {pending.map((share) => (
                <li class="py-3 flex items-center justify-between">
                  <div>
                    <span class="font-medium">{partyName(share.grantor)}</span>
                    <PermissionBadge
                      permission={share.permission}
                      class="ml-2"
                    />
                  </div>
                  {share.inviteToken && (
                    <div class="flex gap-2">
                      <PostButton
                        action={`/wardrobe-share/invite/${share.inviteToken}/accept`}
                        label={t('ACCEPT')}
                        class="btn btn-primary btn-xs"
                      />
                      <PostButton
                        action={`/wardrobe-share/invite/${share.inviteToken}/decline`}
                        label={t('DECLINE')}
                        class="btn btn-ghost btn-xs text-error"
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </ShareCard>
        )}

        {inbound.length > 0 && (
          <ShareCard title={t('SHARED_WITH_YOU')}>
            <ul class="divide-y divide-base-200">
              {inbound.map((share) => (
                <li class="py-3 flex items-center justify-between">
                  <div>
                    <a
                      href={`/wardrobe?ownerId=${share.grantor.id}`}
                      class="font-medium link link-primary"
                    >
                      {partyName(share.grantor)}
                    </a>
                    <PermissionBadge
                      permission={share.permission}
                      class="ml-2"
                    />
                  </div>
                  <PostButton
                    action={`/wardrobe-share/${share.id}/remove`}
                    label={t('LEAVE')}
                    class="btn btn-ghost btn-xs text-error"
                  />
                </li>
              ))}
            </ul>
          </ShareCard>
        )}

        {empty && (
          <div class="text-center text-base-content/40 py-12">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1"
              stroke="currentColor"
              class="size-16 mx-auto mb-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.935-2.185 2.25 2.25 0 0 0-3.935 2.185Z"
              />
            </svg>
            <p>{t('NO_SHARES_YET')}</p>
          </div>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The invite landing page, public: an anonymous recipient sees who invited
 * them and to what before being asked to sign in.
 */
export function InvitePage(props: {
  ctx: ViewContext;
  invite: ShareView | undefined;
  token: string;
}) {
  const { ctx, invite } = props;
  return (
    <Layout ctx={ctx} title={t('WARDROBE_INVITE')}>
      <Navbar ctx={ctx} />
      <main class="flex flex-col justify-center items-center min-h-[80vh] px-4">
        <div class="card bg-base-100 shadow-md w-full max-w-md">
          <div class="card-body">
            {invite ? (
              <InviteDetails invite={invite} token={props.token} ctx={ctx} />
            ) : (
              <>
                <div role="alert" class="alert alert-error mb-4">
                  <span>{t('INVITE_NOT_FOUND')}</span>
                </div>
                <a href="/" class="btn btn-primary btn-sm">
                  {t('RETURN_TO_HOME')}
                </a>
              </>
            )}
          </div>
        </div>
      </main>
    </Layout>
  );
}

function InviteDetails(props: {
  ctx: ViewContext;
  invite: ShareView;
  token: string;
}) {
  const { invite, ctx } = props;
  // Public page (opened before signing in, fetched by link previews): the
  // inviter is named the way /share names an owner, never by email.
  const from = sharedBy(invite.grantor) ?? t('INVITE_FROM_UNKNOWN');
  return (
    <>
      <h1 class="text-2xl font-bold mb-2">{t('WARDROBE_INVITE')}</h1>
      <p class="text-base-content/60 mb-4">
        {t('INVITE_FROM')} <strong>{from}</strong>
      </p>
      <div class="mb-4">
        <div class="flex items-center gap-2 mb-2">
          <PermissionBadge permission={invite.permission} />
        </div>
        <p class="text-sm text-base-content/60">
          {t(
            invite.permission === 'VIEW'
              ? 'INVITE_VIEW_DESC'
              : 'INVITE_MANAGE_DESC',
          )}
        </p>
      </div>
      {ctx.user ? (
        <div class="flex gap-2">
          <PostButton
            action={`/wardrobe-share/invite/${props.token}/accept`}
            label={t('ACCEPT')}
            class="btn btn-primary w-full"
            formClass="flex-1"
          />
          <PostButton
            action={`/wardrobe-share/invite/${props.token}/decline`}
            label={t('DECLINE')}
            class="btn btn-ghost w-full"
            formClass="flex-1"
          />
        </div>
      ) : (
        <div class="flex flex-col gap-2">
          <p class="text-sm text-base-content/60 mb-2">
            {t('INVITE_LOGIN_REQUIRED')}
          </p>
          <a href="/auth/login" class="btn btn-primary">
            {t('LOGIN')}
          </a>
          {!ctx.signupsDisabled && (
            <a href="/auth/register" class="btn btn-outline">
              {t('REGISTER')}
            </a>
          )}
        </div>
      )}
    </>
  );
}
