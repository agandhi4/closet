/**
 * The login page: where the session gate sends a request without a session
 * (session-access.ts), and what tells the service worker a page request
 * found nobody signed in (sentToLogin, src/web/page-cache.ts). A module of
 * its own, free of Fastify, because the worker's bundle imports it.
 */
export const LOGIN_PATH = '/auth/login';
