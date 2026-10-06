import { seededRandom } from '../random';
import {
  assessOutfit,
  type FitProblem,
  type MatchGarment,
  type WeatherNeeds,
} from '../weather/match';
import {
  categoryRole,
  type Formality,
  type GarmentColor,
  type GarmentRole,
  type Pattern,
} from './properties';

/**
 * The outfit generator (#9; docs/plans/2026-09-26-wardrobe-features.md,
 * section 3; the redesign's "Suggest", docs/plans/2026-09-26-redesign.md
 * section 1): whole outfits from a pool of garments, seeded and paged. Pure
 * and the one place suggestion rules live. Its callers:
 * - the Outfits page's Ideas (src/web/gallery), through ideasFor, which
 *   reads the pool, the weather and the owner's rows;
 * - the MCP tool suggest_outfits (src/web/mcp/tools/gallery.ts);
 * - "Goes with my closet" (#18b, src/wardrobe/goes-with.ts): the whole
 *   closet as the pool and one wishlist item `locked`;
 * - Styling's Shuffle (#42, src/web/styling): its locked rows are
 *   `locked`, the unlocked rows take the first idea; Today's suggestions
 *   (#15: a day's occasion, a page of 3).
 *
 * The caller decides the pool: garments in the closet and available
 * (isAvailable / availableGarment, src/wardrobe/availability.ts: not
 * dirty, not away), within a capsule when one is chosen. The generator
 * never widens it. What it decides:
 * - Templates: top + bottom + footwear, or one-piece + footwear; footwear
 *   only when the closet has some (a first-week wardrobe of tees and jeans
 *   still gets ideas). A layer only when the weather asks for one (or it is
 *   locked). Accessories, bags and uncategorised garments are never drawn;
 *   locked, they ride along.
 * - Rotation: each role is drawn weighted toward the garment worn least
 *   recently (days since its last wear day; never worn weighs most), so the
 *   gallery rotates the wardrobe instead of showing the favourites.
 * - Hard rules, never relaxed: at most MAX_ACCENT_COLORS non-neutral
 *   colours and MAX_LOUD_PATTERNS patterned garment; no avoided pair
 *   (generator_avoid, "clashes"); no combination equal to a saved outfit
 *   (compared on the drawn roles, so a saved outfit with a belt still
 *   counts); every locked garment in every idea.
 * - Soft rules, a score: the weather (assessOutfit, src/weather/match.ts)
 *   and the occasion's formality (OCCASION_HINTS, one step per garment
 *   outside the range). Ideas that fit (score 0) come first in draw order;
 *   once the draws run out, the near misses follow, best first, each with
 *   its problems named.
 *
 * Paging is stable: the draws are a sequence keyed by the seed, so page n
 * is the same every time it is asked for (for the same pool), and page 1
 * never changes when page 3 is read. Nothing is materialized: a closet of
 * 40 tops, 20 bottoms and 10 shoes is sampled, at most MAX_DRAWS draws a
 * page.
 */

/** Bump to reshuffle every seed's ideas on purpose. */
export const GENERATOR_VERSION = 1;

/** Draws per page request: bounds the work on a closet with few combinations. */
export const MAX_DRAWS = 2000;

/** Colours that go with anything, on any garment. */
export const NEUTRAL_COLORS: readonly GarmentColor[] = [
  'black',
  'white',
  'grey',
  'beige',
  'brown',
];

/**
 * Whether `color` on a garment of `role` is a neutral for the colour rule:
 * the NEUTRAL_COLORS everywhere, and blue on bottoms too (owner, #9 review:
 * jeans and navy chinos go with anything, and counting them spent one of
 * the two colour slots on nearly every casual outfit). A blue top or layer
 * still counts as a colour. The one place this is decided.
 */
export function neutralFor(role: GarmentRole, color: GarmentColor): boolean {
  return (
    NEUTRAL_COLORS.includes(color) || (role === 'bottom' && color === 'blue')
  );
}
export const MAX_ACCENT_COLORS = 2;
export const MAX_LOUD_PATTERNS = 1;

/** Days unworn from which a garment is "rested" (the card says so). */
export const REST_DAYS = 21;
// Rotation weight: 1 for a garment worn today, rising by one every
// ROTATION_STEP days unworn, up to ROTATION_CAP days (never worn is the cap).
const ROTATION_CAP = 60;
const ROTATION_STEP = 10;

/**
 * The roles the generator draws. Others only arrive locked, so Styling's
 * Shuffle (#42) leaves its unlocked accessory and bag rows as they are.
 */
export const DRAWN_ROLES: readonly GarmentRole[] = [
  'layer',
  'one-piece',
  'top',
  'bottom',
  'footwear',
];

