import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  file,
  garment,
  planItem,
  planItemCandidate,
  planLook,
  planLookSlot,
  wardrobePlan,
} from '../../db/schema';
import { OUTFIT_ORDER } from '../../wardrobe/generator';
import {
  agentRewriteEvent,
  type LookNoteEffect,
  type LookReaction,
  type LookReactionEvent,
  lookReactionTransition,
} from '../../wardrobe/look-reaction';
import type { Occasion } from '../../wardrobe/occasions';
import { categoryRole, type GarmentRole } from '../../wardrobe/properties';
import type { GarmentStatus } from '../../wardrobe/status';
import { ownerTransaction } from '../auth/queries';
import { HttpError } from '../errors';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import { t } from '../i18n';
import { OUTFIT_GARMENTS_MAX } from '../outfits/queries';
import { planNotFound } from './validation';

/**
 * Plan looks (#290, epic #289): outfits the owner's agent designs from a
 * wardrobe plan, mixing closet garments with the plan's candidate
 * products, for the owner to react to (src/wardrobe/look-reaction.ts).
 * Owner-only like their plan: every read and write names the owner, and a
 * plan or look of anyone else's is a miss like a missing one.
 *
 * The only writer of plan_look and plan_look_slot. Every write holds the
 * owner lock (ownerTransaction), as does every writer of what a piece's
 * validity depends on (changeCandidates, reviewItems and the review post,
 * deleteItems, deletePlan, the duplicate), so a look's pieces are judged
 * with no candidacy or plan change in between. The garments themselves
 * are locked FOR SHARE in id order (as changeCandidates and insertSlots
 * take them), so a garment delete, Bought it or an archive outside the
 * owner lock waits for the write instead of failing a foreign key halfway.
 *
 * A piece is valid when it is the plan owner's garment and either in the
 * closet or a current candidate of this plan: on the wishlist and linked
 * (plan_item_candidate) to an item of this plan the owner has not
 * declined (a declined item's candidates are inert, as the duplicate
 * treats them). Whether a stored piece is owned, to buy or missing is
 * derived on every read (lookSlotState), never stored: a bought candidate
 * reads as owned, a deleted one empties its slot.
 */

export const LOOK_NOT_FOUND = 'Look not found';
export const LOOK_NAME_MAX = 120;
export const LOOK_NOTE_MAX = 2000;
/** One garment is a candidate, not a look. */
export const LOOK_PIECES_MIN = 2;
/** At most an outfit's garments, so a look always saves as one (#292). */
export const LOOK_PIECES_MAX = OUTFIT_GARMENTS_MAX;
/**
 * Looks a plan holds at most, declined ones aside: a few per occasion of
 * the week. Declined looks do not count, so "Not for me" always frees a
 * place, and they stay as the record of what not to propose again.
 */
export const LOOKS_PER_PLAN_MAX = 30;

export function lookNotFound(): HttpError {
  return new HttpError(404, LOOK_NOT_FOUND);
}

/** What the agent writes about a look besides its pieces. */
export interface LookFields {
  name: string;
  occasion: Occasion | null;
  note: string | null;
}

// ---- Refusals ---------------------------------------------------------------

/** A piece a look cannot hold, named when it is the owner's garment. */
export interface RefusedPiece {
  id: number;
  /** Undefined for an id that is no garment of the owner's: never named (#219's rule). */
  garment?: { name: string | null; reason: 'archived' | 'not-a-candidate' };
}

/**
 * A look naming a garment it cannot hold: nothing was written. A 409 when
 * every refused piece is the owner's (named), a 404 when any is not a
 * garment of theirs (counted, never named: another user's garment reads
 * as a missing one).
 */
export class LookPiecesRefused extends HttpError {
  constructor(readonly refused: readonly RefusedPiece[]) {
    super(
      refused.every((piece) => piece.garment) ? 409 : 404,
      refusalMessage(refused),
    );
    this.name = 'LookPiecesRefused';
  }
}

