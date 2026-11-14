import { Type } from '@sinclair/typebox';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { ROW_ID_MAX } from '../schemas';
import { KEYWORD_RANKS, type KeywordRank } from './keyword-search';

/**
 * Where a grid page ended (gridPage, garmentSummaries): the last row's id
 * and its keywordRank, 0 outside a keyword search. The rank travels in the
 * cursor and is never read back from the cursor's row: a lookup by the
 * client's id read a garment of any wardrobe (whether a stranger's private
 * name, brand or notes held a word showed in the page, #784), and an edit to
 * that garment between pages moved the keyset under the next one, skipping
 * rows. Compared only against the addressed wardrobe's rows, a forged cursor
 * reorders nothing but the caller's own view.
 */
export interface GridCursor {
  rank: KeywordRank;
  id: number;
}

/**
 * A cursor as the grid's `before=` and search_garments' `before` / `next`
 * spell it: the bare id at rank 0, so every unranked cursor (the warm
 * list's, a page cached before #673) is the id it always was, else
 * `<rank>.<id>`. The API wraps it as rankedIdCursor (api/resource.ts).
 */
export const GRID_CURSOR_PATTERN = /^(?:([1-9])\.)?([1-9][0-9]{0,9})$/;

export const GridCursorParam = Type.String({
  pattern: GRID_CURSOR_PATTERN.source,
  maxLength: 12,
});

export function gridCursorText({ rank, id }: GridCursor): string {
  return rank === 0 ? String(id) : `${rank}.${id}`;
}

/**
 * The cursor `text` spells; one GRID_CURSOR_PATTERN matches but no page answered
 * (a rank keywordRank never gives, an id past ROW_ID_MAX) is a 400.
 */
export function readGridCursor(text: string): GridCursor {
  const match = GRID_CURSOR_PATTERN.exec(text);
  const id = match ? Number(match[2]) : 0;
  const rank = KEYWORD_RANKS.find((value) => value === Number(match?.[1] ?? 0));
  if (rank === undefined || id < 1 || id > ROW_ID_MAX) {
    throw new HttpError(400, t('api.BAD_CURSOR'));
  }
  return { rank, id };
}
