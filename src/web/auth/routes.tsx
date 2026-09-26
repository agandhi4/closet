import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LOGIN_PATH } from '../../auth/session-access';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { ACCOUNT_LIMIT, SIGN_IN_LIMIT } from '../security/rate-limit';
import { viewContext } from '../view-context';
import { InlineErrors } from './form';
import {
  ChangePasswordPage,
  DeleteAccountPage,
  LoginPage,
  ProfilePage,
  REGISTER_FIELDS,
  RegisterPage,
  UPDATE_EMAIL_FIELDS,
  UpdateEmailPage,
} from './pages';
import { hashPassword, setPassword, verifyPassword } from './passwords';
import {
  type AccountRow,
  deleteUserAndFileRows,
  findUserByEmail,
  findUserById,
  insertUser,
  isUniqueViolation,
  normalizeEmail,
  updateEmail,
} from './queries';
import { sessionUserId } from './require-session';
import { endSession, setSessionCookie } from './session';
import {
  ChangePasswordBody,
  DeleteAccountBody,
  hasErrors,
  LoginBody,
  RegisterBody,
  UpdateEmailBody,
  validateEmailChange,
  validatePasswordChange,
  validateRegistration,
} from './validation';

const PROFILE_PATH = '/auth/profile';

const ProfileQuery = Type.Object({
  passwordChanged: Type.Optional(Type.String()),
});

/**
 * /auth: sign in and out, registration, and the account pages (profile,
 * email, password, deletion). Sign-in, registration and logout are public;
 * the account pages need a session like every route. Every form is a native
 * POST (see form.tsx); a refusal re-renders its page with a 4xx.
 */
export const authRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { config, db, tokens, photos, logger },
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
      setSessionCookie(reply, tokens.issue(account));
      logger.log(`User ${account.id} signed in`);
      return reply.redirect(PROFILE_PATH, 302);
    },
  );

  // A GET for parity with the navbar's plain link. The service worker drops
  // its page cache on this navigation (views/assets/src-sw.ts).
  app.get('/auth/logout', { config: { public: true } }, async (req, reply) => {
    if (req.auth) logger.log(`User ${req.auth.user.id} signed out`);
    endSession(reply);
    return reply.redirect('/', 302);
  });

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
      if (!hasErrors(errors) && (await findUserByEmail(db, email))) {
        errors.email = [t('EMAIL_IN_USE')];
      }
      if (hasErrors(errors)) return refuse(errors);

      let account: AccountRow;
      try {
        account = await insertUser(
          db,
          email,
          await hashPassword(body.password),
        );
      } catch (error) {
        // Registered by someone else between the check and the insert.
        if (!isUniqueViolation(error)) throw error;
        return refuse({ email: [t('EMAIL_IN_USE')] });
      }
      setSessionCookie(reply, tokens.issue(account));
      logger.log(`User ${account.id} registered`);
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

  app.get(
    PROFILE_PATH,
    { schema: { querystring: ProfileQuery } },
    async (request, reply) =>
      renderPage(
        reply,
        <ProfilePage
          ctx={viewContext(reply)}
          passwordChanged={request.query.passwordChanged === '1'}
        />,
      ),
  );

  app.get('/auth/update-email', async (_request, reply) =>
    renderPage(reply, <UpdateEmailPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/validate/update-email',
    { schema: { body: UpdateEmailBody } },
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
    { schema: { body: UpdateEmailBody } },
    async (request, reply) => {
      const id = sessionUserId(request);
      const body = request.body;
      const email = normalizeEmail(body.email);
      const refuse = (errors: ReturnType<typeof validateEmailChange>) =>
        renderPage(
          reply,
          <UpdateEmailPage
            ctx={viewContext(reply)}
            input={body}
            errors={errors}
          />,
          { status: 400 },
        );

      const errors = validateEmailChange(body);
      if (!hasErrors(errors)) {
        const holder = await findUserByEmail(db, email);
        if (holder && holder.id !== id) errors.email = [t('EMAIL_IN_USE')];
      }
      if (hasErrors(errors)) return refuse(errors);

      try {
        await updateEmail(db, id, email);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return refuse({ email: [t('EMAIL_IN_USE')] });
      }
      logger.log(`User ${id} changed their email`);
      return reply.redirect(PROFILE_PATH, 302);
    },
  );

  app.get('/auth/change-password', async (_request, reply) =>
    renderPage(reply, <ChangePasswordPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/change-password',
    {
      config: { rateLimit: ACCOUNT_LIMIT },
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

      const account = await findUserById(db, id);
      if (!(await verifyPassword(body.currentPassword, account?.password))) {
        logger.log(
          `Password change refused for user ${id}: wrong current password`,
        );
        return refuse({ currentPassword: [t('WRONG_CURRENT_PASSWORD')] });
      }
      // The new hash changes the fingerprint in every token, this session's
      // included: replace this one so the user stays signed in here.
      const updated = await setPassword(db, id, body.newPassword);
      setSessionCookie(reply, tokens.issue(updated));
      logger.log(`Password changed for user ${id}; other sessions revoked`);
      return reply.redirect(`${PROFILE_PATH}?passwordChanged=1`, 302);
    },
  );

  app.get('/auth/delete-account', async (_request, reply) =>
    renderPage(reply, <DeleteAccountPage ctx={viewContext(reply)} />),
  );

  app.post(
    '/auth/delete-account',
    {
      config: { rateLimit: ACCOUNT_LIMIT },
      schema: { body: DeleteAccountBody },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const account = await findUserById(db, id);
      // The credentials must be this account's own, not any account's.
      const passwordMatches = await verifyPassword(
        request.body.password,
        account?.password,
      );
      const emailMatches =
        account?.email != null &&
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

      const fileNames = await deleteUserAndFileRows(db, id);
      // After commit: an unlink cannot be rolled back. A failure leaves
      // bytes the nightly reconciliation removes; the account is gone.
      for (const fileName of fileNames) {
        try {
          await photos.deleteVariants(fileName);
        } catch (error) {
          logger.error(
            `Could not remove photo ${fileName} of deleted user ${id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
      logger.log(`Deleted user ${id} and ${fileNames.length} of their photos`);
      endSession(reply);
      return reply.redirect('/', 302);
    },
  );

  done();
};