function refusalMessage(refused: readonly RefusedPiece[]): string {
  const reasons = refused.flatMap(({ garment: owned }) => {
    if (!owned) return [];
    const name = owned.name ?? t('looks.UNNAMED_GARMENT');
    return [
      owned.reason === 'archived'
        ? t('looks.PIECE_ARCHIVED', { name })
        : t('looks.PIECE_NOT_CANDIDATE', { name }),
    ];
  });
  const missing = refused.length - reasons.length;
  if (missing === 1) reasons.push(t('looks.PIECE_GONE_ONE'));
  if (missing > 1) reasons.push(t('looks.PIECE_GONE_MANY', { count: missing }));
  return t('looks.NOT_SAVED', { reasons: reasons.join('; ') });
}

/** Exactly the pieces of a look the owner declined: the agent never proposes them again. */
export class LookSetDeclined extends HttpError {
  constructor(readonly lookId: number) {
    super(409, t('looks.DECLINED_SET'));
    this.name = 'LookSetDeclined';
  }
}

/** An update to exactly another look's pieces. */
export class LookSetTaken extends HttpError {
  constructor(readonly lookId: number) {
    super(409, t('looks.SAME_SET', { id: lookId }));
    this.name = 'LookSetTaken';
  }
}

export class TooManyLooks extends HttpError {
  constructor() {
    super(409, t('looks.TOO_MANY', { max: LOOKS_PER_PLAN_MAX }));
    this.name = 'TooManyLooks';
  }
}

/** "Change this" without a note: the agent would have nothing to go on. A 400, nothing written. */
export class LookNoteRequired extends HttpError {
  constructor() {
    super(400, t('looks.NOTE_REQUIRED'));
    this.name = 'LookNoteRequired';
  }
}

/** An agent's rewrite of a look the owner declined: they reconsider it first. */
export class LookDeclined extends HttpError {
  constructor() {
    super(409, t('looks.DECLINED_LOOK'));
    this.name = 'LookDeclined';
  }
}

/** The fields' and pieces' own rules, before any statement: a 400. */
function checkLook(
  fields: Partial<LookFields>,
  garmentIds: readonly number[] | undefined,
): void {
  if (fields.name !== undefined && fields.name.trim() === '') {
    throw new HttpError(400, t('looks.NAME_BLANK'));
  }
  if (garmentIds === undefined) return;
  if (
    garmentIds.length < LOOK_PIECES_MIN ||
    garmentIds.length > LOOK_PIECES_MAX
  ) {
    throw new HttpError(
      400,
      t('looks.PIECE_COUNT', { min: LOOK_PIECES_MIN, max: LOOK_PIECES_MAX }),
    );
  }
  if (new Set(garmentIds).size !== garmentIds.length) {
    throw new HttpError(400, t('looks.PIECE_REPEATED'));
  }
}

/** An owner's or agent's note as stored: trimmed, blank null. */
function storedNote(note: string | null | undefined): string | null {
  return note?.trim() || null;
}

/** Trimmed, a blank note null: as stored. */
function storedFields<T extends Partial<LookFields>>(fields: T): T {
  return {
    ...fields,
    ...(fields.name === undefined ? {} : { name: fields.name.trim() }),
    ...(fields.note === undefined ? {} : { note: storedNote(fields.note) }),
  };
}

// ---- Piece validity ---------------------------------------------------------

/**
 * The garments of plan `planId`'s current candidates: on any item of the
 * plan the owner has not declined. A subquery (uncorrelated, so drizzle's
 * single-table column rendering cannot confuse it; src/db/CLAUDE.md).
 */
function candidateIdsOf(db: Queryable, planId: number) {
  return db
    .select({ garmentId: planItemCandidate.garmentId })
    .from(planItemCandidate)
    .innerJoin(planItem, eq(planItem.id, planItemCandidate.planItemId))
    .where(and(eq(planItem.planId, planId), ne(planItem.review, 'declined')));
}

interface PieceGarment {
  id: number;
  name: string | null;
  category: string;
  status: GarmentStatus;
  /** A current candidate of the look's plan. */
  candidate: boolean;
}

/**
 * `ownerId`'s garments among `garmentIds`, locked FOR SHARE in id order,
 * each with whether it is a current candidate of plan `planId`. One
 * statement.
 */
