import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import { parseIsoDate } from '../calendar/calendar-date';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { IsoDateSchema, RowId } from '../schemas';
import { safeReturnTo } from '../security/return-to';
import { viewContext } from '../view-context';
import {
  cycleRow,
  newOutfitRows,
  orderCategories,
  savedOutfitRows,
} from './builder';
import { OutfitFormPage } from './form-page';
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
 *   page's default); `?scheduleDate=` and `?returnToWeek=` through
 *   parseIsoDate (a malformed one is dropped).
 * - The row fragment needs a category (400 without one: there is no row to
 *   render); its `index` is clamped into the category's cycle.
 * - The outfit form's post is data the write stores: anything malformed is
 *   a 400 and writes nothing. An empty date input posts '' (no schedule).
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
  scheduleDate: Type.Optional(Type.String()),
  returnToWeek: Type.Optional(Type.String()),
});

const RowQuery = Type.Object({
  category: Category,
  index: Type.Optional(Type.Integer()),
});

// The form posts one category + garmentId pair per row, in row order (a
// single row arrives as scalars; ajv's coerceTypes: 'array' makes them
// one-element arrays). garmentId '' is a row without a garment. Absent
// fields: an update leaves name and notes as they are; no rows is an empty
// outfit.
const OutfitBody = Type.Object({
  name: Type.Optional(Type.String({ maxLength: 255 })),
  notes: Type.Optional(Type.String({ maxLength: 255 })),
  category: Type.Optional(Type.Array(Category, { maxItems: MAX_ROWS })),
  garmentId: Type.Optional(
    Type.Array(Type.Union([Type.Literal(''), RowId]), { maxItems: MAX_ROWS }),
  ),
  scheduleDate: Type.Optional(OptionalDay),
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
    scheduleDate: body.scheduleDate || undefined,
  };
}

/** Where a saved form goes: back to the calendar week it came from, else the outfit. */
function afterSave(body: OutfitForm, id: number): string {
  if (body.returnTo === '/calendar') {
    const week = body.returnToWeek || body.scheduleDate;
    return week ? `/calendar?week=${week}` : '/calendar';
  }
  return `/outfits/${id}`;
}

function describeSave(result: SaveResult, day: string | undefined): string {
  const parts = [`${result.slots} row(s)`];
  if (result.refused > 0) {
    parts.push(`${result.refused} garment id(s) not in the wardrobe ignored`);
  }
  if (result.schedule === 'scheduled') parts.push(`scheduled on ${day}`);
  if (result.schedule === 'already-scheduled') {
    parts.push(`already scheduled on ${day}`);
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

  app.get(
    '/outfits/new',
    { schema: { querystring: PageQuery } },
    async (request, reply) => {
      const { returnTo, scheduleDate } = request.query;
      const heads = await categoryHeads(db, sessionUserId(request));
      return renderPage(
        reply,
        <OutfitFormPage
          ctx={viewContext(reply)}
          model={{
            rows: newOutfitRows(heads),
            categories: orderCategories(heads.map((head) => head.category)),
            returnTo: safeReturnTo(returnTo, '/outfits'),
            scheduleDate: parseIsoDate(scheduleDate),
          }}
        />,
      );
    },
  );

  // Prev/next, swipes and "Add row": one row, swapped in by htmx.
  app.get(
    '/outfits/row-fragment',
    { schema: { querystring: RowQuery } },
    async (request, reply) => {
      const { category, index } = request.query;
      const at = await garmentAt(db, sessionUserId(request), category, index);
      return renderFragment(
        reply,
        <OutfitRow row={cycleRow(category, at.count, at.index, at.garment)} />,
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
      logger.log(
        `Outfit ${result.id} created by user ${ownerId}: ${describeSave(result, input.scheduleDate)}`,
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
      logger.log(
        `Outfit ${id} updated by user ${ownerId}: ${describeSave(result, input.scheduleDate)}`,
      );
      return reply.redirect(afterSave(request.body, id), 302);
    },
  );

  // htmx only (hx-delete, hx-confirm): the browser goes back to the list.
  app.delete(
    '/outfits/:id',
    { schema: { params: OutfitParams } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      if (!(await deleteOutfit(db, id, ownerId))) throw outfitNotFound();
      logger.log(`Outfit ${id} deleted by user ${ownerId}`);
      return reply.header('HX-Redirect', '/outfits').status(200).send();
    },
  );

  done();
};
