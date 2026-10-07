import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionOptions, type DbConfig } from '../../src/db/client';
import { hashPassword } from '../../src/web/auth/passwords';
import { migrateBefore, planTablesLeft } from '../support/migrate-before';
import {
  createTestApp,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
} from './harness';

/**
 * drizzle/0041_muse-outfits.sql (#335) on a database the previous build
 * migrated, holding production in its shape (read-only, 2026-10-05): the
 * owner's draft plan (Muse's, token revoked since) with 8 proposed looks
 * of 28 slots, none empty, every garment the owner's: 6 slots of two owned
 * bottoms and 22 of 16 picks; the owner owns no outfit; the demo persona's
 * hand-made plan (no token) left alone. A third owner's drafted plans hold
 * every other case the data step decides: loved, sent back and declined
 * looks, a look saved as an outfit, two looks of one set, a copied plan, a
 * look whose set is an outfit already, a look with an emptied slot and one
 * with no garment at all. What 0041 made is read before 0045_drop-plans
 * (#337), which drops the plan tables and outfit.plan_look_id; the real app
 * then boots on it (createApp runs 0045, on production's shape) and keeps
 * every outfit.
 */

function configOf(env: Record<string, string>): DbConfig {
  return {
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT),
    database: env.DATABASE_SCHEMA,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASS,
    ssl: false,
  };
}

/**
 * Production's 8 looks (plan 14), by slot: `c` an owned garment (index of
 * two), `p` a pick (index of sixteen), with the slot's category.
 */
const PRODUCTION_LOOKS: [string, string, [string, number, string][]][] = [
  [
    'Weekend casual',
    'daytime',
    [
      ['p', 0, 'tops'],
      ['c', 0, 'bottoms'],
      ['p', 1, 'footwear'],
    ],
  ],
  [
    'Shacket over',
    'daytime',
    [
      ['p', 2, 'outerwear'],
      ['p', 0, 'tops'],
      ['c', 0, 'bottoms'],
      ['p', 1, 'footwear'],
    ],
  ],
  [
    'Merino evening',
    'evening',
    [
      ['p', 3, 'outerwear'],
      ['p', 4, 'tops'],
      ['c', 0, 'bottoms'],
      ['p', 5, 'footwear'],
    ],
  ],
  [
    'Burgundy + grey',
    'evening',
    [
      ['p', 6, 'tops'],
      ['p', 7, 'bottoms'],
      ['p', 5, 'footwear'],
    ],
  ],
  [
    'Henley, evening',
    'evening',
    [
      ['p', 8, 'tops'],
      ['c', 1, 'bottoms'],
      ['p', 9, 'footwear'],
    ],
  ],
  [
    'Flannel day',
    'daytime',
    [
      ['p', 10, 'tops'],
      ['c', 0, 'bottoms'],
      ['p', 5, 'footwear'],
    ],
  ],
  [
    'Canuck contrast',
    'daytime',
    [
      ['p', 11, 'outerwear'],
      ['p', 12, 'tops'],
      ['c', 0, 'bottoms'],
      ['p', 9, 'footwear'],
    ],
  ],
  [
    'Easy day out',
    'daytime',
    [
      ['p', 2, 'outerwear'],
      ['p', 13, 'tops'],
      ['p', 14, 'bottoms'],
      ['p', 1, 'footwear'],
    ],
  ],
];

interface Fixture {
  owner: { id: number; token: number; looks: number[] };
  persona: { look: number };
  edge: {
    owner: number;
    loved: number;
    revise: number;
    declined: number;
    saved: number;
    savedOutfit: number;
    first: number;
    sameSet: number;
    copied: number;
    likeOutfit: number;
    emptied: number;
    allEmpty: number;
  };
}

