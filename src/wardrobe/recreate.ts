import { colorsGoTogether, neutralFor, rotationWeight } from './generator';
import {
  avoidedPairRule,
  compileRules,
  type OutfitRule,
  type RuleGarment,
} from './outfit-rules';
import {
  type GarmentColor,
  type InspirationPieceRole,
  type Pattern,
  pieceCategory,
} from './properties';

/**
 * "Recreate this look" (#22; docs/plans/2026-11-13-inspiration-library.md,
 * section 4): the owner's closet garments closest to each piece they tagged
 * in a saved look, chosen so the chosen set goes together. Pure and
 * deterministic (no seed: every tie has an order), so the look's match
 * view (src/web/inspiration) and, later, MCP's get_inspiration answer the
 * same for the same closet.
 *
 * - **Candidates** for a piece are the closet's garments of its role
 *   (the caller passes inCloset garments: dirty and away ones too, a look
 *   is recreated from what the owner has, not from what is clean today).
 * - **Ranking**, in this order: the type equal; the colours (the piece's
 *   main colour, then its accent; equal before a close shade, CLOSE_COLORS);
 *   the pattern equal; then available before not, the most rested
 *   (rotationWeight), the oldest id.
 * - **The floor**: a garment is a match only when it shares the piece's
 *   type or one of its colours (a close shade counts). A piece naming
 *   neither takes any garment of its role. A piece with no match is missing.
 * - **Going together**: the chosen set must pass the generator's colour and
 *   pattern rule (colorsGoTogether) and break none of the owner's
 *   never-rules (avoided pairs included), and no garment fills two pieces.
 *   What the look itself breaks is excused (the owner saved it: the pieces
 *   judged as garments), as the generator excuses a rule two locked
 *   garments break. When the closest set clashes, the sets that stray
 *   least from it are tried (fewest steps down the pieces' rankings, the
 *   loudest piece moved first); when none within the search goes, the
 *   closest are kept and the clashing pieces named (`unfixed`).
 */

/** What a piece of a look is read as (inspiration_piece). */
export interface LookPiece {
  role: InspirationPieceRole;
  type: string | null;
  /** The main colour first, then an accent: at most INSPIRATION_PIECE_MAX_COLORS. */
  colors: readonly GarmentColor[];
  pattern: Pattern | null;
}

/** A closet garment as the matching reads it. */
export interface RecreateGarment extends RuleGarment {
  /** isAvailable: in the closet, not away, a clean copy left. */
  available: boolean;
  /** Whole days since last worn; null when never. */
  idleDays: number | null;
}

export interface RecreateRequest<G extends RecreateGarment> {
  pieces: readonly LookPiece[];
  /** The owner's closet garments (inCloset). */
  closet: readonly G[];
  /** Garment pairs never to combine (generator_avoid). */
  avoid: readonly (readonly [number, number])[];
  /** The owner's outfit rules: the never-rules are read. */
  rules: readonly OutfitRule[];
}

/** How a match agrees with its piece, for the page to say. */
export interface Agreement {
  type: boolean;
  /** 'exact': the main colour; 'close': a close shade of it, or the accent. */
  color: 'exact' | 'close' | null;
  pattern: boolean;
}

export interface PieceMatch<G> {
  garment: G;
  agrees: Agreement;
}

export interface RecreatedPiece<G> {
  /** The chosen match, then the next best: at most MATCHES_PER_PIECE; empty when missing. */
  matches: PieceMatch<G>[];
  /** The chosen one is not the closest: the closest did not go with the rest. */
  repicked: boolean;
}

export interface Recreation<G> {
  /** In the request's piece order. */
  pieces: RecreatedPiece<G>[];
  /** Pieces (indices) whose matches clash and that no re-pick within the search mended. */
  unfixed: number[];
}

/** Matches shown per piece: the chosen one and two alternates. */
export const MATCHES_PER_PIECE = 3;

/** How far down a piece's ranking the re-pick looks. */
const SEARCH_DEPTH = 6;

/** Sets the re-pick tries at most: bounds the work on a look of many pieces. */
const MAX_TRIES = 500;

/**
 * Shades read as close to each other, both ways round: what a photo's navy
 * is in a closet that says black or blue. A judgement, kept small: a close
 * shade ranks below the colour itself.
 */
const CLOSE_COLORS: readonly (readonly [GarmentColor, GarmentColor])[] = [
  ['black', 'grey'],
  ['black', 'blue'],
  ['grey', 'white'],
  ['grey', 'silver'],
  ['white', 'beige'],
  ['beige', 'brown'],
  ['brown', 'orange'],
  ['red', 'pink'],
  ['red', 'orange'],
  ['red', 'purple'],
  ['pink', 'purple'],
  ['orange', 'yellow'],
  ['yellow', 'gold'],
  ['blue', 'purple'],
];