/** How an outfit reads, top to toe: the order of an idea's garments and of a picked outfit's slots. */
export const OUTFIT_ORDER: readonly GarmentRole[] = [
  'layer',
  'one-piece',
  'top',
  'bottom',
  'footwear',
  'accessory',
  'bag',
  'none',
];

/** A role's share of a list, as `topToToe` groups it. */
export interface RoleGroup<T> {
  role: GarmentRole;
  items: T[];
}

/**
 * `items` grouped by their category's role (categoryRole), the groups top
 * to toe (OUTFIT_ORDER, custom categories last as `none`), each keeping
 * the items' order; empty roles left out. A trip's packing list reads a
 * list this way.
 */
export function topToToe<T>(
  items: readonly T[],
  categoryOf: (item: T) => string,
): RoleGroup<T>[] {
  const byRole = new Map<GarmentRole, T[]>();
  for (const item of items) {
    const role = categoryRole(categoryOf(item));
    const group = byRole.get(role);
    if (group) group.push(item);
    else byRole.set(role, [item]);
  }
  return OUTFIT_ORDER.flatMap((role) => {
    const group = byRole.get(role);
    return group ? [{ role, items: group }] : [];
  });
}

export interface IdeaGarment {
  id: number;
  role: GarmentRole;
  /** 'pattern' marks a patterned garment. */
  colors: readonly GarmentColor[];
  pattern: Pattern | null;
  formality: Formality | null;
  /** How it counts for the weather (matchGarment, src/weather/match.ts). */
  weather: MatchGarment;
  /** Whole days since the last day it was worn; null when never. */
  idleDays: number | null;
}

/** A saved outfit's garments, as the duplicate rule compares them. */
export type SavedOutfit = readonly { id: number; role: GarmentRole }[];

/**
 * `G` is the caller's garment (IdeaGarment plus whatever its view needs:
 * a name, a photo); the ideas hand back the very objects of the pool.
 */
export interface IdeaRequest<G extends IdeaGarment = IdeaGarment> {
  seed: number;
  /** Garments the generator may draw (the caller filters availability and scope). */
  pool: readonly G[];
  /** In every idea: `?with=`, Styling's locked rows, #18b's wishlist item. */
  locked?: readonly G[];
  /** What the day's weather asks for the occasion; null without a forecast. */
  needs?: WeatherNeeds | null;
  /** The occasion's formality range; null for any. */
  formality?: { min: Formality; max: Formality } | null;
  /** Garment pairs never to combine (generator_avoid). */
  avoid?: readonly (readonly [number, number])[];
  saved?: readonly SavedOutfit[];
  offset: number;
  limit: number;
}

export type IdeaProblem = FitProblem | 'too-casual' | 'too-dressy';

export interface Idea<G extends IdeaGarment = IdeaGarment> {
  /** In OUTFIT_ORDER. */
  garments: G[];
  /** 0: fits the weather and the occasion. */
  score: number;
  problems: IdeaProblem[];
  /** Garments unworn REST_DAYS or more (or never): what the rotation brought back. */
  rested: number[];
}

export interface IdeaPage<G extends IdeaGarment = IdeaGarment> {
  ideas: Idea<G>[];
  /** Another page follows. */
  more: boolean;
}

interface Template {
  roles: GarmentRole[];
  weight: number;
}

export function generateIdeas<G extends IdeaGarment>(
  request: IdeaRequest<G>,
): IdeaPage<G> {
  const locked = request.locked ?? [];
  const lockedRoles = new Set(locked.map((g) => g.role));
  const byRole = drawableByRole(request.pool, locked);
  const templates = templatesFor(byRole, lockedRoles);
  const rules = hardRules(request);
  // Every idea holds the locked garments, and a garment added never mends a
  // broken rule: locks that break one can make no idea, however long drawn.
  if (templates.length === 0 || !rules.compatible(locked)) {
    return { ideas: [], more: false };
  }

  // A layer only when the weather asks (and none is locked).
  const layers =
    request.needs && !lockedRoles.has('layer')
      ? byLayerPreference(byRole.get('layer') ?? [])
      : [];
  return drawPage(request, {
    draw: drawer(request.seed, templates, byRole, locked),
    bases: baseCount(templates, byRole, lockedRoles),
    floor: scoreFloor(
      templates,
      byRole,
      locked,
      lockedRoles,
      request.formality,
    ),
    layers,
    rules,
  });
}

