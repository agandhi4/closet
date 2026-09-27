import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import { parseIsoDate } from '../calendar/calendar-date';
import { findCapsule } from '../capsules/queries';
import { capsuleNotFound } from '../capsules/validation';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { navigateTo, renderFragment, renderPage } from '../render';
import { DEFAULT_OCCASION } from '../../wardrobe/occasions';
import { IsoDateSchema, OccasionSchema, RowId } from '../schemas';
import { safeReturnTo } from '../security/return-to';
import { viewContext } from '../view-context';
import { orderCategories } from '../wardrobe/garment';
import { cycleRow, newOutfitRows, savedOutfitRows } from './builder';
import { OUTFIT_NAME_MAX, OUTFIT_NOTES_MAX, OutfitFormPage } from './form-page';
import { type OutfitDestination, parseDestination } from './destination';
import { OutfitsPage } from './list-page';
import { OutfitRow } from './outfit-row';
import {
  categoryHeads,
  createOutfit,
  deleteOutfit,
  findOutfit,
  findOutfitFields,
  garmentAt,
  listOutfits,
  type OutfitInput,
  type SaveResult,
  savedSlots,
  updateOutfit,
  wardrobeCategories,
} from './queries';
import { OutfitPage } from './show-page';

/**
 * Validation, decided per route:
 * - The page queries are navigation state and fall back rather than fail:
 *   `?returnTo=` goes through safeReturnTo (same-site paths only, else the
 *   page's default); `?for=day:D&occasion=O` (the calendar's plan page)
 *   through parseDestination, `?scheduleDate=` (links cached before #13)
 *   and `?returnToWeek=` through parseIsoDate (a malformed one is dropped).
 * - The row fragment needs a category (400 without one: there is no row to
 *   render); its `index` is clamped into the category's cycle.
 * - `?capsule=` (a new build from a capsule, and its rows) names data: not
 *   an id is a 400, a capsule that is not the user's own a 404.
 * - The outfit form's post is data the write stores: anything malformed is
 *   a 400 and writes nothing. An empty date input posts '' (no schedule);
 *   no occasion (a form cached before #13) is all day.
 */

const OutfitParams = Type.Object({ id: RowId });

/** Rows in one outfit: position is a smallint, and no builder needs more. */
const MAX_ROWS = 100;

// What a builder row's category may be; the same rule for the fragment.
const Category = Type.String({ minLength: 1, maxLength: 255, pattern: '\\S' });

// A date input left empty posts ''.
const OptionalDay = Type.Union([Type.Literal(''), IsoDateSchema]);

const PageQuery = Type.Object({
  returnTo: Type.Optional(Type.String()),
  for: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
  scheduleDate: Type.Optional(Type.String()),
  returnToWeek: Type.Optional(Type.String()),
});

// A new build from a capsule cycles only its garments (src/web/capsules).
const NewQuery = Type.Object({
  ...PageQuery.properties,
  capsule: Type.Optional(RowId),
});

const RowQuery = Type.Object({
  category: Category,
  index: Type.Optional(Type.Integer()),
  capsule: Type.Optional(RowId),
});

// The form posts one category + garmentId pair per row, in row order (a
// single row arrives as scalars; ajv's coerceTypes: 'array' makes them
// one-element arrays). garmentId '' is a row without a garment. Absent
// fields: an update leaves name and notes as they are; no rows is an empty
// outfit.
const OutfitBody = Type.Object({
  name: Type.Optional(Type.String({ maxLength: OUTFIT_NAME_MAX })),
  notes: Type.Optional(Type.String({ maxLength: OUTFIT_NOTES_MAX })),
  category: Type.Optional(Type.Array(Category, { maxItems: MAX_ROWS })),
  garmentId: Type.Optional(
    Type.Array(Type.Union([Type.Literal(''), RowId]), { maxItems: MAX_ROWS }),
  ),
  scheduleDate: Type.Optional(OptionalDay),
  scheduleOccasion: Type.Optional(OccasionSchema),
  returnTo: Type.Optional(Type.String()),
  returnToWeek: Type.Optional(OptionalDay),
});

type OutfitForm = Static<typeof OutfitBody>;

/** A text field as stored: trimmed, and null when blank; undefined when not posted. */
function textField(value: string | undefined): string | null | undefined {
  return value === undefined ? undefined : value.trim() || null;
}

function outfitInput(body: OutfitForm): OutfitInput {
  const categories = body.category ?? [];
  const garmentIds = body.garmentId ?? [];
  if (categories.length !== garmentIds.length) {
    throw new HttpError(
      400,
      'Each outfit row needs a category and a garment id (empty for none)',
    );
  }
  return {
    name: textField(body.name),
    notes: textField(body.notes),
    slots: categories.map((category, i) => ({
      category,
      garmentId: garmentIds[i] === '' ? null : garmentIds[i],
    })),
    plan: body.scheduleDate
      ? {
          day: body.scheduleDate,
          occasion: body.scheduleOccasion ?? DEFAULT_OCCASION,
        }
      : undefined,
  };
}

/**
 * Where a new build will be planned: `?for=`, else a `?scheduleDate=` from
 * a calendar page cached before #13 (all day).
 */
function newBuildDestination(
  query: Static<typeof PageQuery>,
): OutfitDestination {
  const destination = parseDestination(query);
  if (destination.kind !== 'none') return destination;
  const day = parseIsoDate(query.scheduleDate);
  return day
    ? { kind: 'day', day, occasion: DEFAULT_OCCASION }
    : { kind: 'none' };
}

