import type { Child } from 'hono/jsx';
import type { SharePermission } from '../../db/schema';
import { PostForm } from '../auth/form';
import { t, type StringKey } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Layout } from '../layout/layout';
import { ProfileSection } from '../layout/parts';
import { CopyableText } from '../share/share-button';
import { sharedBy } from '../share/share-page';
import type { ViewContext } from '../view-context';
import type { AcceptRefusal, ShareParty, ShareView } from './queries';
import { SHARING_SECTION_ID } from './urls';

/** Views of sharing: Profile's Sharing section, the invite landing, the new-link fragment. */

export const REFUSAL_MESSAGES: Record<AcceptRefusal, StringKey> = {
  'not-found': 'SHARE_ERROR_NOT_FOUND',
  'own-invite': 'SHARE_ERROR_OWN_INVITE',
  'wrong-recipient': 'SHARE_ERROR_WRONG_RECIPIENT',
  'already-shared': 'SHARE_ERROR_ALREADY_SHARED',
};

/** A refusal code from a URL; anything else is none (navigation state, never a 400). */
export function parseRefusal(
  value: string | undefined,
): AcceptRefusal | undefined {
  return value !== undefined && Object.hasOwn(REFUSAL_MESSAGES, value)
    ? (value as AcceptRefusal)
    : undefined;
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin}/wardrobe-share/invite/${token}`;
}

function permissionLabel(permission: SharePermission): string {
  return t(permission === 'VIEW' ? 'PERMISSION_VIEW' : 'PERMISSION_MANAGE');
}

export function PermissionBadge(props: {
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

/** The answer to the create-invite form (htmx swaps it into #invite-link-result). */
export function InviteLinkResult(props: { url: string }) {
  return (
    <div class="flex flex-col gap-3" id="invite-link-result">
      <CopyableText value={props.url} size="sm" label={t('COPY_TEXT')} />
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

/** A list within the Sharing section: outbound, pending or inbound shares. */
function ShareList(props: { title: string; children: Child }) {
  return (
    <div class="flex flex-col">
      <h3 class="font-semibold text-sm">{props.title}</h3>
      <ul class="divide-y divide-base-300">{props.children}</ul>
    </div>
  );
}

export interface SharingModel {
  outbound: ShareView[];
  inbound: ShareView[];
  pending: ShareView[];
  /** Origin the invite links are built on (the one this page was requested on). */
  origin: string;
  /** Why an invite could not be accepted, from the accept's redirect. */
  refusal?: AcceptRefusal;
}

/**
 * Profile › Sharing (the manage page until #82): invite links, the
 * wardrobes this user shares and the ones shared with them, and invites
 * waiting for an answer. Every write posts to /wardrobe-share/* and lands
 * back here (SHARING_PATH).
 */
export function SharingSection(props: SharingModel) {
  const { outbound, inbound, pending } = props;
  const empty = !outbound.length && !inbound.length && !pending.length;
  return (
    <ProfileSection id={SHARING_SECTION_ID} heading={t('WARDROBE_SHARING')}>
      {props.refusal && (
        <div role="alert" class="alert alert-error">
          <span>{t(REFUSAL_MESSAGES[props.refusal])}</span>
        </div>
      )}

      <p class="text-sm text-base-content/70">{t('SHARE_WARDROBE_DESC')}</p>
      <form
        hx-post="/wardrobe-share/create-invite-link"
        hx-target="#invite-link-result"
        hx-swap="outerHTML"
        class="flex gap-2 items-center"
      >
        <select
          name="permission"
          class="select select-bordered select-sm"
          aria-label={t('SHARE_WARDROBE')}
        >
          <option value="VIEW">{t('PERMISSION_VIEW')}</option>
          <option value="MANAGE">{t('PERMISSION_MANAGE')}</option>
        </select>
        <button type="submit" class="btn btn-primary btn-sm">
          {t('CREATE_INVITE_LINK')}
        </button>
      </form>
      <div id="invite-link-result"></div>

      {outbound.length > 0 && (
        <ShareList title={t('YOUR_SHARED_WARDROBES')}>
          {outbound.map((share) => (
            <li class="py-3 flex items-center justify-between gap-2">
              <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium break-all">
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
                  <CopyableText
                    value={inviteUrl(props.origin, share.inviteToken)}
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
        </ShareList>
      )}

      {pending.length > 0 && (
        <ShareList title={t('PENDING_INVITES')}>
          {pending.map((share) => (
            <li class="py-3 flex items-center justify-between gap-2">
              <div class="min-w-0">
                <span class="font-medium break-all">
                  {partyName(share.grantor)}
                </span>
                <PermissionBadge permission={share.permission} class="ml-2" />
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
        </ShareList>
      )}

      {inbound.length > 0 && (
        <ShareList title={t('SHARED_WITH_YOU')}>
          {inbound.map((share) => (
            <li class="py-3 flex items-center justify-between gap-2">
              <div class="min-w-0">
                <a
                  href={`/wardrobe?ownerId=${share.grantor.id}`}
                  class="font-medium link link-primary break-all"
                >
                  {partyName(share.grantor)}
                </a>
                <PermissionBadge permission={share.permission} class="ml-2" />
              </div>
              <PostButton
                action={`/wardrobe-share/${share.id}/remove`}
                label={t('LEAVE')}
                class="btn btn-ghost btn-xs text-error"
              />
            </li>
          ))}
        </ShareList>
      )}

      {empty && <p class="text-sm text-muted">{t('NO_SHARES_YET')}</p>}
    </ProfileSection>
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
      <AppBar ctx={ctx} title={t('WARDROBE_INVITE')} />
      <main class="flex flex-col justify-center items-center min-h-[80vh] px-4 pt-20">
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
      <p class="text-muted mb-4">
        {t('INVITE_FROM')} <strong>{from}</strong>
      </p>
      <div class="mb-4">
        <div class="flex items-center gap-2 mb-2">
          <PermissionBadge permission={invite.permission} />
        </div>
        <p class="text-sm text-muted">
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
          <p class="text-sm text-muted mb-2">{t('INVITE_LOGIN_REQUIRED')}</p>
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