async function lockPieces(
  tx: Queryable,
  ownerId: number,
  planId: number,
  garmentIds: readonly number[],
): Promise<Map<number, PieceGarment>> {
  const rows = await tx
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      status: garment.status,
      candidate: sql<boolean>`${inArray(garment.id, candidateIdsOf(tx, planId))}`,
    })
    .from(garment)
    .where(
      and(eq(garment.ownerId, ownerId), inArray(garment.id, [...garmentIds])),
    )
    .orderBy(garment.id)
    .for('share');
  return new Map(rows.map((row) => [row.id, row]));
}

/** Which of `garmentIds` a look of the plan cannot hold, in the order given. */
function refusedOf(
  found: ReadonlyMap<number, PieceGarment>,
  garmentIds: readonly number[],
): RefusedPiece[] {
  return garmentIds.flatMap((id): RefusedPiece[] => {
    const row = found.get(id);
    if (!row) return [{ id }];
    if (row.status === 'closet') return [];
    if (row.status === 'wishlist' && row.candidate) return [];
    return [
      {
        id,
        garment: {
          name: row.name,
          reason: row.status === 'archived' ? 'archived' : 'not-a-candidate',
        },
      },
    ];
  });
}

/**
 * The pieces as slots, top to toe (OUTFIT_ORDER of each garment's role,
 * custom categories last; the order given within a role), each filling
 * its garment's category, as Styling saves an outfit's slots.
 */
function slotsOf(
  pieces: ReadonlyMap<number, PieceGarment>,
  garmentIds: readonly number[],
): { position: number; category: string; garmentId: number }[] {
  const rank = (id: number) =>
    OUTFIT_ORDER.indexOf(categoryRole(pieces.get(id)!.category));
  return [...garmentIds]
    .sort((a, b) => rank(a) - rank(b))
    .map((garmentId, position) => ({
      position,
      category: pieces.get(garmentId)!.category,
      garmentId,
    }));
}

/** Locks and judges the pieces: their slots, or LookPiecesRefused with nothing written. */
async function judgedSlots(
  tx: Queryable,
  ownerId: number,
  planId: number,
  garmentIds: readonly number[],
) {
  const pieces = await lockPieces(tx, ownerId, planId, garmentIds);
  const refused = refusedOf(pieces, garmentIds);
  if (refused.length > 0) throw new LookPiecesRefused(refused);
  return slotsOf(pieces, garmentIds);
}

// ---- The plan's looks as sets -----------------------------------------------

interface LookSet {
  id: number;
  reaction: LookReaction;
  /** Its garments, ascending. */
  garmentIds: number[];
  /** Its slots, emptied ones included. */
  slots: number;
}

/**
 * `ownerId`'s plan `planId` with each of its looks as a garment set, or
 * undefined when the plan is not theirs. One statement: what a write
 * compares a new set against and counts toward the cap.
 */
async function planLookSets(
  tx: Queryable,
  ownerId: number,
  planId: number,
): Promise<LookSet[] | undefined> {
  const rows = await tx
    .select({
      id: planLook.id,
      reaction: planLook.reaction,
      garmentIds: sql<
        number[]
      >`coalesce(array_agg(${planLookSlot.garmentId} order by ${planLookSlot.garmentId}) filter (where ${planLookSlot.garmentId} is not null), '{}')`,
      slots: sql<number>`count(${planLookSlot.position})::int`,
    })
    .from(wardrobePlan)
    .leftJoin(planLook, eq(planLook.planId, wardrobePlan.id))
    .leftJoin(planLookSlot, eq(planLookSlot.lookId, planLook.id))
    .where(and(eq(wardrobePlan.id, planId), eq(wardrobePlan.ownerId, ownerId)))
    .groupBy(wardrobePlan.id, planLook.id);
  if (rows.length === 0) return undefined;
  return rows.flatMap((row) =>
    row.id === null || row.reaction === null
      ? []
      : [{ ...row, id: row.id, reaction: row.reaction }],
  );
}