function closeShades(a: GarmentColor, b: GarmentColor): boolean {
  return CLOSE_COLORS.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a),
  );
}

/** One colour of the piece against the garment's: 2 equal, 1 a close shade, 0 neither. */
function colorHit(color: GarmentColor, garment: RuleGarment): number {
  if (garment.colors.includes(color)) return 2;
  return garment.colors.some((c) => closeShades(color, c)) ? 1 : 0;
}

interface Scored<G> {
  garment: G;
  agrees: Agreement;
  /** The colours' part of the ranking: the main colour's hit weighs over the accent's. */
  colorScore: number;
}

function score<G extends RecreateGarment>(
  piece: LookPiece,
  garment: G,
): Scored<G> {
  const [main, accent] = piece.colors;
  const mainHit = main === undefined ? 0 : colorHit(main, garment);
  const accentHit = accent === undefined ? 0 : colorHit(accent, garment);
  return {
    garment,
    colorScore: mainHit * 3 + accentHit,
    agrees: {
      type: piece.type !== null && garment.type === piece.type,
      color: colorAgreement(mainHit, accentHit),
      pattern: piece.pattern !== null && garment.pattern === piece.pattern,
    },
  };
}

function colorAgreement(
  mainHit: number,
  accentHit: number,
): Agreement['color'] {
  if (mainHit === 2) return 'exact';
  return mainHit + accentHit > 0 ? 'close' : null;
}

function isMatch(piece: LookPiece, { agrees }: Scored<RecreateGarment>) {
  const namesNothing = piece.type === null && piece.colors.length === 0;
  return namesNothing || agrees.type || agrees.color !== null;
}

type Comparison = (
  a: Scored<RecreateGarment>,
  b: Scored<RecreateGarment>,
) => number;

/** Best first, each key breaking the previous one's ties: the order the module's comment gives. */
const RANKING: readonly Comparison[] = [
  (a, b) => Number(b.agrees.type) - Number(a.agrees.type),
  (a, b) => b.colorScore - a.colorScore,
  (a, b) => Number(b.agrees.pattern) - Number(a.agrees.pattern),
  (a, b) => Number(b.garment.available) - Number(a.garment.available),
  (a, b) => rotationWeight(b.garment) - rotationWeight(a.garment),
  // Ids last, so the order is total.
  (a, b) => a.garment.id - b.garment.id,
];

function byCloseness(
  a: Scored<RecreateGarment>,
  b: Scored<RecreateGarment>,
): number {
  for (const compare of RANKING) {
    const order = compare(a, b);
    if (order !== 0) return order;
  }
  return 0;
}

/** A piece's matches in the closet, best first; empty when it is missing. */
function ranked<G extends RecreateGarment>(
  piece: LookPiece,
  closet: readonly G[],
): Scored<G>[] {
  return closet
    .filter((garment) => garment.role === piece.role)
    .map((garment) => score(piece, garment))
    .filter((scored) => isMatch(piece, scored))
    .sort(byCloseness);
}

/** The piece as a garment, for judging what the look itself breaks (no closet id is negative). */
function asGarment(piece: LookPiece, index: number): RuleGarment {
  return {
    id: -(index + 1),
    role: piece.role,
    category: pieceCategory(piece.role),
    type: piece.type,
    colors: piece.colors,
    pattern: piece.pattern,
  };
}

/**
 * Accents and a loud pattern, of a piece or a garment: the pieces the
 * re-pick moves first, and the garments named when the colours clash.
 */
function loudness(item: Pick<RuleGarment, 'role' | 'colors' | 'pattern'>) {
  const accents = item.colors.filter(
    (c) => c !== 'pattern' && !neutralFor(item.role, c),
  ).length;
  const loud =
    (item.pattern !== null && item.pattern !== 'solid') ||
    item.colors.includes('pattern');
  return accents + (loud ? 1 : 0);
}

/** Judges a chosen set: what the look breaks itself is excused. */
function judgeOf(request: RecreateRequest<RecreateGarment>) {
  const look = request.pieces.map(asGarment);
  const all: OutfitRule[] = [
    ...request.rules.filter((rule) => rule.kind === 'never'),
    ...request.avoid.map(([a, b]) => avoidedPairRule(a, b)),
  ];
  const excused = new Set(compileRules(all).brokenAmong(look));
  const rules = compileRules(all.filter((rule) => !excused.has(rule)));
  const colorsExcused = !colorsGoTogether(look);
  return {
    colors: (set: readonly RecreateGarment[]) =>
      colorsExcused || colorsGoTogether(set),
    clash: (g: RuleGarment, h: RuleGarment) => rules.clash(g, h),
  };
}

type Judge = ReturnType<typeof judgeOf>;

