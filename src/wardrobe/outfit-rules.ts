import type {
  GarmentCategory,
  GarmentColor,
  GarmentRole,
  Pattern,
} from './properties';

/**
 * Outfit rules (#21; docs/plans/2026-11-12-generator-rules.md): the owner's
 * "never A with B" and "always B with A", each side a matcher. Pure: what a
 * rule is, what matching a side means, and the checks the generator
 * (generator.ts) compiles once a request from them. Stored in `outfit_rule`
 * (src/db/schema.ts builds its checks from these sets); generator_avoid's
 * pairs join the same list as never-rules of two garments (avoidedPairRule),
 * so the generator enforces every rule in one place. The owner's own, like
 * the style profile: a grantee's ideas over a shared wardrobe use none.
 */

export const OUTFIT_RULE_KINDS = ['never', 'always'] as const;
export type OutfitRuleKind = (typeof OUTFIT_RULE_KINDS)[number];

/** One side of a rule: a garment, a category (and maybe its type), a colour or a pattern. */
export type RuleMatcher =
  | { by: 'garment'; garmentId: number }
  | { by: 'category'; category: GarmentCategory; type: string | null }
  | { by: 'color'; color: GarmentColor }
  | { by: 'pattern'; pattern: Pattern };

/**
 * - never: no outfit holds a garment matching `a` and another garment
 *   matching `b` (either way round). Adding a garment never mends a broken
 *   one, so the generator's early pruning stays sound.
 * - always: an outfit holding a garment matching `a` also holds another
 *   matching `b`, when one can be drawn into it (alwaysCheck); otherwise the
 *   rule is moot, so an always-rule never empties the ideas.
 */
export interface OutfitRule {
  kind: OutfitRuleKind;
  a: RuleMatcher;
  b: RuleMatcher;
}

/** What a matcher reads of a garment, and the role its slot is. */
export interface RuleGarment {
  id: number;
  role: GarmentRole;
  category: string;
  type: string | null;
  colors: readonly GarmentColor[];
  pattern: Pattern | null;
}

type GarmentTest = (garment: RuleGarment) => boolean;

/** A matcher as a predicate, its kind decided once rather than on every garment of every draw. */
function matcherTest(matcher: RuleMatcher): GarmentTest {
  switch (matcher.by) {
    case 'garment': {
      const { garmentId } = matcher;
      return (g) => g.id === garmentId;
    }
    case 'category': {
      // A stored category is any text (custom ones too): compared as one.
      const category: string = matcher.category;
      const { type } = matcher;
      return type === null
        ? (g) => g.category === category
        : (g) => g.category === category && g.type === type;
    }
    case 'color': {
      const { color } = matcher;
      return (g) => g.colors.includes(color);
    }
    case 'pattern': {
      const { pattern } = matcher;
      return (g) => g.pattern === pattern;
    }
  }
}

/** A generator_avoid pair ("Clashes") as the never-rule it is. */
export function avoidedPairRule(a: number, b: number): OutfitRule {
  return {
    kind: 'never',
    a: { by: 'garment', garmentId: a },
    b: { by: 'garment', garmentId: b },
  };
}

/** One side of an outfit_rule row: exactly one matcher column set (the table's checks). */
export interface StoredMatcher {
  garmentId: number | null;
  category: GarmentCategory | null;
  type: string | null;
  color: GarmentColor | null;
  pattern: Pattern | null;
}

export function storedMatcher(side: StoredMatcher): RuleMatcher {
  if (side.garmentId !== null) {
    return { by: 'garment', garmentId: side.garmentId };
  }
  if (side.category !== null) {
    return { by: 'category', category: side.category, type: side.type };
  }
  if (side.color !== null) return { by: 'color', color: side.color };
  if (side.pattern !== null) return { by: 'pattern', pattern: side.pattern };
  // outfit_rule_a_check and _b_check make this unreachable.
  throw new Error('An outfit_rule side has no matcher');
}

