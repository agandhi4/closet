import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import type { Photos } from '../files/photos';
import type { Logger } from '../../logger';
import { NotFound } from '../refusals';
import type { Actor } from '../sharing/access';
import { setEntryWorn } from '../wears/queries';
import {
  markEntryWorn,
  planOutfit,
  removeEntry,
  requireEntry,
} from './entry-actions';
import {
  deleteEntry,
  entryOf,
  findEntry,
  lockEntryToReplace,
  ownsOutfit,
  scheduleOutfit,
  setEntryOutfit,
} from './queries';
import { replaceEntryOutfit } from './replace';

vi.mock('./queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteEntry: vi.fn(),
  entryOf: vi.fn(),
  findEntry: vi.fn(),
  lockEntryToReplace: vi.fn(),
  ownsOutfit: vi.fn(),
  scheduleOutfit: vi.fn(),
  setEntryOutfit: vi.fn(),
}));
vi.mock('../wears/queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setEntryWorn: vi.fn(),
}));
vi.mock('../auth/queries', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // The owner lock's transaction, run on the same handle.
  ownerTransaction: (
    db: Db,
    _ownerId: number,
    _name: string,
    work: (tx: Db) => Promise<unknown>,
  ) => work(db),
}));

/**
 * The calendar entry path called directly, as the API will call it (#188):
 * entries are private, so a VIEW or MANAGE grantee of the owner's wardrobe
 * is a stranger to the owner's entries. Every query answers for
 * `actor.userId` alone and finds nothing of another's (as the owner-scoped
 * SQL would): the 404 of an unknown id, never a 403, and nothing written
 * (test/integration/authorization-outfits.routes.ts proves the routes).
 */
const OWNER = 1;
const OTHER = 2;
const ENTRY = 40;
const OUTFIT = 30;
const DAY = '2026-11-16';
const db = {} as Db;
const sharedAs = (permission: 'VIEW' | 'MANAGE' | null): Actor => ({
  userId: OTHER,
  shareReadAhead: { ownerId: OWNER, permission },
});
const owner: Actor = { userId: OWNER };
const others: [string, Actor][] = [
  ['a stranger', sharedAs(null)],
  ['a VIEW grantee', sharedAs('VIEW')],
  ['a MANAGE grantee', sharedAs('MANAGE')],
];
const deleteVariants = vi.fn();
const logInfo = vi.fn();
const deps = {
  db,
  photos: { deleteVariants } as unknown as Photos,
  logger: { info: logInfo } as unknown as Logger,
};
const target = { entryId: ENTRY, day: DAY, occasion: 'work' as const };
const unworn = {
  id: ENTRY,
  occasion: 'work' as const,
  outfitId: 31,
  worn: false,
  plannedBy: 'user' as const,
};

