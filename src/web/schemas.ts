import { Type } from '@sinclair/typebox';

/**
 * Request schema pieces more than one feature validates with (TypeBox, see
 * CLAUDE.md, Web layer: Validation).
 */

/**
 * A row id in a path or a form: Postgres serials are 32-bit, so anything
 * larger would fail in the query as a 500 instead of here as a 400.
 */
export const RowId = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });

/**
 * A calendar day, 'YYYY-MM-DD'. `format: 'date'` is ajv-formats' full-date
 * (a real calendar date), the rule parseIsoDate (src/web/calendar/
 * calendar-date.ts) applies to query parameters that fall back instead.
 */
export const IsoDateSchema = Type.String({ format: 'date' });
