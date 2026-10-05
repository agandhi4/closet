import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  garment,
  museRound,
  outfit,
  personalAccessToken,
} from '../../db/schema';
import { ownerTransaction } from '../auth/queries';
import { museOutfitWaiting } from '../outfits/proposals';
import { moveFeedbackCursor } from './feedback';
import { OPEN_PICKS } from './inbox';

/**
 * Muse's rounds (#337; docs/plans/2026-10-05-muse-suggestions.md section
 * 4 A): the agent ends a round of suggestions with finish_round, which
 * stores when (muse_round) and nothing of what: a round is the agent's
 * outfits proposed and options suggested in (`since`, `finished_at`],
 * counted on every read, so Today's card shrinks as the owner decides and
 * goes at zero, with nothing to dismiss. One writer, finishRound; one
 * read, museRoundSql (Today's statement).
 */

/** The agent's one line about a round. */
export const ROUND_SUMMARY_MAX = 140;

/** What a round brought that still waits on the owner. */
export interface RoundCounts {
  /** Its outfits not decided yet (museOutfitWaiting). */
  outfits: number;
  /** Its options of needs still open, still wanted (OPEN_PICKS). */
  pieces: number;
}

/** The latest round as Today's card shows it. */
export interface MuseRound extends RoundCounts {
  id: number;
  /** The token's name ("Muse"); null once the token is gone. */
  agent: string | null;
  summary: string | null;
}

/** `time` inside the round (`since`, `until`]: a null `since` is the beginning. */
function inRound(time: SQL, since: SQL, until: SQL) {
  return sql`(${time} > coalesce(${since}, '-infinity'::timestamptz) and ${time} <= ${until})`;
}

/** The two counts of a round over (`since`, `until`], for owner `ownerId`. */
function countsSql(ownerId: number, since: SQL, until: SQL) {
  return {
    outfits: sql<number>`(select count(*)::int from ${outfit} where ${and(
      eq(outfit.ownerId, ownerId),
      museOutfitWaiting(),
      inRound(sql`${outfit.proposedAt}`, since, until),
    )})`,
    pieces: sql<number>`(select count(*)::int from ${garment} where ${and(
      eq(garment.ownerId, ownerId),
      OPEN_PICKS,
      inRound(sql`${garment.suggestedAt}`, since, until),
    )})`,
  };
}

const latest = sql.identifier('latest');

/**
 * The owner's latest round while any of it still waits (null otherwise),
 * as a scalar subquery: Today reads it beside the day in one statement
 * (todayFor's `needs`, src/web/today/today.ts).
 */
export function museRoundSql(ownerId: number): SQL<MuseRound | null> {
  const counts = countsSql(
    ownerId,
    sql`${latest}.since`,
    sql`${latest}.finished_at`,
  );
  return sql<MuseRound | null>`(
    select case when counted.outfits + counted.pieces = 0 then null else json_build_object(
      'id', counted.id,
      'agent', counted.agent,
      'summary', counted.summary,
      'outfits', counted.outfits,
      'pieces', counted.pieces
    ) end
    from (
      select ${latest}.id, ${latest}.summary,
        (select ${personalAccessToken.name} from ${personalAccessToken}
          where ${personalAccessToken.id} = ${latest}.token_id) as agent,
        ${counts.outfits} as outfits,
        ${counts.pieces} as pieces
      from ${museRound} as ${latest}
      where ${latest}.owner_id = ${ownerId}
      order by ${latest}.finished_at desc, ${latest}.id desc
      limit 1
    ) as counted
  )`;
}

export type FinishOutcome =
  /** The round stored: what it brought. */
  | ({ ok: true; id: number; agent: string | null } & RoundCounts)
  /** Nothing new since the last round: no round, so no card and no notification. */
  | { ok: false; reason: 'empty' };

/**
 * The one writer of a round (finish_round): under the owner lock, the
 * owner's previous round's end, what was proposed and suggested since,
 * and the round inserted only when that is something, in one statement;
 * then, when the agent hands back its feedback read's `until`, its cursor
 * moved past what it was told (moveFeedbackCursor), round or not, so a
 * conversation that only read the feedback still ends it. The caller
 * notifies after the commit.
 */
export function finishRound(
  db: Queryable,
  ownerId: number,
  round: {
    tokenId: number;
    summary: string | null;
    feedbackUntil: string | null;
  },
): Promise<FinishOutcome> {
  return ownerTransaction(db, ownerId, 'finishRound', async (tx) => {
    const since = sql`(select finished_at from previous)`;
    const counts = countsSql(ownerId, since, sql`now()`);
    const { rows } = await tx.execute<{
      id: number | null;
      agent: string | null;
      outfits: number;
      pieces: number;
    }>(sql`
      with previous as (
        select ${museRound.finishedAt} as finished_at from ${museRound}
        where ${eq(museRound.ownerId, ownerId)}
        order by ${museRound.finishedAt} desc, ${museRound.id} desc
        limit 1
      ),
      counted as (
        select ${counts.outfits} as outfits, ${counts.pieces} as pieces
      ),
      created as (
        insert into ${museRound} (owner_id, token_id, since, summary)
        select ${ownerId}::int, ${round.tokenId}::int, ${since}, ${round.summary}::text
        from counted where counted.outfits + counted.pieces > 0
        returning id
      )
      select (select id from created) as id,
        (select ${personalAccessToken.name} from ${personalAccessToken}
          where ${eq(personalAccessToken.id, round.tokenId)}) as agent,
        counted.outfits, counted.pieces
      from counted`);
    const [row] = rows;
    if (round.feedbackUntil !== null) {
      await moveFeedbackCursor(tx, round.tokenId, round.feedbackUntil);
    }
    if (row.id === null) return { ok: false, reason: 'empty' };
    return {
      ok: true,
      id: row.id,
      agent: row.agent,
      outfits: row.outfits,
      pieces: row.pieces,
    };
  });
}
