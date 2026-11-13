import { type AnyColumn, eq, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { outfitRule, styleProfile } from '../../db/schema';
import {
  type OutfitRule,
  type OutfitRuleKind,
  type StoredMatcher,
  storedMatcher,
} from '../../wardrobe/outfit-rules';
import type { StyleProfileFields } from './validation';

/**
 * The user's style profile as a scalar subquery (null when never saved),
 * for a read that takes it with others in one statement: get_style_profile
 * (#172) and the style page (#251) read it with the week template. Every
 * field is JSON as stored (text and text arrays).
 */
export function styleProfileSql(
  userId: number,
): SQL<StyleProfileFields | null> {
  return sql<StyleProfileFields | null>`(
    select json_build_object(
      'styles', ${styleProfile.styles},
      'budget', ${styleProfile.budget},
      'palette', ${styleProfile.palette},
      'notes', ${styleProfile.notes}
    )
    from ${styleProfile} where ${eq(styleProfile.userId, userId)})`;
}

/** The one writer of a style profile (the page's post and the seed): the row upserted. */
export async function saveStyleProfile(
  db: Queryable,
  userId: number,
  fields: StyleProfileFields,
): Promise<void> {
  await db
    .insert(styleProfile)
    .values({ userId, ...fields })
    .onConflictDoUpdate({
      target: styleProfile.userId,
      set: { ...fields, updatedAt: sql`now()` },
    });
}

/** One side of an outfit_rule row as outfitRulesSql's JSON (StoredMatcher's columns, in order). */
type StoredSide = [
  garmentId: StoredMatcher['garmentId'],
  category: StoredMatcher['category'],
  type: StoredMatcher['type'],
  color: StoredMatcher['color'],
  pattern: StoredMatcher['pattern'],
];

/** An outfit_rule row as outfitRulesSql's JSON, read back by readOutfitRules. */
export type OutfitRuleRow = [
  kind: OutfitRuleKind,
  a: StoredSide,
  b: StoredSide,
];

/**
 * The owner's outfit rules (#21) as a scalar subquery, oldest first, read
 * back with readOutfitRules: the generator's memory reads them beside the
 * avoided pairs (generatorMemorySql, src/web/gallery/queries.ts), so every
 * ideas surface has them without a statement of its own. Arrays, not
 * objects: json_agg of rows would carry the column names in every element.
 * Only ever the signed-in owner's: no share reads another's rules.
 */
export function outfitRulesSql(ownerId: number): SQL<OutfitRuleRow[]> {
  // StoredSide's order.
  const side = (columns: readonly AnyColumn[]) =>
    sql`json_build_array(${sql.join([...columns], sql`, `)})`;
  const { aGarmentId, aCategory, aType, aColor, aPattern } = outfitRule;
  const { bGarmentId, bCategory, bType, bColor, bPattern } = outfitRule;
  return sql<OutfitRuleRow[]>`(
    select coalesce(json_agg(json_build_array(
      ${outfitRule.kind},
      ${side([aGarmentId, aCategory, aType, aColor, aPattern])},
      ${side([bGarmentId, bCategory, bType, bColor, bPattern])}
    ) order by ${outfitRule.id}), '[]')
    from ${outfitRule}
    where ${eq(outfitRule.ownerId, ownerId)}
  )`;
}

export function readOutfitRules(rows: readonly OutfitRuleRow[]): OutfitRule[] {
  return rows.map(([kind, a, b]) => ({
    kind,
    a: storedMatcher(sideOf(a)),
    b: storedMatcher(sideOf(b)),
  }));
}

function sideOf([
  garmentId,
  category,
  type,
  color,
  pattern,
]: StoredSide): StoredMatcher {
  return { garmentId, category, type, color, pattern };
}
