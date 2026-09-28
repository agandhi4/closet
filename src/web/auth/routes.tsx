import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LOGIN_PATH } from './login-path';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { requestOrigin } from '../security/origin';
import { ACCOUNT_LIMIT, SIGN_IN_LIMIT } from '../security/rate-limit';
import { viewContext } from '../view-context';
import { parseRefusal } from '../sharing/pages';
import { sharesOf } from '../sharing/queries';
import { SHARE_ERROR_PARAM } from '../sharing/urls';
import { brandSizesOf, findMeasurements } from '../sizes/queries';
import { findWeatherSettings } from '../weather/queries';
import { deleteAccount } from './account';
import { InlineErrors } from './form';
import { LOGOUT_PATH } from './logout';
import { PROFILE_PATH } from './urls';
import {
  ChangePasswordPage,
  DeleteAccountPage,
  LoginPage,
  LogoutPage,
  ProfilePage,
  REGISTER_FIELDS,
  RegisterPage,
  UPDATE_EMAIL_FIELDS,
  UpdateEmailPage,
} from './pages';
import { hashPassword, setPassword, verifyPassword } from './passwords';
import { listTokens } from './personal-tokens';
import {
  findUserByEmail,
  insertUser,
  normalizeEmail,
  updateEmail,
} from './queries';
import { sessionUserId } from './require-session';
import { findWeekTemplate } from '../week-plan/template';
import {
  endSession,
  sessionAccount,
  setSessionCookie,
  startSession,
} from './session';
import {
  ChangePasswordBody,
  DeleteAccountBody,
  type FieldErrors,
  hasErrors,
  LoginBody,
  RegisterBody,
  UpdateEmailBody,
  UpdateEmailFields,
  validateEmailChange,
  validatePasswordChange,
  validateRegistration,
} from './validation';

// Navigation state: one-shot flags and a refusal code, each shown or not;
// no value is a 400.
const ProfileQuery = Type.Object({
  passwordChanged: Type.Optional(Type.String()),
  // The week template's saved toast (#16, src/web/week-plan).
  weekSaved: Type.Optional(Type.String()),
  // Why an invite could not be accepted (Sharing, src/web/sharing).
  [SHARE_ERROR_PARAM]: Type.Optional(Type.String()),
});

/** The sign-in log line's note when it replaced another account's session. */
const replacedNote = (replaced: number | undefined) =>
  replaced === undefined
    ? ''
    : `, replacing user ${replaced}'s session: Clear-Site-Data sent`;

/**
 * /auth: sign in and out, registration, and the account pages (profile,
 * email, password, deletion). Sign-in, registration and logout are public;
 * the account pages need a session like every route. Every form is a native
 * POST (see form.tsx); a refusal re-renders its page with a 4xx.
 */