/**
 * The look whose pieces are exactly `garmentIds` (a look with an emptied
 * slot holds fewer than it was given, so it is nobody's exact set).
 */
function sameSetLook(
  looks: readonly LookSet[],
  garmentIds: readonly number[],
): LookSet | undefined {
  const wanted = [...garmentIds].sort((a, b) => a - b);
  return looks.find(
    (look) =>
      look.slots === wanted.length &&
      look.garmentIds.length === wanted.length &&
      look.garmentIds.every((id, index) => id === wanted[index]),
  );
}

async function insertSlots(
  tx: Queryable,
  lookId: number,
  slots: readonly { position: number; category: string; garmentId: number }[],
): Promise<void> {
  await tx
    .insert(planLookSlot)
    .values(slots.map((slot) => ({ ...slot, lookId })));
}

// ---- The agent's writes -----------------------------------------------------

export interface ProposedLook {
  id: number;
  /** A look of exactly these pieces was there already: the answer, nothing written. */
  alreadyProposed: boolean;
}

/**
 * The agent's new look in `ownerId`'s plan `planId`, at `proposed`, its
 * pieces `garmentIds` (2 to LOOK_PIECES_MAX, each once) judged under the
 * owner lock (the module's rule). A look of exactly these pieces already
 * in the plan is the answer (alreadyProposed, its own name and note
 * kept), so a retry writes nothing; one the owner declined is refused
 * (LookSetDeclined). Past LOOKS_PER_PLAN_MAX looks not declined:
 * TooManyLooks. The plan not the owner's: its 404.
 */
export async function proposeLook(
  db: Queryable,
  ownerId: number,
  planId: number,
  fields: LookFields,
  garmentIds: readonly number[],
): Promise<ProposedLook> {
  checkLook(fields, garmentIds);
  return ownerTransaction(db, ownerId, 'proposeLook', async (tx) => {
    const looks = await planLookSets(tx, ownerId, planId);
    if (!looks) throw planNotFound();
    // Judged first: a retry is answered only while its pieces still pass,
    // so a set gone stale (a piece archived, a candidate unlinked) is refused
    // as a fresh proposal would be, never confirmed.
    const slots = await judgedSlots(tx, ownerId, planId, garmentIds);
    const same = sameSetLook(looks, garmentIds);
    if (same?.reaction === 'declined') throw new LookSetDeclined(same.id);
    if (same) return { id: same.id, alreadyProposed: true };
    const kept = looks.filter((look) => look.reaction !== 'declined');
    if (kept.length >= LOOKS_PER_PLAN_MAX) throw new TooManyLooks();
    const [look] = await tx
      .insert(planLook)
      .values({
        ...storedFields(fields),
        planId,
        reaction: 'proposed',
        agentChangedAt: sql`now()`,
      })
      .returning({ id: planLook.id });
    await insertSlots(tx, look.id, slots);
    return { id: look.id, alreadyProposed: false };
  });
}

/** What an agent's update changes: only what is given; null clears the occasion or the note. */
export type LookChange = Partial<LookFields> & {
  /** The whole new set of pieces, judged as proposeLook judges them. */
  garmentIds?: readonly number[];
};

export interface UpdatedLook {
  planId: number;
  from: LookReaction;
  to: LookReaction;
}

/**
 * The agent's rewrite of `ownerId`'s look `lookId`: a content edit of its
 * own proposal, else back to `proposed` (repropose: a look sent back or
 * loved, the owner's note kept for them to compare). A declined look is
 * refused (LookDeclined), as is a new set that is exactly another look's
 * (LookSetDeclined for a declined one, else LookSetTaken). New pieces
 * replace the slots whole. Under the owner lock, so the reaction judged is
 * the one written over.
 */
