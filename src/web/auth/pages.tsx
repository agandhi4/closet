import type { Child } from 'hono/jsx';
import { jsonForScript } from '../html';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { ProfileSection } from '../layout/parts';
import { wardrobeExportPath } from '../page-cache';
import { STYLE_PROFILE_PATH } from '../plans/urls';
import {
  PUSH_SETTINGS_ID,
  PushEndpointField,
  PushSettings,
  PushSignedOut,
} from '../push/settings';
import { SharingSection, type SharingModel } from '../sharing/pages';
import { SHARING_SECTION_ID } from '../sharing/urls';
import type { BodyMeasurements, BrandSize } from '../sizes/queries';
import { SIZES_SECTION_ID } from '../sizes/urls';
import { SizesSection } from '../sizes/views';
import type { ViewContext } from '../view-context';
import type { TemplateSlot } from '../../wardrobe/week';
import type { WeatherSettings as Settings } from '../weather/queries';
import { WEATHER_SETTINGS_ID, WeatherSettings } from '../weather/settings';
import { WEEK_SETTINGS_ID } from '../week-plan/urls';
import { WeekTemplateSettings } from '../week-plan/views';
import { ErrorAlert, Field, Fieldset, PostForm, SubmitButton } from './form';
import { SignOutForm } from './logout';
import type { TokenListing } from './personal-tokens';
import {
  ACCOUNT_SECTION_ID,
  AGENT_ACCESS_SECTION_ID,
  EXPORT_SECTION_ID,
  profileSection,
  SIGN_OUT_SECTION_ID,
  STYLE_SECTION_ID,
  TOKENS_PATH,
} from './urls';
import type {
  ChangePasswordBody,
  FieldErrors,
  RegisterBody,
  UpdateEmailBody,
} from './validation';

/** The pages under /auth. Each takes the page context and what to show. */

/** Where the account's own forms go back to: Profile › Account. */
const ACCOUNT_SECTION_PATH = profileSection(ACCOUNT_SECTION_ID);

/** A one-form page: sign in, register, the account's forms. */
function AccountShell(props: {
  ctx: ViewContext;
  /** The app bar's title, the page's h1. */
  title: string;
  /** The back arrow (the account's forms go back to Profile). */
  back?: string;
  ogTitle?: string;
  ogDescription?: string;
  children: Child;
}) {
  return (
    <Layout
      ctx={props.ctx}
      title={props.title}
      ogTitle={props.ogTitle}
      ogDescription={props.ogDescription}
    >
      <AppBar ctx={props.ctx} title={props.title} back={props.back} />
      {/* Centred while it fits; from the top once it does not, so nothing
          ends up under the fixed app bar, where no scroll reaches it. The
          padding clears the app bar and the dock, as on every other page. */}
      <main class="flex flex-col justify-center-safe items-center min-h-full gap-3 px-4 pt-20 pb-24">
        {props.children}
      </main>
      <Dock ctx={props.ctx} />
    </Layout>
  );
}

/** schema.org description of a public entry page, for link previews. */
function WebPageData(props: {
  ctx: ViewContext;
  name: string;
  description: string;
}) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: props.name,
    description: props.description,
    isPartOf: { '@id': `${props.ctx.siteUrl}/#website` },
  };
  return (
    <script
      type="application/ld+json"
      // Structured data is JSON by definition; jsonForScript keeps it
      // from closing the element.
      dangerouslySetInnerHTML={{ __html: jsonForScript(data) }}
    />
  );
}

export function LoginPage(props: {
  ctx: ViewContext;
  /** A refused sign-in: the address is kept, the password never is. */
  failed?: { email: string };
}) {
  const { ctx } = props;
  const title = t('LOGIN_OG_TITLE', { appName: ctx.appName });
  const description = t('LOGIN_OG_DESC', { appName: ctx.appName });
  return (
    <AccountShell
      ctx={ctx}
      title={title}
      ogTitle={title}
      ogDescription={description}
    >
      <WebPageData ctx={ctx} name={title} description={description} />
      {/* Signed out only: a signed-in visitor opening this page keeps
          their notifications. */}
      {ctx.pwaEnabled && !ctx.user && <PushSignedOut />}
      {props.failed && <ErrorAlert message={t('LOGIN_FAILED')} />}
      <PostForm action="/auth/login">
        <Fieldset legend={t('LOGIN')}>
          <Field
            id="email"
            label={t('EMAIL')}
            type="email"
            autocomplete="username"
            value={props.failed?.email}
          />
          <Field
            id="password"
            label={t('PASSWORD')}
            type="password"
            autocomplete="current-password"
          />
          <SubmitButton label={t('LOGIN')} />
        </Fieldset>
      </PostForm>
    </AccountShell>
  );
}