export const authRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { config, db, tokens, photos, logger, weather },
  done,
) => {
  // DISABLE_REGISTRATION: every registration route sends the visitor to the
  // login page. onRequest, so a closed registration never reads a body.
  const registrationOpen = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (config.registrationDisabled) return reply.redirect(LOGIN_PATH, 302);
  };

  app.get('/auth/login', { config: { public: true } }, async (_req, reply) =>
    renderPage(reply, <LoginPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/login',
    {
      config: { public: true, rateLimit: SIGN_IN_LIMIT },
      schema: { body: LoginBody },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const account = await findUserByEmail(db, normalizeEmail(email));
      // verifyPassword costs the same without an account, so the answer's
      // timing does not tell which addresses exist; the message is one for
      // both cases.
      if (!(await verifyPassword(password, account?.password)) || !account) {
        logger.warn(
          `Failed login for ${account ? `user ${account.id}` : 'an unknown email'}`,
        );
        return renderPage(
          reply,
          <LoginPage ctx={viewContext(reply)} failed={{ email }} />,
          { status: 401 },
        );
      }
      const replaced = startSession(
        request,
        reply,
        account.id,
        tokens.issue(account),
      );
      logger.info(`User ${account.id} signed in${replacedNote(replaced)}`);
      return reply.redirect(PROFILE_PATH, 302);
    },
  );

  // Only a same-origin POST signs out (the same-origin hook refuses any
  // other), so a cross-site link or image cannot. The service worker drops
  // its page cache when this answers with its redirect
  // (views/assets/src-sw.ts). Public: a stale tab signing out again still
  // gets the cookie cleared and lands on the login page.
  app.post(LOGOUT_PATH, { config: { public: true } }, async (req, reply) => {
    if (req.auth) logger.info(`User ${req.auth.user.id} signed out`);
    endSession(reply);
    return reply.redirect(LOGIN_PATH, 303);
  });

  // Pages cached by the installed app before logout became a POST still
  // link here: ask with a one-button form instead of signing out on a GET.
  app.get(LOGOUT_PATH, { config: { public: true } }, async (req, reply) =>
    req.auth
      ? renderPage(reply, <LogoutPage ctx={viewContext(reply)} />)
      : reply.redirect(LOGIN_PATH, 302),
  );

  app.get(
    '/auth/register',
    { config: { public: true }, onRequest: registrationOpen },
    async (_request, reply) =>
      renderPage(reply, <RegisterPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/register',
    {
      config: { public: true, rateLimit: SIGN_IN_LIMIT },
      onRequest: registrationOpen,
      schema: { body: RegisterBody },
    },
    async (request, reply) => {
      const body = request.body;
      const email = normalizeEmail(body.email);
      const refuse = (errors: ReturnType<typeof validateRegistration>) =>
        renderPage(
          reply,
          <RegisterPage
            ctx={viewContext(reply)}
            input={{ email: body.email }}
            errors={errors}
          />,
          { status: 400 },
        );

      const errors = validateRegistration(body);
      if (hasErrors(errors)) return refuse(errors);

      // The insert is the check: no row back means the address is taken,
      // however recently (insertUser). The hash comes first, so a taken
      // address costs what a free one does.
      const account = await insertUser(
        db,
        email,
        await hashPassword(body.password),
      );
      if (!account) {
        logger.info('Registration refused: the email is taken');
        return refuse({ email: [t('EMAIL_IN_USE')] });
      }
      const replaced = startSession(
        request,
        reply,
        account.id,
        tokens.issue(account),
      );
      logger.info(`User ${account.id} registered${replacedNote(replaced)}`);
      return reply.redirect(PROFILE_PATH, 302);
    },
  );

  // Inline validation while the form is filled in: the message slots, swapped
  // out of band. A 200 whatever it finds, since htmx swaps no 4xx.
  app.post(
    '/auth/validate/register',
    {
      config: { public: true },
      onRequest: registrationOpen,
      schema: { body: RegisterBody },
    },
    async (request, reply) =>
      renderFragment(
        reply,
        <InlineErrors
          fields={REGISTER_FIELDS}
          errors={validateRegistration(request.body)}
        />,
      ),
  );

  // Profile: the signed-in user's own settings, whoever asks; no route
  // here reads another user's.
  app.get(
    PROFILE_PATH,
    { schema: { querystring: ProfileQuery } },
    async (request, reply) => {
      const id = sessionUserId(request);
      const { query } = request;
      const [slots, weatherSettings, shares, tokenList, measurements, brands] =
        await Promise.all([
          findWeekTemplate(db, id),
          weather && findWeatherSettings(db, id),
          sharesOf(db, id),
          listTokens(db, id),
          findMeasurements(db, id),
          brandSizesOf(db, id),
        ]);
      return renderPage(
        reply,
        <ProfilePage
          ctx={viewContext(reply)}
          passwordChanged={query.passwordChanged === '1'}
          week={{ slots, saved: query.weekSaved === '1' }}
          weather={
            weatherSettings && {
              settings: weatherSettings,
              timeZone: config.timeZone,
              now: new Date(),
            }
          }
          sharing={{
            ...shares,
            origin: requestOrigin(request),
            refusal: parseRefusal(query[SHARE_ERROR_PARAM]),
          }}
          tokens={tokenList}
          sizes={{ measurements, brands }}
        />,
      );
    },
  );

  app.get('/auth/update-email', async (_request, reply) =>
    renderPage(reply, <UpdateEmailPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/validate/update-email',
    { schema: { body: UpdateEmailFields } },
    async (request, reply) =>
      renderFragment(
        reply,
        <InlineErrors
          fields={UPDATE_EMAIL_FIELDS}
          errors={validateEmailChange(request.body)}
        />,
      ),
  );

  app.post(
    '/auth/update-email',
    {
      config: { rateLimit: ACCOUNT_LIMIT, checksPassword: true },
      schema: { body: UpdateEmailBody },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const body = request.body;
      const email = normalizeEmail(body.email);
      const refuse = (errors: FieldErrors<keyof UpdateEmailBody>) =>
        renderPage(
          reply,
          <UpdateEmailPage
            ctx={viewContext(reply)}
            input={{ email: body.email, confirmEmail: body.confirmEmail }}
            errors={errors}
          />,
          { status: 400 },
        );

      const errors = validateEmailChange(body);
      if (hasErrors(errors)) return refuse(errors);

      // The password before the clash check: whether an address is taken is
      // only answered to someone who proved they own this account.
      const { password } = sessionAccount(request);
      if (!(await verifyPassword(body.currentPassword, password))) {
        logger.info(
          `Email change refused for user ${id}: wrong current password`,
        );
        return refuse({ currentPassword: [t('WRONG_CURRENT_PASSWORD')] });
      }

      // The update is the clash check (updateEmail): false when another
      // account has the address.
      if (!(await updateEmail(db, id, email))) {
        logger.info(`Email change refused for user ${id}: the email is taken`);
        return refuse({ email: [t('EMAIL_IN_USE')] });
      }
      logger.info(`User ${id} changed their email`);
      return reply.redirect(PROFILE_PATH, 302);
    },
  );

  app.get('/auth/change-password', async (_request, reply) =>
    renderPage(reply, <ChangePasswordPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/change-password',
    {
      config: { rateLimit: ACCOUNT_LIMIT, checksPassword: true },
      schema: { body: ChangePasswordBody },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const body = request.body;
      const refuse = (errors: ReturnType<typeof validatePasswordChange>) =>
        renderPage(
          reply,
          <ChangePasswordPage ctx={viewContext(reply)} errors={errors} />,
          { status: 400 },
        );

      const errors = validatePasswordChange(body);
      if (hasErrors(errors)) return refuse(errors);

      const { password } = sessionAccount(request);
      if (!(await verifyPassword(body.currentPassword, password))) {
        logger.info(
          `Password change refused for user ${id}: wrong current password`,
        );
        return refuse({ currentPassword: [t('WRONG_CURRENT_PASSWORD')] });
      }
      // The new hash changes the fingerprint in every token, this session's
      // included: replace this one so the user stays signed in here. Its
      // push subscription, named by the form, stays too.
      const {
        account: updated,
        revokedTokens,
        revokedDevices,
      } = await setPassword(
        db,
        id,
        body.newPassword,
        body.pushEndpoint || undefined,
      );
      setSessionCookie(reply, tokens.issue(updated));
      logger.info(
        `Password changed for user ${id}: other sessions, ${revokedTokens} access tokens and ${revokedDevices} other push devices revoked`,
      );
      return reply.redirect(`${PROFILE_PATH}?passwordChanged=1`, 302);
    },
  );

  app.get('/auth/delete-account', async (_request, reply) =>
    renderPage(reply, <DeleteAccountPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/delete-account',
    {
      config: { rateLimit: ACCOUNT_LIMIT, checksPassword: true },
      schema: { body: DeleteAccountBody },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const account = sessionAccount(request);
      // The credentials must be this account's own, not any account's.
      const passwordMatches = await verifyPassword(
        request.body.password,
        account.password,
      );
      const emailMatches =
        account.email != null &&
        normalizeEmail(account.email) === normalizeEmail(request.body.email);
      if (!passwordMatches || !emailMatches) {
        logger.warn(
          `Account deletion refused for user ${id}: wrong credentials`,
        );
        return renderPage(
          reply,
          <DeleteAccountPage ctx={viewContext(reply)} failed />,
          { status: 401 },
        );
      }

      await deleteAccount({ db, photos, logger }, id);
      endSession(reply);
      return reply.redirect('/', 302);
    },
  );

  done();
};
