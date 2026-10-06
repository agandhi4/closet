import { eq, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { styleProfile } from '../../db/schema';
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
