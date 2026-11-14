import * as z from 'zod';
import {
  requireCapsule,
  setCapsuleMembers,
} from '../../capsules/capsule-actions';
import { listCapsules } from '../../capsules/queries';
import { GRID_PAGE_SIZE } from '../../wardrobe/grid-page-size';
import { CLOSET_FILTERS, garmentSummaries } from '../../wardrobe/queries';
import { actorOf, defineTool, wardrobeFor } from '../tool';
import { ownerIdInput, rowId } from './common';
import { summaryOut } from './garments';

export const capsuleTools = [
  defineTool({
    name: 'list_capsules',
    title: 'List capsules',
    description:
      "A wardrobe's capsules (named subsets of the closet: office, weekend, a trip's pool) by name, with how many of their garments are in the closet.",
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
    description: `A capsule's name, notes and its garments in the closet, newest first, ${GRID_PAGE_SIZE} a page: pass the answer's \`next\` as \`before\` for the next page.`,
    input: z.object({
      id: rowId().describe('The capsule id, from list_capsules.'),
      ownerId: ownerIdInput,
      before: rowId().optional().describe('The previous page’s `next`.'),
    }),
    writes: false,
    async run({ id, ownerId, before }, ctx) {
      const { access, capsule } = await requireCapsule(
        ctx.db,
        actorOf(ctx),
        { id, ownerId, unseen: 'wardrobe' },
        'view',
      );
      const page = await garmentSummaries(
        ctx.db,
        access.ownerId,
        { ...CLOSET_FILTERS, capsule: id },
        // No keyword, so every row is rank 0 and the cursor its bare id.
        {
          before: before === undefined ? undefined : { rank: 0, id: before },
          limit: GRID_PAGE_SIZE,
        },
      );
      return {
        ...capsule,
        garments: page.garments.map(summaryOut),
        next: page.before?.id ?? null,
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
      const { added, removed } = await setCapsuleMembers(
        ctx.db,
        actorOf(ctx),
        { id, ownerId, unseen: 'wardrobe' },
        { add, remove },
      );
      ctx.webLogger.info(
        `Capsule ${id} membership changed by user ${ctx.userId} (MCP): ${added} added, ${removed} removed`,
      );
      return { added, removed };
    },
  }),
];
