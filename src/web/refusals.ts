import { HttpError } from './errors';
import { t, type StringKey } from './i18n';

/**
 * The typed refusals a domain function throws when the actor may not have
 * what it asked for (#188; docs/plans/2026-11-12-json-api.md section 4).
 * The policy is access.ts's: what the actor cannot see is NotFound, worded
 * as an unknown id would be, so ids never reveal whose data exists; what
 * they can see but may not change is Forbidden. Pages render either as the
 * error page, an MCP tool answers its message, the API its `code`.
 *
 * Only these spell a 404 or 403 (guards.conf [refusals]): a route or tool
 * that refuses by hand is the duplication #188 removes.
 */

/** One message per resource, so every surface words a refusal the same way. */
const NOT_FOUND_MESSAGE = {
  brand: 'refusal.notFound.brand',
  calendarEntry: 'refusal.notFound.calendarEntry',
  capsule: 'refusal.notFound.capsule',
  garment: 'refusal.notFound.garment',
  outfit: 'refusal.notFound.outfit',
  trip: 'refusal.notFound.trip',
  wardrobe: 'refusal.notFound.wardrobe',
} as const satisfies Record<string, StringKey>;

export type Resource = keyof typeof NOT_FOUND_MESSAGE;

export class NotFound extends HttpError {
  constructor(
    readonly resource: Resource,
    options: { logDetail?: string } = {},
  ) {
    super(404, t(NOT_FOUND_MESSAGE[resource]), options);
    this.name = 'NotFound';
  }
}

export class Forbidden extends HttpError {
  constructor(options: { logDetail?: string } = {}) {
    super(403, t('refusal.FORBIDDEN'), options);
    this.name = 'Forbidden';
  }
}
