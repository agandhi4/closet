# JSON API

`/api/v1` (#190; the design is `docs/plans/2026-11-12-json-api.md`) is the native clients' JSON API. It is the third caller of the domain functions pages and MCP already call, never a backend of its own. The PWA never calls it: the server owns its HTML.

- **The surface** (`src/web/surface.ts`): `config.surface` is `page` (the default), `mcp` (`/mcp`) or `api`. The root onRoute hook `assignSurface` (`createApp`, before any route) stamps `api` on every route under `/api/v1`, HEAD twins included. A route that says otherwise, `surface: 'api'` outside it, or any other `/api` path (a `/api/v2`) stops the boot. `surfaceOf(request)` is the one reader. A request no `/api/v1` route matched counts as `api` by its path, in any case (`/api`, `/API/v1/me`; `isApiPath`, `src/web/api-path.ts`, the one rule, which the service worker's `bypassesWorker` reads too), so an unknown API path is a problem 404 that never reads the cookie. That covers the not-found handler and the static files' `GET /*` wildcard, which a GET matches before it falls to not-found. Readers: the root preValidation (no session, no page context), `requireSession`, the same-origin hook and the error handler.
- **The credential**: a `device` token in `Authorization: Bearer` (`createDeviceTokenHook`, `token-auth.ts`; `presentedBearer`, `src/web/auth/bearer.ts`, shared with `/mcp`). The scheme matches in any case. Two headers on the wire (a `rawHeaders` count) or two values folded into one are refused.
  - The cookie is never read on this surface, even one that carries a token.
  - An `mcp` token is the same 401 as an unknown one and records no use (#189).
  - Every refusal is one 401 `unauthorized`, `detail` "Sign in again…", with `WWW-Authenticate: Bearer realm="closet"`. To a client a 401 means one thing: sign in again.
  - A token in the query string is a 400 before anything reads it (`refuseQueryToken`): a key named `access_token` or `token` in any case, or any value holding `closet_`, repeated keys included. The value is never echoed. `loggableUrl` filters credential shapes on every surface (`scrubSecrets`).
  - Authentication happens once, at onRequest (after `refuseQueryToken`), before the body is read: an unauthenticated request is a 401 whatever its body (never a 400 or 413). A token revoked by another request mid-flight finishes that request; the next one is a 401 (the cookie's model).
- **Sign-in and sign-out** (`src/web/auth/api-routes.ts`, plan section 3):
  - `POST /api/v1/auth/token` takes `{ email, password, deviceName }` and answers 201 `{ token, tokenId }`, `Cache-Control: no-store`. It sets no cookie and is public.
    - It shares `checkSignIn` (`src/web/auth/sign-in.ts`) with the login page: `normalizeEmail`, then exactly one bcrypt comparison on every path, the unknown-account hash for an unknown email.
    - It mints through `createToken` with the hash it verified. A password changed (or an account deleted) under the lock is the same 401 "Incorrect email or password" as a wrong password, logged `password-changed`.
    - At the device cap the least recently used device is evicted, never an agent token (per kind, #189). The sign-in line names the evicted row.
  - `DELETE /api/v1/auth/token` revokes the calling token only, 204. It is 204 too when something revoked the token since the request authenticated, logged `(already revoked)`.
  - `GET /api/v1/me` returns `{ id, email, timeZone, today }`: `today` is `todayIn(APP_TIMEZONE)`, the day a wear or wash defaults to. It reads only the token's row.
  - No v1 route changes or hands out a credential behind a token (step-up, Auth). A future one takes `currentPassword` under `ACCOUNT_LIMIT`, and `updatePasswordHash`'s `keep.tokenId` keeps the calling device.
  - Once a token-authenticated route can mint, `createToken` needs an `excludeId`, so a device never evicts itself (decisions 2026-11-13, #189).
- **Limits**:
  - `SIGN_IN_LIMIT` is ONE checker for the login page and this sign-in (`signInLimit`, built in `webPlugin`), so an address gets 5 a minute in all and the 6th is a 429 at either door.
  - `SIGN_IN_ACCOUNT_LIMIT` (5 a minute per SHA-256 of the normalized email) caps guesses spread over addresses: the API door only.
  - `API_LIMIT` allows 120 a minute per token: one checker for the whole API, a preHandler after authentication.
  - A 429 is a problem with `Retry-After`.
- **Errors are RFC 9457 problem+json** (`src/web/problem.ts`'s `Problem`; `problemOf`/`sendProblem` in `errors.tsx`, the one module that may import `node:http`). The body is `{ type: "about:blank", title, status, detail, code, requestId }`, plus `errors: [{ path, message }]` for a schema validation.
  - `code` comes from `HttpError.code`. `NotFound`/`Forbidden` keep the page's message, which names no id.
  - A 500 has no `detail`. An unknown path's detail is "Not Found", never the URL.
  - A 503 `busy` (`OwnerLockTimeout`) carries `Retry-After`, as `HttpError.retryAfterSeconds` sets it.
  - A foreign Origin is a 403 problem (the same-origin hook). A missing Origin passes: no ambient credential rides here.
  - No CORS: no `Access-Control-*` header is ever sent, and a preflight is a problem 404.
- **The spec** (plan section 5):
  - `npm run api:spec` (`scripts/api-spec.ts`, the only importer of the devDependency `@fastify/swagger`) registers `apiPlugin` on a bare Fastify and writes `openapi.json` (OpenAPI 3.1). `info.version` is `v1`, never the sha.
  - `Problem` is one component (`addSchema`, named by its `$id`).
  - `GET /api/v1/openapi.json` (public) serves the committed file, imported, so tsc copies it into `dist/`.
  - `scripts/api-spec.spec.ts` (unit) fails when the committed file is not what the routes generate. It validates the document (`@seriousme/openapi-schema-validator`) and asserts every operation's declarations.
- **Logging** (logger `Api`): sign-ins with user, token row id and address; failures as user N or "an unknown email"; refused credentials with their reason and address; sign-outs. Never the token, the password or the device name. The `Http` access line on `api` and `mcp` carries `user_id` and `token_id` (the row id).
- **Tests**: `t.api(token, request)` (harness: no cookie, no Origin) and `deviceToken`/`signInDevice`/`expectProblem` (`test/integration/api.ts`). `api.spec.ts` covers the surface, the credential and every refusal; `api-statements.spec.ts` pins each route's statements (sign-in 6 like its twin `POST /auth/tokens`, `/me` 1 plus the last-use write, sign-out 3, the spec 0). Each area's API cases join its existing `authorization-<group>.spec.ts` as a third via.

## Adding an API route

1. Write it in `src/web/<feature>/api-routes.ts`, a `FastifyPluginCallbackTypebox<ApiOptions>` registered in `apiPlugin`, calling the same domain function the page calls (parse, call, map). The user is `request.accessToken!.user.id`. A public route says `config: { public: true }` and `schema.security: []`.
2. Declare `operationId` (camelCase, unique), `tags`, a `summary`, the TypeBox `body`/`querystring`/`params`, and `response: apiResponses({ 200: Resource })`. Resource schemas carry `title` and `description`. Fastify serializes through them, so an unlisted column never leaves. `requireContract` refuses the route at boot without them.
3. JSON is camelCase and leaves out nulls. A household day is `YYYY-MM-DD`, an instant ISO 8601 with `Z`, money a decimal string, and lists `{ data, pagination }` (plan section 2).
4. `npm run api:spec` and commit `src/web/api/openapi.json` in the same PR. Pin the route's statements in `api-statements.spec.ts`.

## Gotchas

- **Never pass a plugin's `prefix` on in its options.** Fastify hands a plugin's `prefix` option to every plugin registered with those options, which doubled `/api/v1` on the feature routes. `registerApi` puts the prefix on a scope around `apiPlugin` instead.
- **A `GET` under `/api` that no route matches reaches the static wildcard `GET /*` first**: `request.is404` is false there. That is why `surfaceOf` falls back by path, not by `is404`.
- **Hooks added in `apiPlugin`'s `onRoute` run after the root's**, the rate-limit plugin's included. So `API_LIMIT` is a `createRateLimit` checker in a scope hook, never a stamped `config.rateLimit`, which the plugin would never see.