async function buildFixture(client: Client): Promise<Fixture> {
  const insert = async (text: string, values: unknown[] = []) =>
    (await client.query<{ id: number }>(`${text} returning id`, values)).rows[0]
      .id;
  const password = await hashPassword(TEST_PASSWORD);
  const userOf = (email: string) =>
    insert(`insert into "user" (email, password) values ($1, $2)`, [
      email,
      password,
    ]);
  const garmentOf = (owner: number, name: string, status: string) =>
    insert(
      `insert into garment (shareable_id, category, owner_id, status, name)
       values (gen_random_uuid()::text, 'tops', $1, $2, $3)`,
      [owner, status, name],
    );
  const tokenOf = (owner: number) =>
    insert(
      `insert into personal_access_token (user_id, name, token_hash, token_prefix)
       values ($1, 'Muse', md5($2) || md5($2), 'cl_' || $2)`,
      [owner, String(owner)],
    );
  let plans = 0;
  const planOf = (owner: number, token: number | null) =>
    insert(
      `insert into wardrobe_plan (owner_id, name, active, drafted_by_token_id)
       values ($1, $2, false, $3)`,
      [owner, `Plan ${++plans}`, token],
    );
  const lookOf = async (
    plan: number,
    name: string,
    slots: [category: string, garment: number | null][],
    extra: { reaction?: string; ownerNote?: string; outfitId?: number } = {},
  ) => {
    const id = await insert(
      `insert into plan_look (plan_id, name, occasion, note, reaction, owner_note, outfit_id)
       values ($1, $2, 'daytime', $3, $4, $5, $6)`,
      [
        plan,
        name,
        `Why ${name}`,
        extra.reaction ?? 'proposed',
        extra.ownerNote ?? null,
        extra.outfitId ?? null,
      ],
    );
    for (const [position, [category, garment]] of slots.entries()) {
      await client.query(
        `insert into plan_look_slot (look_id, position, category, garment_id) values ($1, $2, $3, $4)`,
        [id, position, category, garment],
      );
    }
    return id;
  };
  const outfitOf = async (owner: number, garments: number[]) => {
    const id = await insert(
      `insert into outfit (shareable_id, name, owner_id) values (gen_random_uuid()::text, 'Own', $1)`,
      [owner],
    );
    for (const [position, garment] of garments.entries()) {
      await client.query(
        `insert into outfit_slot (outfit_id, position, category, garment_id) values ($1, $2, 'tops', $3)`,
        [id, position, garment],
      );
    }
    return id;
  };

  // The owner's production plan, in shape; the token revoked since.
  const owner = await userOf('muse-owner@example.com');
  const token = await tokenOf(owner);
  await client.query(
    `update personal_access_token set revoked_at = now() where id = $1`,
    [token],
  );
  const plan = await planOf(owner, token);
  const owned = [
    await garmentOf(owner, 'Raw jeans', 'closet'),
    await garmentOf(owner, 'Grey trousers', 'closet'),
  ];
  const picks: number[] = [];
  for (let i = 0; i < 16; i++) {
    picks.push(await garmentOf(owner, `Pick ${i + 1}`, 'wishlist'));
  }
  const looks: number[] = [];
  for (const [name, , slots] of PRODUCTION_LOOKS) {
    looks.push(
      await lookOf(
        plan,
        name,
        slots.map(([kind, index, category]) => [
          category,
          kind === 'c' ? owned[index] : picks[index],
        ]),
      ),
    );
  }

  // The demo persona's hand-made plan: no token, left alone.
  const persona = await userOf('persona@example.com');
  const personaPlan = await planOf(persona, null);
  const personaTee = await garmentOf(persona, 'Tee', 'closet');
  const personaLook = await lookOf(personaPlan, 'His look', [
    ['tops', personaTee],
  ]);

  // Every other case, a third owner's.
  const edgeOwner = await userOf('edge@example.com');
  const edgeToken = await tokenOf(edgeOwner);
  const edgePlan = await planOf(edgeOwner, edgeToken);
  const [a, b, c, d, e, f] = [
    await garmentOf(edgeOwner, 'A', 'closet'),
    await garmentOf(edgeOwner, 'B', 'closet'),
    await garmentOf(edgeOwner, 'C', 'wishlist'),
    await garmentOf(edgeOwner, 'D', 'wishlist'),
    await garmentOf(edgeOwner, 'E', 'closet'),
    await garmentOf(edgeOwner, 'F', 'wishlist'),
  ];
  const savedOutfit = await outfitOf(edgeOwner, [a, e]);
  const ownOutfit = await outfitOf(edgeOwner, [b, e]);
  const edge = {
    owner: edgeOwner,
    loved: await lookOf(
      edgePlan,
      'Loved',
      [
        ['tops', a],
        ['tops', c],
      ],
      {
        reaction: 'loved',
      },
    ),
    revise: await lookOf(
      edgePlan,
      'Revise',
      [
        ['tops', b],
        ['tops', c],
      ],
      {
        reaction: 'revise',
        ownerNote: 'Warmer, please',
      },
    ),
    declined: await lookOf(
      edgePlan,
      'Declined',
      [
        ['tops', a],
        ['tops', d],
      ],
      {
        reaction: 'declined',
        ownerNote: 'Not my colour',
      },
    ),
    saved: await lookOf(
      edgePlan,
      'Saved',
      [
        ['tops', a],
        ['tops', e],
      ],
      {
        reaction: 'loved',
        outfitId: savedOutfit,
      },
    ),
    savedOutfit,
    first: await lookOf(edgePlan, 'First of a set', [
      ['tops', b],
      ['tops', d],
    ]),
    sameSet: await lookOf(edgePlan, 'Same set again', [
      ['tops', d],
      ['tops', b],
    ]),
    copied: 0,
    likeOutfit: await lookOf(edgePlan, 'Like an outfit', [
      ['tops', b],
      ['tops', e],
    ]),
    emptied: await lookOf(edgePlan, 'An emptied slot', [
      ['tops', f],
      ['bottoms', null],
      ['tops', e],
    ]),
    allEmpty: await lookOf(edgePlan, 'Nothing left', [['tops', null]]),
  };
  expect(ownOutfit).toBeGreaterThan(0);
  // A copied plan: the same looks again, a later plan.
  const copy = await planOf(edgeOwner, edgeToken);
  edge.copied = await lookOf(copy, 'Loved (copy)', [
    ['tops', a],
    ['tops', c],
  ]);
  return {
    owner: { id: owner, token, looks },
    persona: { look: personaLook },
    edge,
  };
}