/** GET /auth/logout: what a signed-in visitor sees behind an old sign-out link. */
export function LogoutPage(props: { ctx: ViewContext }) {
  return (
    <AccountShell ctx={props.ctx} title={t('profile.SIGN_OUT')}>
      <p class="text-lg">
        {t('LOGOUT_PROMPT', { appName: props.ctx.appName })}
      </p>
      <SignOutForm />
    </AccountShell>
  );
}

export interface RegisterFormState {
  /** What was typed: the address only, passwords are never echoed. */
  input?: Pick<Partial<RegisterBody>, 'email'>;
  errors?: FieldErrors<keyof RegisterBody>;
}

export const REGISTER_FIELDS = [
  'email',
  'password',
  'confirmPassword',
] as const;

/** The registration fieldset; POST /auth/validate/register refills its messages. */
function RegisterFields({ input = {}, errors = {} }: RegisterFormState) {
  return (
    <Fieldset legend={t('REGISTER')} validateUrl="/auth/validate/register">
      <Field
        id="email"
        label={t('EMAIL')}
        type="email"
        autocomplete="username"
        value={input.email}
        errors={errors.email}
      />
      <Field
        id="password"
        label={t('PASSWORD')}
        type="password"
        autocomplete="new-password"
        errors={errors.password}
        minlength={8}
      />
      <Field
        id="confirmPassword"
        label={t('CONFIRM_PASSWORD')}
        type="password"
        autocomplete="new-password"
        errors={errors.confirmPassword}
      />
      <SubmitButton label={t('REGISTER')} />
    </Fieldset>
  );
}

export function RegisterPage(props: { ctx: ViewContext } & RegisterFormState) {
  const { ctx } = props;
  const title = t('REGISTER_OG_TITLE', { appName: ctx.appName });
  const description = t('REGISTER_OG_DESC', { appName: ctx.appName });
  return (
    <AccountShell
      ctx={ctx}
      title={title}
      ogTitle={title}
      ogDescription={description}
    >
      <WebPageData ctx={ctx} name={title} description={description} />
      <PostForm action="/auth/register">
        <RegisterFields input={props.input} errors={props.errors} />
      </PostForm>
    </AccountShell>
  );
}

export interface ProfileProps {
  ctx: ViewContext;
  passwordChanged: boolean;
  /** The week template section (#16): the stored slots, and whether it was just saved. */
  week: { slots: readonly TemplateSlot[]; saved: boolean };
  /** The weather section's state; absent with WEATHER_ENABLED=false. */
  weather?: { settings: Settings; timeZone: string; now: Date };
  /** The Sharing section: this user's shares and invites. */
  sharing: SharingModel;
  /** Agent access: the personal access tokens in force. */
  tokens: TokenListing[];
  /** Sizes (#24): the measurements and the brand notes. */
  sizes: { measurements: BodyMeasurements; brands: BrandSize[] };
}

/**
 * Profile, the avatar's page (docs/plans/2026-09-26-redesign.md, "The app
 * bar"): every setting of the signed-in user's own, in sections, in the
 * plan's order. Each section is an anchor that pages and redirects link to
 * (`/auth/profile#weather`); the jump links at the top reach them on a
 * phone. Editors too large for a section keep their own page, linked from
 * it (the style profile, agent access, the account's forms), with a back
 * arrow to their section.
 */
