import * as z from 'zod/v4';
import { OCCASIONS } from '../../../wardrobe/occasions';
import {
  LOOK_NAME_MAX,
  LOOK_NOTE_MAX,
  LOOK_PIECES_MAX,
  LOOK_PIECES_MIN,
  looksOfPlan,
  proposeLook,
  updateLook,
} from '../../plans/looks';
import { defineTool, type ToolContext } from '../tool';
import { rowId } from './common';
import { byOccasion, lookOut } from './look-out';
import { planFor, planIdInput } from './plans';

/**
 * The plan looks' tools (#290, epic #289): outfits the agent designs from a
 * plan, mixing closet garments with its candidate products, for the owner to
 * react to in the app. Plans are the caller's own, so a plan or look of
 * anyone else's is "not found". The tools call the page writers
 * (src/web/plans/looks.ts) only; the machine behind `reaction` is
 * src/wardrobe/look-reaction.ts. get_plan_feedback lists the looks that
 * wait on the agent (tools/plans.ts).
 */

/** `planId`, or the active plan's id: only an omitted one costs a read (the writer answers a missing plan). */
async function planIdOf(
  ctx: ToolContext,
  planId: number | undefined,
): Promise<number> {
  return planId ?? (await planFor(ctx, undefined)).id;
}

const garmentIdsInput = z
  .array(rowId())
  .min(LOOK_PIECES_MIN)
  .max(LOOK_PIECES_MAX)
  .describe(
    `The look's pieces, ${LOOK_PIECES_MIN} to ${LOOK_PIECES_MAX}, each once: garments in the closet, or current candidates of this plan (wishlist garments linked to an item the owner has not declined).`,
  );

const nameInput = z.string().min(1).max(LOOK_NAME_MAX);

export const lookTools = [
  defineTool({
    name: 'list_looks',
    title: 'List a plan’s looks',
    description:
      'The looks of a wardrobe plan (the active one when planId is omitted), by occasion: each with its slots top to toe (role, and state: owned in the closet, to-buy a current candidate, or missing with why: removed, archived, not-a-candidate), your note, the owner’s reaction (proposed, loved, revise, declined) and ownerNote, the missing pieces with their role, and complete (every piece owned). A declined look’s slots are the exact set never to propose again.',
    input: z.object({ planId: planIdInput }),
    writes: false,
    async run({ planId }, ctx) {
      const plan = await planFor(ctx, planId);
      const looks = await looksOfPlan(ctx.db, ctx.userId, plan.id);
      return { planId: plan.id, looks: byOccasion(looks).map(lookOut) };
    },
  }),

  defineTool({
    name: 'propose_look',
    title: 'Propose a look',
    description:
      'WRITES: adds a look to one of your wardrobe plans (the active one when planId is omitted), at reaction proposed for the owner to love, change or decline in the app: an outfit mixing closet garments with this plan’s candidate products. name, an optional occasion and a note on why it works and when to wear it. A piece that is neither in the closet nor a current candidate of the plan is refused (409 when it is yours, naming it), and nothing is written. Never exactly the set of a look the owner declined (refused); proposing a set already in the plan answers that look (alreadyProposed). At most 30 looks not declined per plan.',
    input: z.object({
      planId: planIdInput,
      name: nameInput.describe('What to call it ("Monday at the office").'),
      occasion: z
        .enum(OCCASIONS)
        .optional()
        .describe(`When it is for: ${OCCASIONS.join(', ')}. Omit for none.`),
      note: z
        .string()
        .max(LOOK_NOTE_MAX)
        .optional()
        .describe(
          'Why the look works and when to wear it: the owner reads it.',
        ),
      garmentIds: garmentIdsInput,
    }),
    writes: true,
    idempotent: true,
    async run({ planId, name, occasion, note, garmentIds }, ctx) {
      const plan = await planIdOf(ctx, planId);
      const look = await proposeLook(
        ctx.db,
        ctx.userId,
        plan,
        { name, occasion: occasion ?? null, note: note ?? null },
        garmentIds,
      );
      ctx.webLogger.info(
        `Look ${look.id} ${look.alreadyProposed ? 'already in' : 'proposed for'} plan ${plan} by user ${ctx.userId} (MCP), ${garmentIds.length} pieces`,
      );
      return {
        id: look.id,
        planId: plan,
        reaction: 'proposed' as const,
        alreadyProposed: look.alreadyProposed,
      };
    },
  }),

  defineTool({
    name: 'update_look',
    title: 'Update a look',
    description:
      'WRITES: changes a look of yours in one of your plans; fields not given stay as stored, null clears the occasion or the note, garmentIds is the whole new set of pieces (judged as in propose_look). The look is proposed again (a look the owner sent back for a change, revise, or loved goes back to them this way; their ownerNote stays for them to compare). A look the owner declined is refused (409), as is a set that is exactly another look’s.',
    input: z.object({
      lookId: rowId().describe('The look id, from list_looks.'),
      name: nameInput.optional(),
      occasion: z.enum(OCCASIONS).nullable().optional(),
      note: z.string().max(LOOK_NOTE_MAX).nullable().optional(),
      garmentIds: garmentIdsInput.optional(),
    }),
    writes: true,
    idempotent: true,
    async run({ lookId, ...change }, ctx) {
      const updated = await updateLook(ctx.db, ctx.userId, lookId, change);
      ctx.webLogger.info(
        `Look ${lookId} of plan ${updated.planId} changed by user ${ctx.userId} (MCP), ${updated.from} to ${updated.to}`,
      );
      return {
        id: lookId,
        planId: updated.planId,
        reaction: updated.to,
        from: updated.from,
      };
    },
  }),
];