let t: TestApp;
let fixture: Fixture;
// The plan tables before 0041 and after it, before 0045.
let planBefore: string;
let planAfter: string;

interface OutfitRow {
  id: number;
  owner_id: number;
  name: string | null;
  notes: string | null;
  proposed_at: Date | null;
  proposed_by_token_id: number | null;
  proposal_note: string | null;
  reaction: string | null;
  owner_note: string | null;
  dismissed_reason: string | null;
  plan_look_id: number | null;
}

interface SlotRow {
  position: number;
  category: string;
  garment_id: number | null;
}

// As 0041 left them, before 0045: the outfits and each look's slots.
let outfits: OutfitRow[];
let lookSlots: Map<number, SlotRow[]>;
let byLook: Map<number, OutfitRow>;
let client: Client;

const slotsOf = async (outfitId: number) =>
  (
    await client.query<SlotRow>(
      `select position, category, garment_id from outfit_slot
       where outfit_id = $1 order by position`,
      [outfitId],
    )
  ).rows;

const slotsOfLook = (lookId: number) => lookSlots.get(lookId) ?? [];

const planTables = async (c: Client) =>
  JSON.stringify(
    (
      await c.query(
        `select (select json_agg(l order by l.id) from plan_look l) as looks,
                (select json_agg(s order by s.look_id, s.position) from plan_look_slot s) as slots,
                (select json_agg(p order by p.id) from wardrobe_plan p) as plans`,
      )
    ).rows,
  );

beforeAll(async () => {
  t = await createTestApp(
    {},
    {
      beforeBoot: async (env) => {
        const setup = new Client(connectionOptions(configOf(env)));
        await setup.connect();
        try {
          await migrateBefore(setup, 'muse-outfits');
          fixture = await buildFixture(setup);
          planBefore = await planTables(setup);
          await migrateBefore(setup, 'drop-plans');
          planAfter = await planTables(setup);
          outfits = (
            await setup.query<OutfitRow>(`select * from outfit order by id`)
          ).rows;
          const { rows: slots } = await setup.query<
            SlotRow & { look_id: number }
          >(
            `select look_id, position, category, garment_id from plan_look_slot
             order by look_id, position`,
          );
          lookSlots = new Map();
          for (const { look_id, ...slot } of slots) {
            lookSlots.set(look_id, [...slotsOfLook(look_id), slot]);
          }
        } finally {
          await setup.end();
        }
      },
    },
  );
  client = new Client(connectionOptions(t.database));
  await client.connect();
  byLook = new Map(
    outfits.flatMap((o) => (o.plan_look_id ? [[o.plan_look_id, o]] : [])),
  );
});

afterAll(async () => {
  await client?.end();
  await t?.cleanup();
});