/** generateIdeas' draws: until the page is settled, then the page. */
function drawPage<G extends IdeaGarment>(
  request: IdeaRequest<G>,
  {
    draw,
    bases,
    floor,
    layers,
    rules,
  }: {
    draw: () => G[];
    bases: number;
    floor: number;
    layers: readonly G[];
    rules: HardRules;
  },
): IdeaPage<G> {
  const want = request.offset + request.limit + 1;
  const fitting: Idea<G>[] = [];
  const nearMisses: Idea<G>[] = [];
  let atFloor = 0;
  const drawn = new Set<string>();
  // The page is settled, and drawing stops, once `want` ideas score the
  // floor: no later draw scores lower, and one that ties ranks after them
  // (ideas that fit keep draw order; near misses sort stably). With a floor
  // of 0 those are the ideas that fit. Past `bases` distinct draws every
  // further draw is a repeat, skipped. Either way the page is the one
  // MAX_DRAWS would give, sooner.
  for (
    let n = 0;
    n < MAX_DRAWS && atFloor < want && drawn.size < bases;
    n += 1
  ) {
    const base = draw();
    const key = keyOf(base);
    if (drawn.has(key)) continue;
    drawn.add(key);
    const idea = bestIdea(base, layers, request, rules);
    if (!idea) continue;
    (idea.score === 0 ? fitting : nearMisses).push(idea);
    if (idea.score === floor) atFloor += 1;
  }
  return pageOf(fitting, nearMisses, request);
}

/**
 * The lowest score any idea can reach: its formality misses, since those
 * add up garment by garment (formalityMiss) and the weather's part is never
 * below 0. The locked garments' misses plus, per template, the smallest
 * miss each open role offers. Above 0 when no idea can fit: the locks
 * already miss the range ("Goes with my closet" locks a wishlist item and
 * asks for its own formality, and a layer of another formality can never
 * make it), or a role has nothing within it.
 */
function scoreFloor(
  templates: readonly Template[],
  byRole: Map<GarmentRole, readonly IdeaGarment[]>,
  locked: readonly IdeaGarment[],
  lockedRoles: Set<GarmentRole>,
  range: IdeaRequest['formality'],
): number {
  if (!range) return 0;
  const missOf = (garments: readonly IdeaGarment[]) =>
    garments.reduce((sum, g) => sum + formalityMiss(g, range), 0);
  const leastMiss = (role: GarmentRole) =>
    Math.min(...(byRole.get(role) ?? []).map((g) => formalityMiss(g, range)));
  return (
    missOf(locked) +
    Math.min(
      ...templates.map((template) =>
        template.roles
          .filter((role) => !lockedRoles.has(role))
          .reduce((sum, role) => sum + leastMiss(role), 0),
      ),
    )
  );
}

/** Formality steps a garment sits outside the range, below or above (0 without one). */
function formalityMiss(
  { formality }: Pick<IdeaGarment, 'formality'>,
  range: { min: Formality; max: Formality },
): number {
  if (formality === null) return 0;
  return (
    Math.max(0, range.min - formality) + Math.max(0, formality - range.max)
  );
}

/**
 * How many distinct bases the templates can draw: per template, the
 * product of its open roles' garments. Templates never share a base (their
 * roles differ), and a role's garments are distinct, so this is the count
 * of distinct keys the draws can reach.
 */
function baseCount(
  templates: readonly Template[],
  byRole: Map<GarmentRole, readonly IdeaGarment[]>,
  lockedRoles: Set<GarmentRole>,
): number {
  return templates.reduce(
    (sum, template) =>
      sum +
      template.roles.reduce(
        (product, role) =>
          lockedRoles.has(role)
            ? product
            : product * (byRole.get(role)?.length ?? 0),
        1,
      ),
    0,
  );
}

/**
 * The requested page: the ideas that fit in draw order, then (only when
 * the draws ran out before the page filled) the near misses, best first.
 */
function pageOf<G extends IdeaGarment>(
  fitting: Idea<G>[],
  nearMisses: Idea<G>[],
  { offset, limit }: { offset: number; limit: number },
): IdeaPage<G> {
  const end = offset + limit;
  // Sort is stable: equal scores keep their draw order.
  const ranked =
    fitting.length > end
      ? fitting
      : [...fitting, ...nearMisses.sort((a, b) => a.score - b.score)];
  return { ideas: ranked.slice(offset, end), more: ranked.length > end };
}

/**
 * The pool by role: only the roles drawn, and never a locked garment twice.
 * Each role's garments in id order, whatever order the pool came in: the
 * draws pick by position, and a pool is a query's rows, whose order
 * Postgres does not promise without ORDER BY (it follows the heap and the
 * plan, which a reseed, an update or an index choice changes). Ordered
 * here, the ideas are a function of the pool as a set; ids keep their
 * relative order across a reseed, which inserts in the same order.
 */