export async function updateLook(
  db: Queryable,
  ownerId: number,
  lookId: number,
  change: LookChange,
): Promise<UpdatedLook> {
  const { garmentIds, ...fields } = change;
  checkLook(fields, garmentIds);
  return ownerTransaction(db, ownerId, 'updateLook', async (tx) => {
    const [look] = await tx
      .select({ planId: planLook.planId, reaction: planLook.reaction })
      .from(planLook)
      .innerJoin(wardrobePlan, eq(wardrobePlan.id, planLook.planId))
      .where(and(eq(planLook.id, lookId), eq(wardrobePlan.ownerId, ownerId)));
    if (!look) throw lookNotFound();
    const event = agentRewriteEvent(look.reaction);
    const move = event
      ? lookReactionTransition(look.reaction, event)
      : ({ ok: true, from: look.reaction, to: look.reaction } as const);
    if (!move.ok) throw new LookDeclined();
    if (garmentIds) {
      const looks = (await planLookSets(tx, ownerId, look.planId)) ?? [];
      const same = sameSetLook(
        looks.filter((other) => other.id !== lookId),
        garmentIds,
      );
      if (same?.reaction === 'declined') throw new LookSetDeclined(same.id);
      if (same) throw new LookSetTaken(same.id);
      const slots = await judgedSlots(tx, ownerId, look.planId, garmentIds);
      await tx.delete(planLookSlot).where(eq(planLookSlot.lookId, lookId));
      await insertSlots(tx, lookId, slots);
    }
    // repropose keeps the owner's note; a content edit has none to touch.
    await tx
      .update(planLook)
      .set({
        ...storedFields(fields),
        reaction: move.to,
        agentChangedAt: sql`now()`,
      })
      .where(eq(planLook.id, lookId));
    return { planId: look.planId, from: move.from, to: move.to };
  });
}

// ---- The owner's reactions --------------------------------------------------

/** One look a reaction names, with the owner's note when the move writes one. */
export interface LookMove {
  lookId: number;
  note?: string | null;
}

export interface LookMoves {
  /** The looks moved, in id order. */
  moved: number[];
  /** Looks of the plan whose reaction does not take the event, with where they stay. */
  refused: { lookId: number; reaction: LookReaction }[];
}

/**
 * The one writer of the owner's reactions (src/wardrobe/look-reaction.ts):
 * `event` on `ownerId`'s plan `planId`'s looks `moves`, each asked of the
 * machine against its stored reaction, under the owner lock. Ids that are
 * no look of the plan are in neither list (a caller's 404). Two statements
 * however many: the read, and one update (each note a case of it).
 * reviewItems' shape. Notes are stored trimmed, a blank one null; a
 * `change` without one is LookNoteRequired (400) before any statement (the
 * column's check backs it). `reconsider` brings declined looks back under
 * LOOKS_PER_PLAN_MAX, counted in the read: past it the whole call is
 * TooManyLooks, nothing moved. Love it, Change this, Not for me and
 * Reconsider in the app (#291).
 */
export async function reactToLooks(
  db: Queryable,
  ownerId: number,
  planId: number,
  event: Exclude<LookReactionEvent, 'repropose'>,
  moves: readonly LookMove[],
): Promise<LookMoves> {
  if (moves.length === 0) return { moved: [], refused: [] };
  const notes = new Map(
    moves.map((move) => [move.lookId, storedNote(move.note)]),
  );
  if (event === 'change' && [...notes.values()].some((note) => !note)) {
    throw new LookNoteRequired();
  }
  return ownerTransaction(db, ownerId, 'reactToLooks', async (tx) => {
    const rows = await tx
      .select({
        id: planLook.id,
        reaction: planLook.reaction,
        // The plan's looks not declined, counted under the lock: Reconsider
        // brings declined looks back into the cap.
        kept: tx.$count(
          planLook,
          and(eq(planLook.planId, planId), ne(planLook.reaction, 'declined')),
        ),
      })
      .from(planLook)
      .innerJoin(wardrobePlan, eq(wardrobePlan.id, planLook.planId))
      .where(
        and(
          inArray(
            planLook.id,
            moves.map((move) => move.lookId),
          ),
          eq(planLook.planId, planId),
          eq(wardrobePlan.ownerId, ownerId),
        ),
      )
      .orderBy(asc(planLook.id));
    const moved: number[] = [];
    const refused: LookMoves['refused'] = [];
    let to: LookReaction | undefined;
    let effect: LookNoteEffect = 'keep';
    for (const row of rows) {
      const move = lookReactionTransition(row.reaction, event);
      if (move.ok) {
        moved.push(row.id);
        // One event: every move leads to the same reaction, with the same effect.
        to = move.to;
        effect = move.note;
      } else {
        refused.push({ lookId: row.id, reaction: move.reaction });
      }
    }
    if (to === undefined) return { moved, refused };
    // All or nothing: past the cap, no look is reconsidered.
    if (
      event === 'reconsider' &&
      rows[0].kept + moved.length > LOOKS_PER_PLAN_MAX
    ) {
      throw new TooManyLooks();
    }
    await tx
      .update(planLook)
      .set({ reaction: to, ...ownerNoteSet(effect, moved, notes) })
      .where(inArray(planLook.id, moved));
    return { moved, refused };
  });
}

