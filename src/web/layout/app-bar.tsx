import type { Child } from 'hono/jsx';
import { LOGIN_PATH } from '../auth/login-path';
import { PROFILE_PATH } from '../auth/urls';
import { t } from '../i18n';
import type { ViewContext } from '../view-context';
import { BackLink } from './parts';

export interface AppBarProps {
  ctx: ViewContext;
  /** The page's heading, its one h1. Short: the bar truncates it. */
  title: Child;
  /**
   * The title as a menu: its items (`<li>`s), opened by tapping the title
   * (the Wardrobe's switcher between the wardrobes shared with the user).
   */
  titleMenu?: Child;
  /** The back arrow's target; absent on a section's root page. */
  back?: string;
  /** Beside the title: what the page is scoped to (a wardrobe, a capsule). */
  scope?: Child;
  /** At most two of the page's own actions, before the avatar. */
  actions?: Child;
}

/**
 * The app bar every page renders (docs/plans/2026-09-26-redesign.md, "The
 * app bar"): the page's own header, with its title, scope and actions, the
 * request spinner and the cached copy's age, and the avatar that opens
 * Profile. There is no drawer and no menu: everything the account needs is
 * on Profile.
 *
 * Rendered into the body like the dock, so a boosted navigation, a history
 * restore and a cached tab root all carry the bar of the page they show.
 * The tab roots are stale-while-revalidate (page-cache.ts), so nothing here
 * may vary between two renders of the same page. Its position and z-index
 * (above page content, beside the dock) are in main.css. It is 4rem
 * tall: a page leaves `pt-20` (the bar and the page's 1rem gutter), or
 * `pt-16` when its first row sits flush under it (the Wardrobe tabs).
 */
export function AppBar(props: AppBarProps) {
  const { ctx } = props;
  return (
    <header class="app-bar flex items-center gap-1 px-2 bg-base-100 border-b border-base-300">
      {props.back && <BackLink href={props.back} />}
      <div class="flex flex-col flex-1 min-w-0 px-1">
        <div class="flex items-center gap-2 min-w-0">
          {props.titleMenu ? (
            <TitleMenu title={props.title}>{props.titleMenu}</TitleMenu>
          ) : (
            <h1 class="text-xl font-semibold truncate">{props.title}</h1>
          )}
          {/* In-flight htmx request spinner: every request's indicator (the
              body's hx-indicator, layout.tsx). Connectivity is a separate
              concern: AppStatus. */}
          <div id="request-indicator" class="relative size-5 shrink-0">
            <span
              id="loading"
              class="htmx-indicator loading loading-ring loading-sm absolute inset-0"
            ></span>
          </div>
        </div>
        {/* "Updated 3 minutes ago" while the page on screen is a cached copy
            a minute old or more (public/js/freshness.js); under the title,
            so it never covers or moves the content. */}
        <span id="freshness" class="hidden truncate text-xs text-muted"></span>
      </div>
      {props.scope && (
        <div class="flex items-center shrink-0">{props.scope}</div>
      )}
      {props.actions && (
        <div class="flex items-center gap-1 shrink-0">{props.actions}</div>
      )}
      <Account ctx={ctx} />
    </header>
  );
}

/**
 * The title that opens a menu: the h1 inside the summary (a summary may
 * hold one heading), so the page keeps its one h1 and the tap target is
 * the title itself. The menu draws over the content from inside the bar.
 */
function TitleMenu(props: { title: Child; children: Child }) {
  return (
    <details class="dropdown min-w-0" id="title-menu">
      <summary class="btn btn-ghost btn-sm px-1 gap-1 flex-nowrap max-w-full">
        <h1 class="text-xl font-semibold truncate">{props.title}</h1>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="2"
          stroke="currentColor"
          class="size-4 shrink-0"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="m19.5 8.25-7.5 7.5-7.5-7.5"
          />
        </svg>
      </summary>
      <ul class="dropdown-content menu bg-base-100 rounded-box border border-base-300 z-20 w-64 mt-2 p-2">
        {props.children}
      </ul>
    </details>
  );
}

/**
 * Signed in, the avatar: the email's initial, opening Profile. Signed out,
 * the way in: "Login", or "Register" on the login page itself (while
 * registration is open), so both of the old drawer's links stay reachable.
 */
function Account({ ctx }: { ctx: ViewContext }) {
  if (ctx.user) {
    const onProfile =
      ctx.path === PROFILE_PATH || ctx.path.startsWith(`${PROFILE_PATH}/`);
    return (
      <a
        href={PROFILE_PATH}
        id="avatar"
        class="btn btn-ghost btn-circle shrink-0"
        aria-label={t('PROFILE')}
        aria-current={onProfile ? 'page' : undefined}
      >
        {/* daisyUI centres the placeholder's child div. */}
        <div class="avatar avatar-placeholder">
          <div
            class={`size-9 rounded-full ${onProfile ? 'bg-primary text-primary-content' : 'bg-base-300 text-base-content'}`}
          >
            <span class="text-base font-semibold" aria-hidden="true">
              {ctx.user.email ? initial(ctx.user.email) : <PersonIcon />}
            </span>
          </div>
        </div>
      </a>
    );
  }
  if (ctx.path === LOGIN_PATH) {
    return ctx.signupsDisabled ? null : (
      <a href="/auth/register" class="btn btn-ghost btn-sm shrink-0">
        {t('REGISTER')}
      </a>
    );
  }
  return (
    <a href={LOGIN_PATH} class="btn btn-ghost btn-sm shrink-0">
      {t('LOGIN')}
    </a>
  );
}

/** The avatar's letter: the address's first character, upper case. */
function initial(email: string): string {
  return email.charAt(0).toLocaleUpperCase('en');
}

/** The avatar of an account without an email (`user.email` is nullable). */
function PersonIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class="size-5"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"
      />
    </svg>
  );
}