function drawableByRole<G extends IdeaGarment>(
  pool: readonly G[],
  locked: readonly G[],
): Map<GarmentRole, G[]> {
  const lockedIds = new Set(locked.map((g) => g.id));
  const byRole = new Map<GarmentRole, G[]>();
  for (const garment of [...pool].sort((a, b) => a.id - b.id)) {
    if (lockedIds.has(garment.id) || !DRAWN_ROLES.includes(garment.role)) {
      continue;
    }
    const role = byRole.get(garment.role);
    if (role) role.push(garment);
    else byRole.set(garment.role, [garment]);
  }
  return byRole;
}

/**
 * The seed's sequence of bases: a template by weight, then each of its
 * roles the locks leave open, by rotation weight.
 */
function drawer<G extends IdeaGarment>(
  seed: number,
  templates: readonly Template[],
  byRole: Map<GarmentRole, G[]>,
  locked: readonly G[],
): () => G[] {
  const random = seededRandom('generator', GENERATOR_VERSION, seed);
  const templateWeights = templates.map((template) => template.weight);
  const lockedRoles = new Set(locked.map((g) => g.role));
  // Weighed once, not on every draw: a garment's weight never changes
  // within a request.
  const weights = new Map(
    [...byRole].map(([role, choices]) => [role, choices.map(rotationWeight)]),
  );
  return () => {
    const template = templates[random.weighted(templateWeights)];
    const base = [...locked];
    for (const role of template.roles) {
      if (lockedRoles.has(role)) continue;
      // templatesFor offers a role only when the pool has some.
      const choices = byRole.get(role)!;
      base.push(choices[random.weighted(weights.get(role)!)]);
    }
    return base;
  };
}

/**
 * Which templates the pool (and the locks) can fill, each weighted by its
 * anchor garments, so a closet of five dresses and ten tops sees dresses a
 * third of the time. A locked garment of a template's role makes it the
 * only one.
 */
function templatesFor(
  byRole: Map<GarmentRole, readonly IdeaGarment[]>,
  lockedRoles: Set<GarmentRole>,
): Template[] {
  const count = (role: GarmentRole) => byRole.get(role)?.length ?? 0;
  const has = (role: GarmentRole) => lockedRoles.has(role) || count(role) > 0;
  const footwear: GarmentRole[] = has('footwear') ? ['footwear'] : [];
  const templates: Template[] = [];
  const lockedSeparates = lockedRoles.has('top') || lockedRoles.has('bottom');
  const lockedOnePiece = lockedRoles.has('one-piece');
  if (!lockedOnePiece && has('top') && has('bottom')) {
    templates.push({
      roles: ['top', 'bottom', ...footwear],
      weight: lockedSeparates ? 1 : count('top'),
    });
  }
  if (!lockedSeparates && has('one-piece')) {
    templates.push({
      roles: ['one-piece', ...footwear],
      weight: lockedOnePiece ? 1 : count('one-piece'),
    });
  }
  return templates;
}

export function rotationWeight(garment: IdeaGarment): number {
  const idle = Math.min(garment.idleDays ?? ROTATION_CAP, ROTATION_CAP);
  return 1 + idle / ROTATION_STEP;
}

/** A combination's identity: its garment ids, sorted. */
export function keyOf(garments: readonly { id: number }[]): string {
  return garments
    .map((g) => g.id)
    .sort((a, b) => a - b)
    .join(',');
}

