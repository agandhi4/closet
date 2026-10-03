import { describe, expect, it } from 'vitest';
import {
  agentRewriteEvent,
  LOOK_REACTION_EVENTS,
  LOOK_REACTIONS,
  type LookNoteEffect,
  type LookReaction,
  type LookReactionEvent,
  lookReactionTransition,
} from './look-reaction';

/** Every edge the machine allows, as (from, event, to, note). */
const ALLOWED: [
  LookReaction,
  LookReactionEvent,
  LookReaction,
  LookNoteEffect,
][] = [
  ['proposed', 'love', 'loved', 'clear'],
  ['revise', 'love', 'loved', 'clear'],
  ['proposed', 'change', 'revise', 'write'],
  ['loved', 'change', 'revise', 'write'],
  ['proposed', 'decline', 'declined', 'write'],
  ['revise', 'decline', 'declined', 'write'],
  ['loved', 'decline', 'declined', 'write'],
  ['revise', 'repropose', 'proposed', 'keep'],
  ['loved', 'repropose', 'proposed', 'keep'],
  ['declined', 'reconsider', 'proposed', 'clear'],
];

const allowed = (reaction: LookReaction, event: LookReactionEvent) =>
  ALLOWED.some(([from, on]) => from === reaction && on === event);

/** Every (reaction, event) pair the machine refuses. */
const REFUSED = LOOK_REACTIONS.flatMap((reaction) =>
  LOOK_REACTION_EVENTS.filter((event) => !allowed(reaction, event)).map(
    (event) => [reaction, event] as const,
  ),
);

describe('look reaction machine', () => {
  it.each(ALLOWED)('%s --%s--> %s (note: %s)', (from, event, to, note) => {
    expect(lookReactionTransition(from, event)).toEqual({
      ok: true,
      from,
      to,
      note,
    });
  });

  it.each(REFUSED)('refuses %s on %s', (reaction, event) => {
    expect(lookReactionTransition(reaction, event)).toEqual({
      ok: false,
      reaction,
    });
  });

  it('checks every pair: 4 reactions by 5 events', () => {
    expect(ALLOWED.length + REFUSED.length).toBe(20);
  });

  it('never moves a look to where it already is', () => {
    for (const [from, , to] of ALLOWED) expect(to).not.toBe(from);
  });

  it('an agent rewrite: a content edit of a proposal, else a repropose a declined look refuses', () => {
    expect(agentRewriteEvent('proposed')).toBeNull();
    for (const reaction of ['revise', 'loved'] as const) {
      expect(
        lookReactionTransition(reaction, agentRewriteEvent(reaction)!),
      ).toMatchObject({ ok: true, to: 'proposed', note: 'keep' });
    }
    expect(
      lookReactionTransition('declined', agentRewriteEvent('declined')!),
    ).toEqual({ ok: false, reaction: 'declined' });
  });
});
