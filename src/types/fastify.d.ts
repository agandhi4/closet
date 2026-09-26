import type { AuthContext } from '../web/auth/session';
import type { ViewContext } from '../web/view-context';

declare module 'fastify' {
  interface FastifyRequest {
    /** Session resolved once per request by the preValidation hook in app.ts (createSessionResolver, src/web/auth/session.ts). Undefined on static paths and for anonymous requests; requireSession guarantees it on every protected route. Read through sessionUserId(). */
    auth?: AuthContext;
  }

  interface FastifyReply {
    /** Page context built per request by the root preValidation hook (createViewContextBuilder); absent only on static paths. JSX pages read it through viewContext(reply). */
    locals?: ViewContext;
  }
}