/** The part of an outfit the generator draws: what "equal to a saved outfit" compares. */
function drawnKey(garments: readonly { id: number; role: GarmentRole }[]) {
  return keyOf(garments.filter((g) => DRAWN_ROLES.includes(g.role)));
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

type HardRule = (garments: readonly IdeaGarment[]) => boolean;

interface HardRules {
  /**
   * The colour, pattern and clash rules: a garment added never mends one
   * they break (colours and patterns only add up, a clashing pair stays),
   * so what fails here fails with anything added to it.
   */
  compatible: HardRule;
  /** compatible, and not equal to a saved outfit (which a layer can change). */
  passes: HardRule;
}

function hardRules(request: IdeaRequest<IdeaGarment>): HardRules {
  const avoided = new Set((request.avoid ?? []).map(([a, b]) => pairKey(a, b)));
  const saved = new Set((request.saved ?? []).map(drawnKey));
  const compatible: HardRule = (garments) =>
    colorsGoTogether(garments) &&
    !garments.some((a, i) =>
      garments.slice(i + 1).some((b) => avoided.has(pairKey(a.id, b.id))),
    );
  return {
    compatible,
    passes: (garments) =>
      compatible(garments) && !saved.has(drawnKey(garments)),
  };
}

export function isLoud(garment: Pick<IdeaGarment, 'pattern' | 'colors'>) {
  return (
    (garment.pattern !== null && garment.pattern !== 'solid') ||
    garment.colors.includes('pattern')
  );
}

/**
 * At most MAX_ACCENT_COLORS colours beyond the neutrals (neutralFor: blue
 * bottoms included), however many garments carry each, and at most MAX_LOUD_PATTERNS patterned garment
 * (stripes included: a Breton and a plaid do not go).
 */
export function colorsGoTogether(
  garments: readonly Pick<IdeaGarment, 'role' | 'pattern' | 'colors'>[],
): boolean {
  const accents = new Set(
    garments.flatMap((g) =>
      g.colors.filter((c) => c !== 'pattern' && !neutralFor(g.role, c)),
    ),
  );
  const loud = garments.filter(isLoud).length;
  return accents.size <= MAX_ACCENT_COLORS && loud <= MAX_LOUD_PATTERNS;
}

/**
 * The layers in the order a tie between them goes: the most rested, then
 * the oldest id. A total order that does not depend on the base, so
 * bestIdea can try them in it once for every base.
 */
function byLayerPreference<G extends IdeaGarment>(layers: readonly G[]): G[] {
  return [...layers].sort(
    (a, b) => rotationWeight(b) - rotationWeight(a) || a.id - b.id,
  );
}

interface Option<G> {
  garments: G[];
  score: number;
  problems: IdeaProblem[];
}

/**
 * The drawn base with its best layer (or none): of the options that pass
 * the hard rules, the lowest score (the weather and the formality), and
 * among equals no layer, then the layers in preference order
 * (byLayerPreference). Deterministic for a base, so a base is one idea
 * however often it is drawn. Undefined when no option passes the hard
 * rules. Two shortcuts that cannot change the answer: a base that breaks a
 * colour, pattern or clash rule on its own is never scored (no layer mends
 * it), and, trying the options in preference order, the first that scores
 * 0 and passes wins (nothing scores lower). Checking the rules costs about
 * what scoring does, so the rest are scored first and checked best first.
 */
function bestIdea<G extends IdeaGarment>(
  base: readonly G[],
  /** The layers to try, in byLayerPreference order: none without a forecast. */
  layers: readonly G[],
  request: IdeaRequest<G>,
  rules: HardRules,
): Idea<G> | undefined {
  if (!rules.compatible(base)) return undefined;
  const options: Option<G>[] = [];
  for (const layer of [null, ...layers]) {
    const garments = layer ? [...base, layer] : [...base];
    const option = { garments, ...judge(garments, request) };
    if (option.score === 0 && rules.passes(garments)) return ideaOf(option);
    options.push(option);
  }
  // Stable: equal scores keep preference order.
  options.sort((a, b) => a.score - b.score);
  const best = options.find((option) => rules.passes(option.garments));
  return best && ideaOf(best);
}

function ideaOf<G extends IdeaGarment>(option: Option<G>): Idea<G> {
  return {
    garments: inOutfitOrder(option.garments),
    score: option.score,
    problems: option.problems,
    rested: option.garments
      .filter((g) => g.idleDays === null || g.idleDays >= REST_DAYS)
      .map((g) => g.id),
  };
}

function judge(
  garments: readonly IdeaGarment[],
  request: IdeaRequest<IdeaGarment>,
): { score: number; problems: IdeaProblem[] } {
  const problems: IdeaProblem[] = [];
  let score = 0;
  if (request.needs) {
    const fit = assessOutfit(
      request.needs,
      garments.map((g) => g.weather),
    );
    problems.push(...fit.problems);
    score += fit.score;
  }
  // casual + dressy is the sum of formalityMiss over the garments, never
  // below it: scoreFloor's bound depends on it.
  const range = request.formality;
  if (range) {
    let casual = 0;
    let dressy = 0;
    for (const { formality } of garments) {
      if (formality === null) continue;
      casual += Math.max(0, range.min - formality);
      dressy += Math.max(0, formality - range.max);
    }
    if (casual > 0) problems.push('too-casual');
    if (dressy > 0) problems.push('too-dressy');
    score += casual + dressy;
  }
  return { score, problems };
}

function inOutfitOrder<G extends IdeaGarment>(garments: readonly G[]): G[] {
  // Sort is stable: two garments of one role keep their order.
  return [...garments].sort(
    (a, b) => OUTFIT_ORDER.indexOf(a.role) - OUTFIT_ORDER.indexOf(b.role),
  );
}