function goesTogether(set: readonly RecreateGarment[], judge: Judge): boolean {
  if (new Set(set.map((g) => g.id)).size < set.length) return false;
  if (!judge.colors(set)) return false;
  return !set.some((g, i) => set.slice(i + 1).some((h) => judge.clash(g, h)));
}

/**
 * The step down each ranking (by `order`'s position) for every way to stray
 * `total` steps in all, the first of `order` taking the most: the loudest
 * piece moves first.
 */
function* spreads(
  depths: readonly number[],
  total: number,
): Generator<number[]> {
  if (depths.length === 0) {
    if (total === 0) yield [];
    return;
  }
  const [first, ...rest] = depths;
  for (let step = Math.min(total, first - 1); step >= 0; step -= 1) {
    for (const tail of spreads(rest, total - step)) yield [step, ...tail];
  }
}

/**
 * The steps down each matched piece's ranking of the set that strays least
 * and goes together, or undefined when none within the search does.
 */
function repick<G extends RecreateGarment>(
  matched: readonly { index: number; ranking: Scored<G>[]; loud: number }[],
  judge: Judge,
): Map<number, number> | undefined {
  const order = [...matched].sort(
    (a, b) => b.loud - a.loud || a.index - b.index,
  );
  const depths = order.map((m) => Math.min(m.ranking.length, SEARCH_DEPTH));
  const most = depths.reduce((sum, depth) => sum + depth - 1, 0);
  let tries = 0;
  for (let total = 0; total <= most; total += 1) {
    for (const steps of spreads(depths, total)) {
      tries += 1;
      if (tries > MAX_TRIES) return undefined;
      const set = order.map((m, i) => m.ranking[steps[i]].garment);
      if (goesTogether(set, judge)) {
        return new Map(order.map((m, i) => [m.index, steps[i]]));
      }
    }
  }
  return undefined;
}

/**
 * When no set goes: each piece the best garment no earlier piece took
 * (missing when none is left), and the pieces whose garments clash.
 */
function closestKept<G extends RecreateGarment>(
  matched: readonly { index: number; ranking: Scored<G>[] }[],
  judge: Judge,
): { steps: Map<number, number>; unfixed: number[] } {
  const taken = new Set<number>();
  const steps = new Map<number, number>();
  for (const { index, ranking } of matched) {
    const step = ranking.findIndex((s) => !taken.has(s.garment.id));
    if (step < 0) continue;
    steps.set(index, step);
    taken.add(ranking[step].garment.id);
  }
  const chosen = matched.flatMap(({ index, ranking }) => {
    const step = steps.get(index);
    return step === undefined
      ? []
      : [{ index, garment: ranking[step].garment }];
  });
  const clashing = new Set<number>();
  chosen.forEach((a, i) =>
    chosen.slice(i + 1).forEach((b) => {
      if (judge.clash(a.garment, b.garment)) {
        clashing.add(a.index);
        clashing.add(b.index);
      }
    }),
  );
  if (!judge.colors(chosen.map((c) => c.garment))) {
    for (const { index, garment } of chosen) {
      if (loudness(garment) > 0) clashing.add(index);
    }
  }
  return { steps, unfixed: [...clashing].sort((a, b) => a - b) };
}

/**
 * Each matched piece's step down its ranking: the set that strays least and
 * goes together; failing that, without the pieces left with no garment of
 * their own (two pieces, one garment), whose duplicate alone would sink
 * every set; failing that, the closest kept and the clash named.
 */
function chosenSteps<G extends RecreateGarment>(
  matched: readonly { index: number; ranking: Scored<G>[]; loud: number }[],
  judge: Judge,
): { steps: Map<number, number>; unfixed: number[] } {
  const found = repick(matched, judge);
  if (found) return { steps: found, unfixed: [] };
  const kept = closestKept(matched, judge);
  const placed = matched.filter((m) => kept.steps.has(m.index));
  const without = placed.length < matched.length && repick(placed, judge);
  return without ? { steps: without, unfixed: [] } : kept;
}

export function recreateLook<G extends RecreateGarment>(
  request: RecreateRequest<G>,
): Recreation<G> {
  const rankings = request.pieces.map((piece) => ranked(piece, request.closet));
  const matched = request.pieces.flatMap((piece, index) =>
    rankings[index].length > 0
      ? [{ index, ranking: rankings[index], loud: loudness(piece) }]
      : [],
  );
  const judge = judgeOf(request);
  const { steps, unfixed } = chosenSteps(matched, judge);
  return {
    pieces: rankings.map((ranking, index) => {
      const step = steps.get(index);
      if (step === undefined) return { matches: [], repicked: false };
      const chosen = ranking[step];
      return {
        matches: [chosen, ...ranking.filter((s) => s !== chosen)]
          .slice(0, MATCHES_PER_PIECE)
          .map(({ garment, agrees }) => ({ garment, agrees })),
        repicked: step > 0,
      };
    }),
    unfixed,
  };
}
