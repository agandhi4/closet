/**
 * The logging the web layer needs. createApp() passes a Nest Logger (context
 * `Web`), which writes through nestjs-pino like the rest of the app; the
 * Fastify instance Nest creates has no logger of its own (`request.log` is a
 * no-op). When Nest goes, a pino child logger satisfies the same shape.
 */
export interface WebLogger {
  debug(message: string): void;
  log(message: string): void;
  warn(message: string): void;
  error(message: string, stack?: string): void;
}
