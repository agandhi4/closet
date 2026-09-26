import type { Child } from 'hono/jsx';
import { jsonForScript } from '../html';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { PushSettings } from '../push/settings';
import type { ViewContext } from '../view-context';
import { ErrorAlert, Field, Fieldset, PostForm, SubmitButton } from './form';
import { LOGOUT_PATH } from './logout';
import type {
  ChangePasswordBody,
  FieldErrors,
  RegisterBody,
  UpdateEmailBody,
} from './validation';

/** The pages under /auth. Each takes the page context and what to show. */

function AccountShell(props: {
  ctx: ViewContext;
  ogTitle?: string;
  ogDescription?: string;
  children: Child;
}) {
  return (
    <Layout
      ctx={props.ctx}
      ogTitle={props.ogTitle}
      ogDescription={props.ogDescription}
    >
      <Navbar ctx={props.ctx} />
      <main class="flex flex-col justify-center items-center h-full gap-3">
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
    <AccountShell ctx={ctx} ogTitle={title} ogDescription={description}>
      <WebPageData ctx={ctx} name={title} description={description} />
      <h1 class="text-2xl font-bold mb-4">{title}</h1>
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
    <AccountShell ctx={props.ctx}>
      <h1 class="text-2xl font-bold">
        {t('LOGOUT_PROMPT', { appName: props.ctx.appName })}
      </h1>
      <PostForm action={LOGOUT_PATH}>
        <SubmitButton label={t('LOGOUT')} />
      </PostForm>
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
    <AccountShell ctx={ctx} ogTitle={title} ogDescription={description}>
      <WebPageData ctx={ctx} name={title} description={description} />
      <h1 class="text-2xl font-bold mb-4">{title}</h1>
      <PostForm action="/auth/register">
        <RegisterFields input={props.input} errors={props.errors} />
      </PostForm>
    </AccountShell>
  );
}

export function ProfilePage(props: {
  ctx: ViewContext;
  passwordChanged: boolean;
}) {
  return (
    <AccountShell ctx={props.ctx}>
      {props.passwordChanged && (
        <div role="status" class="alert alert-success">
          <span>{t('PASSWORD_CHANGED')}</span>
        </div>
      )}
      <h1 class="text-2xl">{props.ctx.user?.email}</h1>
      <a class="link" href="/auth/update-email">
        {t('UPDATE_EMAIL')}
      </a>
      <a class="link" href="/auth/change-password">
        {t('CHANGE_PASSWORD')}
      </a>
      <a class="link" href="/wardrobe-share/manage">
        {t('WARDROBE_SHARING')}
      </a>
      <a class="link" href="/auth/delete-account">
        {t('DELETE_ACCOUNT')}
      </a>
      {/* Web Push needs the service worker, which only PWA_ENABLED serves. */}
      {props.ctx.pwaEnabled && <PushSettings />}
    </AccountShell>
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
    <AccountShell ctx={props.ctx}>
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
    <AccountShell ctx={props.ctx}>
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
    <AccountShell ctx={props.ctx}>
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
