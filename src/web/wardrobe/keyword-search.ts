import {
  and,
  arrayOverlaps,
  ilike,
  inArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  GARMENT_COLORS,
  GARMENT_TYPES,
  GarmentCategory,
  type GarmentColor,
} from '../../wardrobe/properties';
import { categoryLabel } from './garment';
import { valueLabel } from './labels';

/**
 * The search box's keyword (#673), the one predicate the grid, GET
 * /api/v1/garments and MCP's search_garments share through gridWhere and
 * the page order (queries.ts). The keyword is split on whitespace and every
 * token must start a word of one of the garment's texts (startsAWord:
 * punctuation folded on both sides, so "jcrew" finds "J.Crew"): its name,
 * brand, notes or category, or the label (or key) of one of its colours or
 * its type. Colours, types and built-in categories are stored as keys, so a
 * token is resolved to the keys whose labels match here, before the query:
 * the labels stay in the catalog, never in SQL. Design: grid.md, Search.
 */

/** `garment`'s searched columns, or an alias's (the page cursor's, queries.ts). */
type GarmentTable = Record<
  'name' | 'brand' | 'notes' | 'category' | 'colors' | 'type',
  AnyPgColumn
>;

export interface KeywordToken {
  /**
   * The word folded (fold), or, for one with no letter or digit ("100%" has
   * some, "%" none), the word itself, matched literally: folded it would be
   * empty and match everything.
   */
  text: string;
  folded: boolean;
  colors: GarmentColor[];
  types: string[];
  categories: string[];
}

/**
 * Lower case, letters and digits only: "J.Crew" is "jcrew", "T-shirt"
 * "tshirt".
 */
function fold(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whether a text has a word starting with the token, each word folded: words
 * are split on whitespace only, so "shirt" finds the Shirt type and "Western
 * denim shirt" but not "T-shirt" or "Navy crewneck sweatshirt", "coat" finds
 * "Trench coat", and "jcrew" finds "J.Crew". contains is the same rule in
 * Postgres; the two must agree.
 */
function startsAWord(text: string, token: string): boolean {
  return text.split(/\s+/).some((word) => fold(word).startsWith(token));
}

function matching<T extends string>(
  values: readonly T[],
  label: (value: T) => string,
  token: string,
): T[] {
  return values.filter(
    (value) => startsAWord(label(value), token) || startsAWord(value, token),
  );
}

const TYPE_VALUES = [
  ...new Set(
    Object.values(GARMENT_TYPES).flatMap((types) =>
      types.map(({ value }) => value),
    ),
  ),
];
const CATEGORIES = Object.values(GarmentCategory);

/** The keyword's tokens with the keys each one names; none for a blank one. */
export function keywordTokens(keyword: string | undefined): KeywordToken[] {
  return (keyword ?? '')
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word): KeywordToken => {
      const folded = fold(word);
      if (folded === '') {
        return {
          text: word,
          folded: false,
          colors: [],
          types: [],
          categories: [],
        };
      }
      return {
        text: folded,
        folded: true,
        colors: matching(
          GARMENT_COLORS,
          (color) => valueLabel('color', color),
          folded,
        ),
        types: matching(
          TYPE_VALUES,
          (type) => valueLabel('type', type),
          folded,
        ),
        categories: matching(CATEGORIES, categoryLabel, folded),
      };
    });
}

/** `text` with LIKE's own wildcards taken literally (the default escape, `\\`). */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * A text column matching the token. A folded token starts a word of the
 * column folded the same way, word by word: lower case, punctuation dropped
 * within words, words split on whitespace (startsAWord in Postgres; " " is
 * prepended so the first word starts after one). [:alnum:] is
 * Unicode-aware in a UTF-8 database, as \p{L}\p{N} is. A punctuation-only
 * token is contained as itself ("%" finds a name with a percent sign, not
 * every garment). A filter over one wardrobe's rows (hundreds): no index or
 * stored folded column at household size.
 */
function contains(column: AnyPgColumn, token: KeywordToken): SQL {
  if (!token.folded) return ilike(column, `%${likeLiteral(token.text)}%`);
  const words = sql`' ' || regexp_replace(regexp_replace(lower(${column}), '[^[:alnum:][:space:]]+', '', 'g'), '[[:space:]]+', ' ', 'g')`;
  return sql`${words} like ${`% ${likeLiteral(token.text)}%`}`;
}

/**
 * The token matched by anything but the notes: the name, the brand, the
 * category (stored text, so a custom category, its own label, matches too),
 * or a key its labels resolved to.
 */
function strongMatch(table: GarmentTable, token: KeywordToken): SQL {
  return or(
    contains(table.name, token),
    contains(table.brand, token),
    contains(table.category, token),
    token.colors.length > 0
      ? arrayOverlaps(table.colors, token.colors)
      : undefined,
    token.types.length > 0 ? inArray(table.type, token.types) : undefined,
    token.categories.length > 0
      ? inArray(table.category, token.categories)
      : undefined,
  )!;
}

/** Every token matches one of the garment's texts, the notes included. */
export function keywordMatch(
  table: GarmentTable,
  tokens: readonly KeywordToken[],
): SQL {
  return and(
    ...tokens.map(
      (token) => or(strongMatch(table, token), contains(table.notes, token))!,
    ),
  )!;
}

/**
 * 0 when every token matched something other than the notes, 1 when one
 * matched only them: the page sorts by it first, so a garment the keyword
 * names ranks above one whose notes merely mention it. For a matching row
 * only (keywordMatch); a null name or brand falls to 1, never to null.
 */
export function keywordRank(
  table: GarmentTable,
  tokens: readonly KeywordToken[],
): SQL<number> {
  const strong = and(...tokens.map((token) => strongMatch(table, token)))!;
  return sql<number>`case when ${strong} then 0 else 1 end`;
}
