import { type Static, Type } from '@sinclair/typebox';
import { type AnyColumn, sql, type SQL } from 'drizzle-orm';
import { personalAccessToken, user } from '../db/schema';
import { t } from './i18n';

/**
 * Who made a write (#682): the person (a page, /api/v1 with a device token)
 * or the owner's agent over MCP, by its token's row id. A required argument
 * of every writer that stamps a row with it (the calendar's entries, a
 * trip's outfits, outfits, garments), so a caller that forgets it fails to
 * compile; MCP builds it with `originOf(ctx)` (src/web/mcp/tool.ts), every
 * other surface passes BY_PERSON. Which tools stamp what is MCP_WRITES'
 * `attribution` (src/web/api/operations.ts).
 */
export interface WriteOrigin {
  agentTokenId: number | null;
}

export const BY_PERSON: WriteOrigin = Object.freeze({ agentTokenId: null });

/**
 * A stamped row's agent as its reader reads it (`agentStampSql`): null for
 * the person's. `author` is the token's user, gone with their account (only
 * a garment can outlive it: a grantee's agent on a shared wardrobe).
 */
export interface AgentStamp {
  author: { id: number; firstName: string | null; tokenName: string } | null;
}

/**
 * The agent behind `tokenColumn` as JSON, null when the row is the person's:
 * one scalar subquery inside the reader's own statement, never a statement
 * of its own. `madeByAgent` says the row is an agent's even with no token
 * left (outfit_calendar's `planned_by = 'agent'` after a set null); without
 * it a non-null id is the mark (the garment's soft reference).
 */
export function agentStampSql(
  tokenColumn: AnyColumn,
  madeByAgent: SQL = sql`${tokenColumn} is not null`,
): SQL<AgentStamp | null> {
  // Aliased by hand: in a single-table select Drizzle writes columns
  // without their table (src/db/AGENTS.md), and the token's `name` would
  // then read as the outer row's.
  return sql<AgentStamp | null>`case when ${madeByAgent} then json_build_object(
    'author', (select json_build_object(
        'id', stamp_token.user_id,
        'firstName', nullif(stamp_author.first_name, ''),
        'tokenName', stamp_token.name)
      from ${personalAccessToken} stamp_token
      inner join ${user} stamp_author on stamp_author.id = stamp_token.user_id
      where stamp_token.id = ${tokenColumn})
  ) end`;
}

/**
 * The agent's name as `viewerId` may see it, the one rule every surface
 * answers (pages, /api/v1, the changes feed, MCP): the token's own user sees
 * the token's name; the wardrobe's owner sees whose agent it was by first
 * name (a grantee's agent on their wardrobe), never an email; anyone else,
 * and anyone once the author's account is gone, sees "Agent".
 */
export function agentName(
  stamp: AgentStamp,
  viewer: { viewerId: number; ownerId: number },
): string {
  const { author } = stamp;
  if (author === null) return t('agent.ANONYMOUS');
  if (author.id === viewer.viewerId) return author.tokenName;
  if (viewer.ownerId === viewer.viewerId && author.firstName !== null) {
    return t('agent.OF_PERSON', { name: author.firstName });
  }
  return t('agent.ANONYMOUS');
}

/**
 * agentName for a row only its owner reads (calendar entries, trips,
 * outfits): only the owner's own tokens write there, so the reader is the
 * author, and sees the token's name (or "Agent" once it is gone).
 */
export function ownAgentName(stamp: AgentStamp): string {
  const viewerId = stamp.author?.id ?? 0;
  return agentName(stamp, { viewerId, ownerId: viewerId });
}

/** The API's and the changes feed's `agent` field: present only on what an agent made. */
export const AgentResource = Type.Object(
  {
    name: Type.String({
      description:
        'Your token\'s name when it was yours, "<first name>\'s agent" for a grantee\'s agent on your wardrobe, else "Agent"',
    }),
  },
  {
    title: 'Agent',
    description:
      'The agent that made it over MCP, by its personal access token (absent: a person did)',
  },
);

export function toAgentResource(
  stamp: AgentStamp | null,
  name: (stamp: AgentStamp) => string,
): Static<typeof AgentResource> | undefined {
  return stamp === null ? undefined : { name: name(stamp) };
}
