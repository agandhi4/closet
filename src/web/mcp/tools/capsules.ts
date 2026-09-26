import * as z from 'zod/v4';
import {
  changeMembership,
  findCapsule,
  listCapsules,
} from '../../capsules/queries';
import { HttpError } from '../../errors';
import {
  CLOSET_FILTERS,
  garmentSummaries,
  GRID_PAGE_SIZE,
} from '../../wardrobe/queries';
import { defineTool, type ToolContext, wardrobeFor } from '../tool';
import { ownerIdInput, rowId } from './common';
import { summaryOut } from './garments';

const CAPSULE_NOT_FOUND = 'Capsule not found';

/** The capsule in the wardrobe, or the same 404 as an unknown id (capsuleNotFound). */
async function capsuleIn(ctx: ToolContext, id: number, ownerId: number) {
  const capsule = await findCapsule(ctx.db, id, ownerId);
  if (!capsule) throw new HttpError(404, CAPSULE_NOT_FOUND);
  return capsule;
}

export const capsuleTools = [
  defineTool({
    name: 'list_capsules',
    title: 'List capsules',
    description:
      "A wardrobe's capsules (named subsets of the closet: office, weekend, a trip's pool) by name, with how many unarchived garments each holds.",
    input: z.object({ ownerId: ownerIdInput }),
    writes: false,
    async run({ ownerId }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'view');
      const capsules = await listCapsules(ctx.db, access.ownerId);
      return {
        capsules: capsules.map(({ id, name, count }) => ({ id, name, count })),
      };
    },
  }),

  defineTool({
    name: 'get_capsule',
    title: 'Get a capsule',
    description: `A capsule's name, notes and its unarchived garments, newest first, ${GRID_PAGE_SIZE} a page: pass the answer's \`next\` as \`before\` for the next page.`,
    input: z.object({
      id: rowId().describe('The capsule id, from list_capsules.'),
      ownerId: ownerIdInput,
      before: rowId().optional().describe('The previous page’s `next`.'),
    }),
    writes: false,
    async run({ id, ownerId, before }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'view');
      const capsule = await capsuleIn(ctx, id, access.ownerId);
      const page = await garmentSummaries(
        ctx.db,
        access.ownerId,
        { ...CLOSET_FILTERS, capsule: id },
        { before, limit: GRID_PAGE_SIZE },
      );
      return {
        ...capsule,
        garments: page.garments.map(summaryOut),
        next: page.before ?? null,
      };
    },
  }),

  defineTool({
    name: 'set_capsule_membership',
    title: 'Add or remove garments in a capsule',
    description:
      'WRITES: adds garments to a capsule and removes others from it (the garments themselves stay in the closet). Garments outside the capsule’s wardrobe are ignored. Needs your own wardrobe or a MANAGE share.',
    input: z.object({
      id: rowId().describe('The capsule id.'),
      ownerId: ownerIdInput,
      add: z
        .array(rowId())
        .max(500)
        .default([])
        .describe('Garment ids to add.'),
      remove: z
        .array(rowId())
        .max(500)
        .default([])
        .describe('Garment ids to take out.'),
    }),
    writes: true,
    idempotent: true,
    async run({ id, ownerId, add, remove }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'manage');
      await capsuleIn(ctx, id, access.ownerId);
      const result = await changeMembership(ctx.db, access.ownerId, {
        add: { capsuleIds: [id], garmentIds: add },
        remove: { capsuleIds: [id], garmentIds: remove },
      });
      ctx.webLogger.info(
        `Capsule ${id} membership changed by user ${ctx.userId} (MCP): ${result.added} added, ${result.removed} removed`,
      );
      return result;
    },
  }),
];
