import { and, eq, isNotNull, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar-date';
import {
  garment,
  outfit,
  outfitCalendar,
  personalAccessToken,
  tripOutfit,
} from '../../src/db/schema';
import { MCP_WRITES, type Stamped } from '../../src/web/api/operations';
import { createTrip } from '../../src/web/trips/queries';
import { deviceToken } from './api';
import { createGarment } from './garments';
import { asFixture, createTestApp, type TestApp } from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { createAccessToken, tool } from './mcp';

/**
 * What the agent did is visible (#682): every MCP tool MCP_WRITES says
 * stamps a row writes the calling token on it, and the same write over the
 * API with a device token (the person) leaves it unstamped. Table-driven
 * over operations.ts: a tool classified `stamps` without a scenario here
 * fails, as does a scenario whose rows carry no token. The `none` tools'
 * scenarios assert they stamp nothing.
 */

/** The stamped rows a scenario wrote, by kind, for the assertions. */
type Written = Partial<Record<Stamped, number[]>>;

describe('agent writes carry their token (#682)', () => {
  let t: TestApp;
  let sites: LinkSites;
  let token: string;
  let tokenId: number;
  const g: Record<string, number> = {};
  let tripId: number;

  const day = (n: number) => addDays(t.today(), n);

  /** The token every row of `written` names, per kind (null: unstamped). */
  async function stampsOf(written: Written) {
    const out: Partial<Record<Stamped, (number | null)[]>> = {};
    for (const [kind, ids] of Object.entries(written) as [
      Stamped,
      number[],
    ][]) {
      out[kind] = await stampColumn(kind, ids);
    }
    return out;
  }

  async function stampColumn(kind: Stamped, ids: number[]) {
    const rows = await {
      outfit: () =>
        t.db
          .select({ id: outfit.addedByTokenId })
          .from(outfit)
          .where(or(...ids.map((id) => eq(outfit.id, id)))),
      calendarEntry: () =>
        t.db
          .select({ id: outfitCalendar.plannedByTokenId })
          .from(outfitCalendar)
          .where(or(...ids.map((id) => eq(outfitCalendar.id, id)))),
      tripOutfit: () =>
        t.db
          .select({ id: tripOutfit.plannedByTokenId })
          .from(tripOutfit)
          .where(or(...ids.map((id) => eq(tripOutfit.id, id)))),
      garment: () =>
        t.db
          .select({ id: garment.addedByTokenId })
          .from(garment)
          .where(or(...ids.map((id) => eq(garment.id, id)))),
    }[kind]();
    expect(rows).toHaveLength(ids.length);
    return rows.map((row) => row.id);
  }

  const entryOf = async (outfitId: number) => {
    const [row] = await t.db
      .select({ id: outfitCalendar.id, plannedBy: outfitCalendar.plannedBy })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, outfitId));
    return row;
  };

  const tripOutfitOf = async (outfitId: number) => {
    const [row] = await t.db
      .select({ id: tripOutfit.id })
      .from(tripOutfit)
      .where(
        and(eq(tripOutfit.tripId, tripId), eq(tripOutfit.outfitId, outfitId)),
      );
    return row.id;
  };

  /** Each stamping tool's write, as the agent makes it; the rows it stamped. */
  const STAMPING: Record<string, () => Promise<Written>> = {
    async create_outfit() {
      const made = await tool<{ id: number }>(t, token, 'create_outfit', {
        garmentIds: [g.top1, g.bottom1],
        scheduleDate: day(1),
      });
      const entry = await entryOf(made.id);
      expect(entry.plannedBy).toBe('agent');
      return { outfit: [made.id], calendarEntry: [entry.id] };
    },
    async schedule_outfit() {
      const own = await ownOutfit([g.top2, g.bottom2]);
      await tool(t, token, 'schedule_outfit', { outfitId: own, date: day(2) });
      const planned = await entryOf(own);
      // And the replace: the person's entry becomes the agent's choice.
      const mine = await ownOutfit([g.top3, g.bottom3]);
      const personal = await planAsPerson(mine, day(3));
      const replaced = await tool<{ entryId: number }>(
        t,
        token,
        'schedule_outfit',
        { outfitId: own, date: day(3), replaceEntryId: personal },
      );
      expect(replaced.entryId).toBe(personal);
      return { calendarEntry: [planned.id, personal] };
    },
    async pick_outfit() {
      const saved = await tool<{ id: number }>(t, token, 'pick_outfit', {
        garmentIds: [g.top4, g.bottom4],
      });
      const dated = await tool<{ id: number }>(t, token, 'pick_outfit', {
        garmentIds: [g.top5, g.bottom5],
        date: day(4),
      });
      const entry = await entryOf(dated.id);
      return { outfit: [saved.id, dated.id], calendarEntry: [entry.id] };
    },
    async plan_trip_outfit() {
      const own = await ownOutfit([g.top6, g.bottom6]);
      await tool(t, token, 'plan_trip_outfit', { tripId, outfitId: own });
      const idea = await tool<{ outfitId: number }>(
        t,
        token,
        'plan_trip_outfit',
        { tripId, garmentIds: [g.top7, g.bottom7] },
      );
      return {
        tripOutfit: [
          await tripOutfitOf(own),
          await tripOutfitOf(idea.outfitId),
        ],
        outfit: [idea.outfitId],
      };
    },
    async add_garment_from_link() {
      const added = await tool<{ garment: { id: number } }>(
        t,
        token,
        'add_garment_from_link',
        { url: sites.url('/products/tee') },
      );
      return { garment: [added.garment.id] };
    },
  };

  /** Each `none` tool's write, which must stamp nothing. */
  const UNSTAMPED: Record<string, () => Promise<void>> = {
    async update_garment() {
      await tool(t, token, 'update_garment', { id: g.top1, brand: 'Edited' });
    },
    async add_garment_copy() {
      await tool(t, token, 'add_garment_copy', { id: g.top2 });
    },
    async mark_worn() {
      await tool(t, token, 'mark_worn', { garmentId: g.top3 });
    },
    async mark_washed() {
      await tool(t, token, 'mark_washed', { garmentIds: [g.top3] });
    },
  };

  /** A saved outfit of the owner's, through the API as the person. */
  async function ownOutfit(garmentIds: number[]): Promise<number> {
    const res = await t.api(device, {
      method: 'POST',
      url: '/api/v1/outfits',
      payload: {
        slots: garmentIds.map((garmentId) => ({ category: 'tops', garmentId })),
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json<{ id: number }>().id;
  }

  async function planAsPerson(outfitId: number, on: string): Promise<number> {
    const res = await t.api(device, {
      method: 'POST',
      url: '/api/v1/calendar-entries',
      payload: { outfitId, day: on },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: number }>().id;
  }

  let device: string;

  beforeAll(async () => {
    sites = await startLinkSites();
    sites.serve('/img/tee.jpg', jpeg(await productShot('#223355')));
    sites.serve(
      '/products/tee',
      html(`<!doctype html><html><head><title>Pocket Tee</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Heavyweight Pocket Tee',
        image: [sites.url('/img/tee.jpg')],
        offers: { price: '48.00', priceCurrency: 'USD' },
      })}</script></head><body></body></html>`),
    );
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    for (let i = 1; i <= 7; i += 1) {
      g[`top${i}`] = await createGarment(t, {
        name: `Tee ${i}`,
        category: 'tops',
      });
      g[`bottom${i}`] = await createGarment(t, {
        name: `Jeans ${i}`,
        category: 'bottoms',
      });
    }
    token = await createAccessToken(t, { name: 'Laptop Claude' });
    const [row] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.name, 'Laptop Claude'));
    tokenId = row.id;
    device = (await deviceToken(t)).token;
    tripId = await asFixture(t.db, (tx) =>
      createTrip(tx, t.owner.id, {
        name: 'Austin',
        destination: null,
        startsOn: day(10),
        endsOn: day(12),
        notes: null,
      }),
    );
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it('classifies every writing tool, and has a scenario for each', () => {
    const stamping = Object.entries(MCP_WRITES)
      .filter(([, write]) => 'stamps' in write.attribution)
      .map(([name]) => name);
    expect(Object.keys(STAMPING).sort()).toEqual(stamping.sort());
  });

  it.each(Object.keys(STAMPING))(
    '%s stamps its rows with the token',
    async (name) => {
      const written = await STAMPING[name]();
      const declared = MCP_WRITES[name].attribution;
      if (!('stamps' in declared)) throw new Error(`${name} stamps nothing`);
      expect(Object.keys(written).sort()).toEqual([...declared.stamps].sort());
      for (const tokens of Object.values(await stampsOf(written))) {
        expect(tokens).toEqual(tokens.map(() => tokenId));
      }
    },
  );

  it.each(Object.keys(UNSTAMPED))('%s stamps nothing', async (name) => {
    expect(
      'none' in MCP_WRITES[name].attribution,
      `${name} is classified none`,
    ).toBe(true);
    const before = await stampedCount();
    await UNSTAMPED[name]();
    expect(await stampedCount()).toBe(before);
  });

  async function stampedCount(): Promise<number> {
    const counts = await Promise.all([
      t.db.$count(outfit, isNotNull(outfit.addedByTokenId)),
      t.db.$count(outfitCalendar, isNotNull(outfitCalendar.plannedByTokenId)),
      t.db.$count(tripOutfit, isNotNull(tripOutfit.plannedByTokenId)),
      t.db.$count(garment, isNotNull(garment.addedByTokenId)),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  }

  it("the person's twin over the API stamps nothing, and takes an agent entry over", async () => {
    const own = await ownOutfit([g.top1, g.bottom2]);
    await tool(t, token, 'schedule_outfit', { outfitId: own, date: day(5) });
    const agents = await entryOf(own);
    expect((await entryOf(own)).plannedBy).toBe('agent');
    // The person planning the same outfit that day makes it theirs.
    const res = await t.api(device, {
      method: 'POST',
      url: '/api/v1/calendar-entries',
      payload: { outfitId: own, day: day(5) },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stampColumn('calendarEntry', [agents.id])).toEqual([null]);
    expect((await entryOf(own)).plannedBy).toBe('user');
  });

  it('names the token in the API and the feed, and keeps it readable once revoked', async () => {
    const own = await ownOutfit([g.top2, g.bottom3]);
    await tool(t, token, 'schedule_outfit', { outfitId: own, date: day(6) });
    const read = async () => {
      const res = await t.api(device, {
        method: 'GET',
        url: `/api/v1/calendar-entries?from=${day(6)}&to=${day(6)}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        data: { plannedBy: string; agent?: { name: string } }[];
      }>().data;
    };
    expect(await read()).toContainEqual(
      expect.objectContaining({
        plannedBy: 'agent',
        agent: { name: 'Laptop Claude' },
      }),
    );
    // Revoked tokens stay as rows: the name is still the token's.
    await t.db
      .update(personalAccessToken)
      .set({ revokedAt: new Date() })
      .where(eq(personalAccessToken.id, tokenId));
    expect(await read()).toContainEqual(
      expect.objectContaining({ agent: { name: 'Laptop Claude' } }),
    );
    // A hand-made entry carries no agent.
    const mine = await ownOutfit([g.top4, g.bottom5]);
    const entryId = await planAsPerson(mine, day(6));
    const hand = (await read()).find(
      (e) => 'id' in e && (e as { id: number }).id === entryId,
    );
    expect(hand).toMatchObject({ plannedBy: 'user' });
    expect(hand).not.toHaveProperty('agent');
  });
});