function ownerNoteSet(
  effect: LookNoteEffect,
  lookIds: readonly number[],
  notes: ReadonlyMap<number, string | null>,
): { ownerNote?: SQL | null } {
  switch (effect) {
    case 'keep':
      return {};
    case 'clear':
      return { ownerNote: null };
    case 'write':
      return {
        ownerNote: sql`case ${planLook.id} ${sql.join(
          lookIds.map(
            (id) => sql`when ${id} then ${notes.get(id) ?? null}::text`,
          ),
          sql` `,
        )} end`,
      };
  }
}

// ---- The duplicate ----------------------------------------------------------

/**
 * Copies plan `fromPlanId`'s looks into `toPlanId` (the duplicate, under
 * the owner lock it holds): each with its reaction, notes and slots as
 * they stand, emptied slots included, so a declined look's set stays
 * remembered and the agent working on the copy never proposes it again.
 * The duplicate copies the candidates of every item not declined, so a
 * piece valid in the original is valid in the copy. Three statements
 * (none when the plan has no looks): the read, the looks, the slots.
 * Answers how many looks were copied.
 */
export async function copyLooks(
  tx: Queryable,
  fromPlanId: number,
  toPlanId: number,
): Promise<number> {
  const originals = await tx
    .select({
      id: planLook.id,
      name: planLook.name,
      occasion: planLook.occasion,
      note: planLook.note,
      reaction: planLook.reaction,
      ownerNote: planLook.ownerNote,
      agentChangedAt: planLook.agentChangedAt,
      slots: sql<
        { position: number; category: string; garmentId: number | null }[]
      >`coalesce(json_agg(json_build_object('position', ${planLookSlot.position}, 'category', ${planLookSlot.category}, 'garmentId', ${planLookSlot.garmentId})) filter (where ${planLookSlot.position} is not null), '[]')`,
    })
    .from(planLook)
    .leftJoin(planLookSlot, eq(planLookSlot.lookId, planLook.id))
    .where(eq(planLook.planId, fromPlanId))
    .groupBy(planLook.id)
    .orderBy(asc(planLook.id));
  if (originals.length === 0) return 0;
  const inserted = await tx
    .insert(planLook)
    .values(
      originals.map((look) => ({
        planId: toPlanId,
        name: look.name,
        occasion: look.occasion,
        note: look.note,
        reaction: look.reaction,
        ownerNote: look.ownerNote,
        agentChangedAt: look.agentChangedAt,
      })),
    )
    .returning({ id: planLook.id });
  // One statement draws its serials in VALUES order; RETURNING's own order
  // is not promised (copyItems' rule).
  const copies = inserted.map((row) => row.id).sort((a, b) => a - b);
  const slots = originals.flatMap((original, index) =>
    original.slots.map((slot) => ({ ...slot, lookId: copies[index] })),
  );
  if (slots.length > 0) await tx.insert(planLookSlot).values(slots);
  return originals.length;
}

// ---- Reads ------------------------------------------------------------------

/** Why a slot holds no piece the look can use. */
export type MissingReason = 'removed' | 'archived' | 'not-a-candidate';

/** Where a slot's piece stands, derived from its garment on every read. */
export type LookSlotState =
  | { state: 'owned' }
  | { state: 'to-buy' }
  | { state: 'missing'; reason: MissingReason };