/**
 * A rule's sides in the order it is stored (#21b). "Never A with B" is
 * "never B with A" (compileRules checks a pair both ways round), so a
 * never-rule's sides are put in one order and outfit_rule's unique index
 * refuses the mirror as a duplicate; an always-rule is directional and
 * keeps its order. The order compares the columns as the index does.
 */
export function storedSides<S extends StoredMatcher>(
  kind: OutfitRuleKind,
  a: S,
  b: S,
): [S, S] {
  return kind === 'never' && compareSides(a, b) > 0 ? [b, a] : [a, b];
}

function compareSides(a: StoredMatcher, b: StoredMatcher): number {
  const ids = (a.garmentId ?? 0) - (b.garmentId ?? 0);
  if (ids !== 0) return ids;
  for (const key of ['category', 'type', 'color', 'pattern'] as const) {
    const [x, y] = [a[key] ?? '', b[key] ?? ''];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

interface CompiledRule {
  rule: OutfitRule;
  a: GarmentTest;
  b: GarmentTest;
}

/** The never-rules (by index) whose `a` and whose `b` a garment matches. */
interface Sides {
  a: readonly number[];
  b: readonly number[];
}

/**
 * The rules of one request, compiled once (generateIdeas): each matcher a
 * predicate, and each garment's never-rule sides worked out the first time
 * it is met and kept (a request judges the same few dozen garments
 * thousands of times), so judging a pair is a scan of a few indices.
 */
export interface CompiledRules {
  /** Whether two different garments break a never-rule together. */
  clash(g: RuleGarment, h: RuleGarment): boolean;
  /** The never-rules garments break among themselves, each once, in rule order. */
  brokenAmong(garments: readonly RuleGarment[]): OutfitRule[];
  readonly always: readonly CompiledRule[];
}

export function compileRules(rules: readonly OutfitRule[]): CompiledRules {
  const compiled = rules.map((rule) => ({
    rule,
    a: matcherTest(rule.a),
    b: matcherTest(rule.b),
  }));
  const never = compiled.filter(({ rule }) => rule.kind === 'never');
  const sides = new Map<number, Sides>();
  const sidesOf = (garment: RuleGarment): Sides => {
    let found = sides.get(garment.id);
    if (!found) {
      found = indicesOf(never, garment);
      sides.set(garment.id, found);
    }
    return found;
  };
  const clashing = (g: RuleGarment, h: RuleGarment): number[] => {
    const [sg, sh] = [sidesOf(g), sidesOf(h)];
    return [
      ...sg.a.filter((i) => sh.b.includes(i)),
      ...sh.a.filter((i) => sg.b.includes(i)),
    ];
  };
  return {
    clash: (g, h) => {
      const [sg, sh] = [sidesOf(g), sidesOf(h)];
      return (
        sg.a.some((i) => sh.b.includes(i)) || sh.a.some((i) => sg.b.includes(i))
      );
    },
    brokenAmong: (garments) => {
      const broken = new Set(
        pairsOf(garments).flatMap(([g, h]) => clashing(g, h)),
      );
      return never.filter((_, i) => broken.has(i)).map(({ rule }) => rule);
    },
    always: compiled.filter(({ rule }) => rule.kind === 'always'),
  };
}

function indicesOf(rules: readonly CompiledRule[], garment: RuleGarment) {
  const sides = { a: [] as number[], b: [] as number[] };
  rules.forEach((rule, i) => {
    if (rule.a(garment)) sides.a.push(i);
    if (rule.b(garment)) sides.b.push(i);
  });
  return sides;
}

function pairsOf<G>(garments: readonly G[]): [G, G][] {
  return garments.flatMap((g, i) =>
    garments.slice(i + 1).map((h): [G, G] => [g, h]),
  );
}

/** What decides whether an always-rule's `b` can be drawn into an outfit. */
interface AlwaysContext<G extends RuleGarment> {
  /**
   * The garments a draw may bring in, by role: the generator's pool less
   * the locked garments and anything no idea with the locks can hold.
   */
  drawable: ReadonlyMap<GarmentRole, readonly G[]>;
  lockedIds: ReadonlySet<number>;
  /** The draws add a layer (the weather asks for one and none is locked). */
  layersOffered: boolean;
  /**
   * The colour, pattern and never-rules (the generator's `compatible`): a
   * swap that breaks one cannot keep the rule, so it does not count.
   */
  compatible: (garments: readonly G[]) => boolean;
}

/** A garment matching an always-rule's `b`, and the outfit with it in its role's slot. */
interface Swap<G> {
  mender: G;
  outfit: G[];
}

/** An always-rule an outfit breaks: the garment that asks, and the swaps that would keep it. */
interface UnmetRule<G> {
  /** The rule's index in CompiledRules.always: the repair's seed. */
  index: number;
  asker: G;
  /** Never empty, never the asker, each compatible; in `drawable`'s role and garment order. */
  swaps: readonly Swap<G>[];
}

export interface AlwaysCheck<G extends RuleGarment> {
  /** No always-rule broken that a compatible swap could keep. */
  holds(garments: readonly G[]): boolean;
  /** The first always-rule from `from` on that `garments` break and a compatible swap could keep. */
  unmet(garments: readonly G[], from: number): UnmetRule<G> | undefined;
}

/**
 * The always-rules against one request's draws. A rule's `b` can be drawn
 * into an outfit when a drawable garment matching it (not the asker) takes
 * its role's slot and the outfit still passes `compatible`: the slot is a
 * drawn, unlocked garment of that role to swap, or a layer (added, or
 * replacing the drawn one) while the draws add layers. With no such swap
 * the rule is moot for that outfit, so an always-rule never empties the
 * ideas: a B that clashes with the rest of the outfit leaves it standing
 * (PR #501's review: a striped top asking for the only, striped, shoes).
 * The repair (generator.ts' repairer) picks from these same swaps, so what
 * the check calls mendable is exactly what the repair can mend.
 */
export function alwaysCheck<G extends RuleGarment>(
  rules: readonly CompiledRule[],
  context: AlwaysContext<G>,
): AlwaysCheck<G> {
  const menders = rules.map((rule) =>
    [...context.drawable].map(
      ([role, garments]) => [role, garments.filter(rule.b)] as const,
    ),
  );
  const swapInto = (
    garments: readonly G[],
    role: GarmentRole,
    mender: G,
  ): G[] | undefined => {
    const open = garments.some(
      (g) => g.role === role && !context.lockedIds.has(g.id),
    );
    if (open) {
      return garments.map((g) =>
        g.role === role && !context.lockedIds.has(g.id) ? mender : g,
      );
    }
    return role === 'layer' && context.layersOffered
      ? [...garments, mender]
      : undefined;
  };
  const unmetAt = (
    garments: readonly G[],
    index: number,
  ): UnmetRule<G> | undefined => {
    const rule = rules[index];
    for (const asker of garments) {
      if (
        !rule.a(asker) ||
        garments.some((h) => h.id !== asker.id && rule.b(h))
      ) {
        continue;
      }
      const swaps = menders[index].flatMap(([role, found]) =>
        found.flatMap((mender) => {
          if (mender.id === asker.id) return [];
          const outfit = swapInto(garments, role, mender);
          return outfit && context.compatible(outfit)
            ? [{ mender, outfit }]
            : [];
        }),
      );
      if (swaps.length > 0) return { index, asker, swaps };
    }
    return undefined;
  };
  const unmet = (garments: readonly G[], from: number) => {
    for (let index = from; index < rules.length; index += 1) {
      const found = unmetAt(garments, index);
      if (found) return found;
    }
    return undefined;
  };
  return {
    holds: (garments) => unmet(garments, 0) === undefined,
    unmet,
  };
}