describe('the owner’s draft plan (production’s shape)', () => {
  it('makes each of the 8 looks an outfit of Muse’s, proposed, with its note and the plan’s token', () => {
    const mine = outfits.filter((o) => o.owner_id === fixture.owner.id);
    expect(mine).toHaveLength(8);
    for (const [index, look] of fixture.owner.looks.entries()) {
      const made = byLook.get(look)!;
      expect(made).toMatchObject({
        owner_id: fixture.owner.id,
        name: PRODUCTION_LOOKS[index][0],
        notes: null,
        proposal_note: `Why ${PRODUCTION_LOOKS[index][0]}`,
        reaction: 'proposed',
        owner_note: null,
        dismissed_reason: null,
        proposed_by_token_id: fixture.owner.token,
      });
      expect(made.proposed_at).toBeInstanceOf(Date);
    }
  });

  it('copies the 28 slots position for position, every outfit incomplete', async () => {
    let total = 0;
    for (const look of fixture.owner.looks) {
      const made = byLook.get(look)!;
      const slots = await slotsOf(made.id);
      expect(slots).toEqual(slotsOfLook(look));
      total += slots.length;
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from outfit_slot s join garment g on g.id = s.garment_id
         where s.outfit_id = $1 and g.status = 'wishlist'`,
        [made.id],
      );
      expect(rows[0].n).toBeGreaterThan(0);
    }
    expect(total).toBe(28);
  });

  it('leaves the demo persona’s hand-made plan alone, and the plan tables as they were', () => {
    expect(byLook.has(fixture.persona.look)).toBe(false);
    expect(planAfter).toBe(planBefore);
  });

  it('shows them on the Outfits tab, from Muse', async () => {
    const cookie = await t.login('muse-owner@example.com');
    const page = await t.inject({
      method: 'GET',
      url: '/outfits',
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    const html = unescapeHtml(page.body);
    expect(html.match(/data-muse-outfit="/g)).toHaveLength(8);
    expect(html).toContain('Merino evening');
  });
});

describe('every other case', () => {
  it('keeps the reaction: loved, sent back with its note, declined with its note and no reason', () => {
    expect(byLook.get(fixture.edge.loved)).toMatchObject({ reaction: 'loved' });
    expect(byLook.get(fixture.edge.revise)).toMatchObject({
      reaction: 'revise',
      owner_note: 'Warmer, please',
    });
    expect(byLook.get(fixture.edge.declined)).toMatchObject({
      reaction: 'declined',
      owner_note: 'Not my colour',
      dismissed_reason: null,
    });
  });

  it('a look saved as an outfit makes none: that outfit takes the provenance, loved', async () => {
    const stamped = byLook.get(fixture.edge.saved)!;
    expect(stamped.id).toBe(fixture.edge.savedOutfit);
    expect(stamped).toMatchObject({ reaction: 'loved', name: 'Own' });
    expect((await slotsOf(stamped.id)).length).toBe(2);
  });

  it('one outfit per garment set: a second look of a set, a copied plan’s and one like an outfit are skipped', () => {
    expect(byLook.has(fixture.edge.first)).toBe(true);
    expect(byLook.has(fixture.edge.sameSet)).toBe(false);
    expect(byLook.has(fixture.edge.copied)).toBe(false);
    expect(byLook.has(fixture.edge.likeOutfit)).toBe(false);
  });

  it('an emptied slot stays empty, and a look with no garment makes no outfit', async () => {
    const emptied = byLook.get(fixture.edge.emptied)!;
    expect(await slotsOf(emptied.id)).toEqual(
      slotsOfLook(fixture.edge.emptied),
    );
    expect(byLook.has(fixture.edge.allEmpty)).toBe(false);
  });

  it('the edge owner’s outfits: two of their own, five from the looks', () => {
    const theirs = outfits.filter((o) => o.owner_id === fixture.edge.owner);
    expect(theirs).toHaveLength(7);
  });
});

describe('then 0045_drop-plans', () => {
  it('keeps every outfit 0041 made, and drops the plan tables', async () => {
    const after = (
      await client.query<Omit<OutfitRow, 'plan_look_id'>>(
        `select * from outfit order by id`,
      )
    ).rows;
    // Every outfit as it was, less the dropped column.
    expect(after[0]).not.toHaveProperty('plan_look_id');
    expect(outfits).toMatchObject(after);
    expect(await planTablesLeft(client)).toEqual([]);
  });
});
