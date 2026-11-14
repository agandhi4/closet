import { describe, expect, it } from 'vitest';
import { removalAsksFirst } from './removal';

describe('removalAsksFirst', () => {
  const unworn = {
    worn: false,
    plannedBy: 'user',
    takesOutfit: false,
  } as const;

  it('lets an unworn entry of the person or the planner go at once', () => {
    expect(removalAsksFirst(unworn)).toBe(false);
    expect(removalAsksFirst({ ...unworn, plannedBy: 'auto' })).toBe(false);
  });

  it.each([
    ['a worn entry', { worn: true }],
    ["an agent's entry", { plannedBy: 'agent' }],
    ['an entry that takes its one-off outfit', { takesOutfit: true }],
  ] as const)('asks first for %s', (_name, change) => {
    expect(removalAsksFirst({ ...unworn, ...change })).toBe(true);
  });
});