export function ProfilePage(props: ProfileProps) {
  const { ctx } = props;
  // Web Push needs the service worker, which only PWA_ENABLED serves.
  const sections: { id: string; label: string }[] = [
    { id: ACCOUNT_SECTION_ID, label: t('profile.ACCOUNT') },
    { id: SHARING_SECTION_ID, label: t('WARDROBE_SHARING') },
    ...(ctx.pwaEnabled
      ? [{ id: PUSH_SETTINGS_ID, label: t('PUSH_HEADING') }]
      : []),
    ...(props.weather
      ? [{ id: WEATHER_SETTINGS_ID, label: t('weather.SETTINGS_HEADING') }]
      : []),
    { id: WEEK_SETTINGS_ID, label: t('weekPlan.template.HEADING') },
    { id: STYLE_SECTION_ID, label: t('style.TITLE') },
    { id: SIZES_SECTION_ID, label: t('sizes.TITLE') },
    { id: EXPORT_SECTION_ID, label: t('profile.EXPORT') },
    { id: AGENT_ACCESS_SECTION_ID, label: t('agentAccess.TITLE') },
    { id: SIGN_OUT_SECTION_ID, label: t('profile.SIGN_OUT') },
  ];
  return (
    <Layout ctx={ctx} title={t('PROFILE')}>
      <AppBar ctx={ctx} title={t('PROFILE')} />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto flex flex-col gap-4">
        {props.passwordChanged && (
          <div role="status" class="alert alert-success">
            <span>{t('PASSWORD_CHANGED')}</span>
          </div>
        )}
        <nav
          aria-label={t('profile.SECTIONS')}
          class="flex gap-2 overflow-x-auto overscroll-x-contain pb-1"
        >
          {sections.map((section) => (
            <a
              href={`#${section.id}`}
              class="btn btn-sm btn-ghost border-base-300 shrink-0"
            >
              {section.label}
            </a>
          ))}
        </nav>
        <AccountSection ctx={ctx} />
        <SharingSection {...props.sharing} />
        {ctx.pwaEnabled && <PushSettings />}
        {props.weather && <WeatherSettings {...props.weather} />}
        <WeekTemplateSettings {...props.week} />
        <ProfileSection id={STYLE_SECTION_ID} heading={t('style.TITLE')}>
          <p class="text-sm text-muted">{t('profile.STYLE_HINT')}</p>
          <a href={STYLE_PROFILE_PATH} class="btn btn-sm self-start">
            {t('profile.EDIT_STYLE')}
          </a>
        </ProfileSection>
        <SizesSection {...props.sizes} />
        <ExportSection />
        <AgentAccessSection tokens={props.tokens} />
        <ProfileSection
          id={SIGN_OUT_SECTION_ID}
          heading={t('profile.SIGN_OUT')}
        >
          <p class="text-sm text-muted">{t('profile.SIGN_OUT_HINT')}</p>
          <SignOutForm />
        </ProfileSection>
        <a href="/about" class="link link-hover text-sm self-center">
          {t('ABOUT_TITLE')}
        </a>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * Profile › Export (#200): the requester's own wardrobe as a file. Plain
 * downloads: not boosted (htmx would fetch the file as a page) and never
 * the service worker's (bypassesWorker). Each at least 44 px tall (WCAG
 * 2.5.5, the app's touch target): daisyUI's default button is 40 px at this
 * theme's field size, so `min-h-11` lifts it without btn-lg's larger type.
 */
function ExportSection() {
  return (
    <ProfileSection id={EXPORT_SECTION_ID} heading={t('profile.EXPORT')}>
      <p class="text-sm text-muted">{t('profile.EXPORT_HINT')}</p>
      <div class="flex flex-wrap gap-2">
        <a
          href={wardrobeExportPath('csv')}
          download=""
          hx-boost="false"
          class="btn min-h-11 flex-1"
          data-export="csv"
        >
          {t('profile.EXPORT_CSV')}
        </a>
        <a
          href={wardrobeExportPath('json')}
          download=""
          hx-boost="false"
          class="btn min-h-11 flex-1"
          data-export="json"
        >
          {t('profile.EXPORT_JSON')}
        </a>
      </div>
    </ProfileSection>
  );
}

/** Profile › Account: who is signed in, and the account's own forms. */
function AccountSection({ ctx }: { ctx: ViewContext }) {
  return (
    <ProfileSection id={ACCOUNT_SECTION_ID} heading={t('profile.ACCOUNT')}>
      <p class="text-sm break-all">
        {t('profile.SIGNED_IN_AS', { email: ctx.user?.email ?? '' })}
      </p>
      <ul class="menu menu-sm bg-base-100 rounded-box w-full p-1">
        <li>
          <a href="/auth/update-email">{t('UPDATE_EMAIL')}</a>
        </li>
        <li>
          <a href="/auth/change-password">{t('CHANGE_PASSWORD')}</a>
        </li>
        <li>
          <a href="/auth/delete-account" class="text-error">
            {t('DELETE_ACCOUNT')}
          </a>
        </li>
      </ul>
    </ProfileSection>
  );
}

/**
 * Profile › Agent access: the tokens in force by name; creating and
 * revoking stay on their page (TOKENS_PATH), where a new token is shown
 * once in the answer to its password-checked form.
 */
function AgentAccessSection(props: { tokens: TokenListing[] }) {
  return (
    <ProfileSection
      id={AGENT_ACCESS_SECTION_ID}
      heading={t('agentAccess.TITLE')}
    >
      {props.tokens.length === 0 ? (
        <p class="text-sm text-muted">{t('agentAccess.NONE')}</p>
      ) : (
        <ul class="text-sm flex flex-col gap-1">
          {props.tokens.map((token) => (
            <li class="flex items-center gap-2 min-w-0">
              <span class="truncate">{token.name}</span>
              <code class="text-xs text-muted">{token.prefix}…</code>
            </li>
          ))}
        </ul>
      )}
      <a href={TOKENS_PATH} class="btn btn-sm self-start">
        {t('agentAccess.MANAGE')}
      </a>
    </ProfileSection>
  );
}

export interface UpdateEmailFormState {
  /** What was typed: the addresses only, the password is never echoed. */
  input?: Pick<Partial<UpdateEmailBody>, 'email' | 'confirmEmail'>;
  errors?: FieldErrors<keyof UpdateEmailBody>;
}

// The inline check's slots. Not the password's: only the submission checks
// it, and its message stays until the next one.
export const UPDATE_EMAIL_FIELDS = ['email', 'confirmEmail'] as const;

/** The email fieldset; POST /auth/validate/update-email refills its messages. */
function UpdateEmailFields({ input = {}, errors = {} }: UpdateEmailFormState) {
  return (
    <Fieldset
      legend={t('UPDATE_EMAIL')}
      validateUrl="/auth/validate/update-email"
    >
      <Field
        id="email"
        label={t('NEW_EMAIL')}
        type="email"
        autocomplete="username"
        value={input.email}
        errors={errors.email}
      />
      <Field
        id="confirmEmail"
        label={t('CONFIRM_EMAIL')}
        type="email"
        autocomplete="username"
        value={input.confirmEmail}
        errors={errors.confirmEmail}
      />
      <Field
        id="currentPassword"
        label={t('CURRENT_PASSWORD')}
        type="password"
        autocomplete="current-password"
        errors={errors.currentPassword}
      />
      <SubmitButton label={t('UPDATE')} />
    </Fieldset>
  );
}

export function UpdateEmailPage(
  props: { ctx: ViewContext } & UpdateEmailFormState,
) {
  return (
    <AccountShell
      ctx={props.ctx}
      title={t('UPDATE_EMAIL')}
      back={ACCOUNT_SECTION_PATH}
    >
      <PostForm action="/auth/update-email">
        <UpdateEmailFields input={props.input} errors={props.errors} />
      </PostForm>
    </AccountShell>
  );
}

/** Passwords are never echoed back into this page. */
export function ChangePasswordPage(props: {
  ctx: ViewContext;
  errors?: FieldErrors<keyof ChangePasswordBody>;
}) {
  const errors = props.errors ?? {};
  return (
    <AccountShell
      ctx={props.ctx}
      title={t('CHANGE_PASSWORD')}
      back={ACCOUNT_SECTION_PATH}
    >
      <PostForm action="/auth/change-password">
        <Fieldset legend={t('CHANGE_PASSWORD')}>
          {/* Tells password managers which account's password this is. */}
          <input
            type="text"
            name="username"
            autocomplete="username"
            value={props.ctx.user?.email ?? ''}
            class="hidden"
            readonly
          />
          <Field
            id="currentPassword"
            label={t('CURRENT_PASSWORD')}
            type="password"
            autocomplete="current-password"
            errors={errors.currentPassword}
          />
          <Field
            id="newPassword"
            label={t('NEW_PASSWORD')}
            type="password"
            autocomplete="new-password"
            errors={errors.newPassword}
            minlength={8}
          />
          <Field
            id="confirmPassword"
            label={t('CONFIRM_PASSWORD')}
            type="password"
            autocomplete="new-password"
            errors={errors.confirmPassword}
          />
          {/* Keeps this device's notifications through the change; every
              other device's go with its session. */}
          {props.ctx.pwaEnabled && <PushEndpointField />}
          <SubmitButton label={t('CHANGE_PASSWORD')} />
        </Fieldset>
      </PostForm>
    </AccountShell>
  );
}

export function DeleteAccountPage(props: {
  ctx: ViewContext;
  failed?: boolean;
}) {
  return (
    <AccountShell
      ctx={props.ctx}
      title={t('DELETE_ACCOUNT')}
      back={ACCOUNT_SECTION_PATH}
    >
      {props.failed && <ErrorAlert message={t('DELETE_ACCOUNT_FAILED')} />}
      <PostForm
        action="/auth/delete-account"
        confirm={t('DELETE_ACCOUNT_CONFIRMATION')}
      >
        <Fieldset legend={t('DELETE_ACCOUNT')}>
          <Field
            id="email"
            label={t('EMAIL')}
            type="email"
            autocomplete="username"
          />
          <Field
            id="password"
            label={t('PASSWORD')}
            type="password"
            autocomplete="current-password"
          />
          <SubmitButton label={t('DELETE_ACCOUNT')} variant="error" />
        </Fieldset>
      </PostForm>
    </AccountShell>
  );
}