/** Where a saved form goes: back to the calendar week it came from, else the outfit. */
function afterSave(body: OutfitForm, id: number): string {
  if (body.returnTo === '/calendar') {
    const week = body.returnToWeek || body.scheduleDate;
    return week ? `/calendar?week=${week}` : '/calendar';
  }
  return `/outfits/${id}`;
}

function describeSave(result: SaveResult, plan: OutfitInput['plan']): string {
  const parts = [`${result.slots} row(s)`];
  if (result.refused > 0) {
    parts.push(`${result.refused} garment id(s) not in the wardrobe ignored`);
  }
  if (plan && result.schedule === 'scheduled') {
    parts.push(`scheduled on ${plan.day} (${plan.occasion})`);
  }
  if (plan && result.schedule === 'already-scheduled') {
    parts.push(`already scheduled on ${plan.day}`);
  }
  return parts.join(', ');
}

function outfitNotFound(): HttpError {
  return new HttpError(404, 'Outfit not found');
}

/**
 * /outfits: the list, the detail page, the builder (new and edit) with its
 * row fragment, and the writes. Outfits are the signed-in user's own:
 * wardrobe shares never reach them, `?ownerId=` is ignored, and anyone
 * else's outfit id is a 404 like an unknown one.
 */
export const outfitRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, logger },
  done,
) => {
  app.get('/outfits', async (request, reply) => {
    const outfits = await listOutfits(db, sessionUserId(request));
    return renderPage(
      reply,
      <OutfitsPage ctx={viewContext(reply)} outfits={outfits} />,
    );
  });

  // `?capsule=`: the rows cycle only that capsule's garments. The user's
  // own capsule (outfits are private; a grantee builds from their own).
  app.get(
    '/outfits/new',
    { schema: { querystring: NewQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { returnTo } = request.query;
      const capsule =
        request.query.capsule === undefined
          ? undefined
          : await findCapsule(db, request.query.capsule, ownerId);
      if (request.query.capsule !== undefined && !capsule) {
        throw capsuleNotFound();
      }
      const heads = await categoryHeads(db, ownerId, capsule?.id);
      return renderPage(
        reply,
        <OutfitFormPage
          ctx={viewContext(reply)}
          model={{
            capsule,
            rows: newOutfitRows(heads),
            categories: orderCategories(heads.map((head) => head.category)),
            returnTo: safeReturnTo(returnTo, '/outfits'),
            destination: newBuildDestination(request.query),
          }}
        />,
      );
    },
  );

  // Prev/next, swipes and "Add row": one row, swapped in by htmx. A
  // capsule's cycle needs no lookup: inCapsule matches none of the user's
  // garments for a capsule that is not theirs, so the row is empty.
  app.get(
    '/outfits/row-fragment',
    { schema: { querystring: RowQuery } },
    async (request, reply) => {
      const { category, index, capsule } = request.query;
      const at = await garmentAt(
        db,
        sessionUserId(request),
        category,
        index,
        capsule,
      );
      return renderFragment(
        reply,
        <OutfitRow
          row={cycleRow(category, at.count, at.index, at.garment)}
          capsuleId={capsule}
        />,
      );
    },
  );

  app.get(
    '/outfits/:id',
    { schema: { params: OutfitParams } },
    async (request, reply) => {
      const outfit = await findOutfit(
        db,
        request.params.id,
        sessionUserId(request),
      );
      if (!outfit) throw outfitNotFound();
      return renderPage(
        reply,
        <OutfitPage ctx={viewContext(reply)} outfit={outfit} />,
      );
    },
  );

  app.get(
    '/outfits/:id/edit',
    { schema: { params: OutfitParams, querystring: PageQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const { returnTo, returnToWeek } = request.query;
      const outfit = await findOutfitFields(db, id, ownerId);
      if (!outfit) throw outfitNotFound();
      const [slots, categories] = await Promise.all([
        savedSlots(db, id, ownerId),
        wardrobeCategories(db, ownerId),
      ]);
      // An outfit saved with no rows opens like a new build.
      const rows =
        slots.length > 0
          ? savedOutfitRows(slots)
          : newOutfitRows(await categoryHeads(db, ownerId));
      return renderPage(
        reply,
        <OutfitFormPage
          ctx={viewContext(reply)}
          model={{
            outfit,
            rows,
            categories: orderCategories(categories),
            returnTo: safeReturnTo(returnTo, `/outfits/${id}`),
            returnToWeek: parseIsoDate(returnToWeek),
          }}
        />,
      );
    },
  );

  app.post(
    '/outfits',
    { schema: { body: OutfitBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const input = outfitInput(request.body);
      const result = await createOutfit(db, ownerId, input);
      logger.info(
        `Outfit ${result.id} created by user ${ownerId}: ${describeSave(result, input.plan)}`,
      );
      return reply.redirect(afterSave(request.body, result.id), 302);
    },
  );

  app.post(
    '/outfits/:id',
    { schema: { params: OutfitParams, body: OutfitBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const input = outfitInput(request.body);
      const result = await updateOutfit(db, id, ownerId, input);
      if (result === 'not-found') throw outfitNotFound();
      logger.info(
        `Outfit ${id} updated by user ${ownerId}: ${describeSave(result, input.plan)}`,
      );
      return reply.redirect(afterSave(request.body, id), 302);
    },
  );

  // htmx only (hx-delete, hx-confirm): the page swaps to the list.
  app.delete(
    '/outfits/:id',
    { schema: { params: OutfitParams } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const deleted = await deleteOutfit(db, id, ownerId);
      if (!deleted) throw outfitNotFound();
      logger.info(
        `Outfit ${id} deleted by user ${ownerId} (${deleted.wearsKept} wears kept as day-level wears)`,
      );
      return navigateTo(reply, '/outfits');
    },
  );

  done();
};