/** Each path called as `actor`, with its query answering the miss another user's id gets. */
const paths: [string, string, (actor: Actor) => Promise<unknown>][] = [
  [
    'planOutfit',
    'Outfit not found',
    (actor) => {
      vi.mocked(scheduleOutfit).mockResolvedValue('no-such-outfit');
      return planOutfit(db, actor, {
        outfitId: OUTFIT,
        day: DAY,
        occasion: 'work',
      });
    },
  ],
  [
    'markEntryWorn',
    'Calendar entry not found',
    (actor) => {
      vi.mocked(setEntryWorn).mockResolvedValue('not-found');
      return markEntryWorn(db, actor, {
        entryId: ENTRY,
        worn: true,
        at: new Date(),
        today: DAY,
      });
    },
  ],
  [
    'requireEntry',
    'Calendar entry not found',
    (actor) => {
      vi.mocked(findEntry).mockResolvedValue(undefined);
      return requireEntry(db, actor, { id: ENTRY, day: DAY }, DAY);
    },
  ],
  [
    'removeEntry',
    'Calendar entry not found',
    (actor) => {
      vi.mocked(deleteEntry).mockResolvedValue('not-found');
      return removeEntry(deps, actor, ENTRY);
    },
  ],
  [
    'replaceEntryOutfit',
    'Calendar entry not found',
    (actor) => {
      vi.mocked(lockEntryToReplace).mockResolvedValue(undefined);
      return replaceEntryOutfit(db, actor, target, { outfitId: OUTFIT });
    },
  ],
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("another user's entry is not found, whatever they share", () => {
  for (const [who, actor] of others) {
    it.each(paths)(`%s: ${who}`, async (_name, message, call) => {
      const refused = call(actor);
      await expect(refused).rejects.toBeInstanceOf(NotFound);
      await expect(refused).rejects.toMatchObject({ statusCode: 404, message });
      expect(setEntryOutfit).not.toHaveBeenCalled();
      expect(deleteVariants).not.toHaveBeenCalled();
    });
  }

  it("asks every query for the actor's own entries, never the share's owner's", async () => {
    const [, manager] = others[2];
    for (const [, , call] of paths) await call(manager).catch(() => undefined);
    expect(scheduleOutfit).toHaveBeenCalledWith(db, {
      ownerId: OTHER,
      outfitId: OUTFIT,
      day: DAY,
      occasion: 'work',
    });
    expect(setEntryWorn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ entryId: ENTRY, ownerId: OTHER }),
    );
    expect(findEntry).toHaveBeenCalledWith(
      db,
      OTHER,
      { id: ENTRY, day: DAY },
      DAY,
    );
    expect(deleteEntry).toHaveBeenCalledWith(db, ENTRY, OTHER);
    expect(lockEntryToReplace).toHaveBeenCalledWith(db, OTHER, target);
  });
});

describe('a replace refuses with nothing changed', () => {
  it("refuses an outfit that is not the actor's", async () => {
    vi.mocked(lockEntryToReplace).mockResolvedValue(unworn);
    vi.mocked(ownsOutfit).mockResolvedValue(false);
    await expect(
      replaceEntryOutfit(db, owner, target, { outfitId: OUTFIT }),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Outfit not found',
      logDetail: `Calendar entry ${ENTRY} (${DAY} work) not changed for user ${OWNER}: the outfit is not theirs`,
    });
    expect(setEntryOutfit).not.toHaveBeenCalled();
  });

  it('refuses a worn entry before it looks at the choice (409)', async () => {
    vi.mocked(lockEntryToReplace).mockResolvedValue({ ...unworn, worn: true });
    await expect(
      replaceEntryOutfit(db, owner, target, { outfitId: OUTFIT }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(ownsOutfit).not.toHaveBeenCalled();
  });

  it('refuses an outfit already on the day, naming its occasion (409)', async () => {
    vi.mocked(lockEntryToReplace).mockResolvedValue(unworn);
    vi.mocked(ownsOutfit).mockResolvedValue(true);
    vi.mocked(entryOf).mockResolvedValue({ id: 41, occasion: 'evening' });
    await expect(
      replaceEntryOutfit(db, owner, target, { outfitId: OUTFIT }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Evening'),
    });
    expect(setEntryOutfit).not.toHaveBeenCalled();
  });
});

describe('the entry path for its owner', () => {
  it("answers a day still to come for each surface's own word", async () => {
    vi.mocked(setEntryWorn).mockResolvedValue('future');
    await expect(
      markEntryWorn(db, owner, {
        entryId: ENTRY,
        worn: true,
        at: new Date(),
        today: DAY,
      }),
    ).resolves.toBe('future');
  });

  it('deletes the selfie bytes only after the entry is gone', async () => {
    vi.mocked(deleteEntry).mockResolvedValue({ selfies: ['abc.jpg'] });
    await removeEntry(deps, owner, ENTRY);
    expect(deleteVariants).toHaveBeenCalledOnce();
    expect(logInfo).toHaveBeenCalledWith(
      `Calendar entry ${ENTRY} deleted by user ${OWNER} with its selfie abc.jpg`,
    );
  });
});
