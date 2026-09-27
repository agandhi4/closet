import { type Static, Type } from '@sinclair/typebox';
import type { FieldErrors } from '../auth/validation';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { RowId } from '../schemas';
import { OwnerQuery } from '../wardrobe/validation';
import type { CapsuleFields } from './queries';

/**
 * The capsule routes' input. Every route takes `?ownerId=` (OwnerQuery) for
 * a shared wardrobe. The form's fields are data the write stores: past the
 * caps they are a 400 (the inputs carry the same maxlength), and a blank
 * name re-renders the form with its message. The membership posts are ids
 * only; ids outside the wardrobe are dropped by the writer, not refused.
 */

export const CAPSULE_NOT_FOUND = 'Capsule not found';

/**
 * A capsule outside the addressed wardrobe, whether it exists or not: the
 * same 404 as an unknown id (the capsule routes, the grid's `?capsule=` and
 * `?pick=`, Styling's `?capsule=`).
 */
export function capsuleNotFound(): HttpError {
  return new HttpError(404, CAPSULE_NOT_FOUND);
}

export const CAPSULE_NAME_MAX = 80;
export const CAPSULE_NOTES_MAX = 2000;

/** Garment ids one picker post may carry: more than any household holds. */
const MAX_IDS = 2000;

export const CapsuleParams = Type.Object({ id: RowId });

export const CapsuleBody = Type.Object({
  name: Type.String({ maxLength: CAPSULE_NAME_MAX }),
  notes: Type.Optional(Type.String({ maxLength: CAPSULE_NOTES_MAX })),
});
export type CapsuleBody = Static<typeof CapsuleBody>;

export type CapsuleField = 'name';

export type CapsuleForm =
  | { ok: true; fields: CapsuleFields }
  | { ok: false; values: CapsuleBody; errors: FieldErrors<CapsuleField> };

/** The form again after the owner's other capsule turned out to hold the name. */
export function nameTaken(values: CapsuleBody): CapsuleForm & { ok: false } {
  return {
    ok: false,
    values,
    errors: { name: [t('validation.CAPSULE_NAME_TAKEN')] },
  };
}

/** The form as stored: trimmed, blank notes null; a blank name is refused. */
export function readCapsuleForm(body: CapsuleBody): CapsuleForm {
  const name = body.name.trim();
  if (!name) {
    return {
      ok: false,
      values: body,
      errors: { name: [t('validation.CAPSULE_NAME_REQUIRED')] },
    };
  }
  return { ok: true, fields: { name, notes: body.notes?.trim() || null } };
}

/** The capsule page's one-shot flags: after the picker saved, and after a create. */
export const CapsulePageQuery = Type.Object({
  ...OwnerQuery.properties,
  created: Type.Optional(Type.String({ maxLength: 5 })),
  added: Type.Optional(Type.Integer({ minimum: 0 })),
  removed: Type.Optional(Type.Integer({ minimum: 0 })),
});

/**
 * POST /capsules/:id/garments, the picker: `ids` are the checked tiles and
 * `shown` every tile the picker rendered (a hidden input per tile). Tiles
 * shown and unchecked leave the capsule, checked ones join it, and members
 * the picker never showed (pages not scrolled to, archived garments,
 * filtered out) stay as they are. Nothing checked posts no `ids`.
 */
export const MembersBody = Type.Union([
  Type.Object({
    ids: Type.Optional(Type.Array(RowId, { maxItems: MAX_IDS })),
    shown: Type.Optional(Type.Array(RowId, { maxItems: MAX_IDS })),
  }),
  Type.Null(),
]);

/**
 * POST /wardrobe/:id/capsules, the garment page's capsules row: the same
 * rule from the garment's side, `capsuleIds` checked and `shown` every
 * capsule the toggles listed (one created meanwhile elsewhere is left
 * alone).
 */
export const GarmentCapsulesBody = Type.Union([
  Type.Object({
    capsuleIds: Type.Optional(Type.Array(RowId, { maxItems: MAX_IDS })),
    shown: Type.Optional(Type.Array(RowId, { maxItems: MAX_IDS })),
  }),
  Type.Null(),
]);

/** The ids that were shown and are not checked: what leaves. */
export function unchecked(
  shown: number[] | undefined,
  checked: number[] | undefined,
): number[] {
  const kept = new Set(checked);
  return (shown ?? []).filter((id) => !kept.has(id));
}