/**
 * A slot's state: owned once its garment is in the closet (a bought
 * candidate included), to buy while it is a current candidate of the plan,
 * and missing when its garment was deleted (the slot emptied), archived, or
 * is on the wishlist but no longer a candidate (unlinked, its item deleted
 * or declined). Pure.
 */
export function lookSlotState(
  garmentState: { status: GarmentStatus; candidate: boolean } | null,
): LookSlotState {
  if (!garmentState) return { state: 'missing', reason: 'removed' };
  switch (garmentState.status) {
    case 'closet':
      return { state: 'owned' };
    case 'archived':
      return { state: 'missing', reason: 'archived' };
    case 'wishlist':
      return garmentState.candidate
        ? { state: 'to-buy' }
        : { state: 'missing', reason: 'not-a-candidate' };
  }
}

export type LookSlotView = {
  position: number;
  /** The garment's category when the look was written: the slot an outfit would fill. */
  category: string;
  role: GarmentRole;
  /** Null once the garment was deleted. */
  garmentId: number | null;
  name: string | null;
  photo: SignablePhotoRef | null;
} & LookSlotState;

/** A slot holding nothing the look can use. */
export type MissingSlot = LookSlotView & { state: 'missing' };

export interface PlanLookView {
  id: number;
  planId: number;
  name: string;
  occasion: Occasion | null;
  note: string | null;
  reaction: LookReaction;
  ownerNote: string | null;
  /** When the agent last wrote it; the owner's reactions never touch it. */
  agentChangedAt: Date | null;
  /** In order, top to toe. */
  slots: LookSlotView[];
  /** The slots holding nothing the look can use, each with its role and why. */
  missingPieces: MissingSlot[];
  /** Every piece owned: the look can become an outfit (#292). */
  complete: boolean;
}

/**
 * The looks of `ownerId`'s plan `planId`, oldest first, each slot with its
 * derived state (lookSlotState); none when the plan is not theirs. One
 * statement.
 */
export async function looksOfPlan(
  db: Queryable,
  ownerId: number,
  planId: number,
): Promise<PlanLookView[]> {
  const rows = await db
    .select({
      look: {
        id: planLook.id,
        planId: planLook.planId,
        name: planLook.name,
        occasion: planLook.occasion,
        note: planLook.note,
        reaction: planLook.reaction,
        ownerNote: planLook.ownerNote,
        agentChangedAt: planLook.agentChangedAt,
      },
      position: planLookSlot.position,
      category: planLookSlot.category,
      garmentId: garment.id,
      name: garment.name,
      status: garment.status,
      candidate: sql<boolean>`coalesce(${inArray(garment.id, candidateIdsOf(db, planId))}, false)`,
      photo: photoRefJson,
    })
    .from(planLook)
    .innerJoin(wardrobePlan, eq(wardrobePlan.id, planLook.planId))
    .innerJoin(planLookSlot, eq(planLookSlot.lookId, planLook.id))
    // The writer's rule, kept on read: never another wardrobe's garment.
    .leftJoin(
      garment,
      and(eq(garment.id, planLookSlot.garmentId), eq(garment.ownerId, ownerId)),
    )
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(eq(planLook.planId, planId), eq(wardrobePlan.ownerId, ownerId)))
    .orderBy(asc(planLook.id), asc(planLookSlot.position));
  const looks = new Map<number, PlanLookView>();
  for (const row of rows) {
    let look = looks.get(row.look.id);
    if (!look) {
      look = { ...row.look, slots: [], missingPieces: [], complete: true };
      looks.set(row.look.id, look);
    }
    const slot: LookSlotView = {
      position: row.position,
      category: row.category,
      role: categoryRole(row.category),
      garmentId: row.garmentId,
      name: row.name,
      photo: row.photo,
      ...lookSlotState(
        row.status === null
          ? null
          : { status: row.status, candidate: row.candidate },
      ),
    };
    look.slots.push(slot);
    if (slot.state === 'missing') look.missingPieces.push(slot);
    if (slot.state !== 'owned') look.complete = false;
  }
  return [...looks.values()];
}
