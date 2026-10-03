import { PassThrough, Readable } from 'node:stream';
import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capsule,
  garment,
  garmentRepair,
  outfit,
  outfitCalendar,
  outfitSlot,
  planItem,
  planItemCandidate,
  trip,
  wardrobePlan,
  wardrobeShare,
} from '../../src/db/schema';
import { runSeed } from '../../src/seed/seed';
import { addDays } from '../../src/web/calendar/calendar-date';
import { startWeatherStub, type WeatherStub } from '../support/weather-stub';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  userIdOf,
} from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { callTool, mcpRequest } from './mcp';

/**
 * What each MCP tool costs in statements (#172): production reaches
 * Postgres over a link that costs a round trip per statement (#156), so
 * the count is the latency. Theo (the demo persona) calls every tool as
 * the page audit does (`npm run audit:pages -- --only '#172'`): with the
 * weather on, each call made once untimed and then counted, so a write
 * counts its repeat and a forecast is warm. Every count includes the
 * token's own read (authenticateToken). The tools' behaviour is mcp.spec,
 * mcp-plans.spec, mcp-shopping.spec and mcp-photos.spec's; this one pins
 * the statements, and proves the reads #172 dropped are gone.
 */

const DEMO_EMAIL = 'demo@closet.invalid';
const DEMO_PASSWORD = 'Closet-demo-1';

/**
 * The token's last-use mark is written at most once a minute
 * (authenticateToken), so whether a call pays it depends on the clock:
 * counts leave it out.
 */
const LAST_USED = /^update "personal_access_token"/;

describe('MCP statements per tool (#172)', () => {
  let t: TestApp;
  let stub: WeatherStub;
  let sites: LinkSites;
  /** Theo's tokens, taken in turn: /mcp allows 120 calls a minute per token. */
  const tokens: string[] = [];
  let turn = 0;
  let today: string;
  const ids = {
    theo: 0,
    dana: 0,
    garment: 0,
    other: 0,
    copies: 0,
    wishlist: 0,
    outfit: 0,
    outfitGarments: [] as number[],
    capsule: 0,
    danaCapsule: 0,
    trip: 0,
    plan: 0,
    planItem: 0,
  };

  beforeAll(async () => {
    stub = await startWeatherStub();
    sites = await startLinkSites();
    sites.serve('/img/tee.jpg', jpeg(await productShot('#223355')));
    sites.serve(
      '/products/tee',
      html(`<!doctype html><html><head><title>Pocket Tee</title>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Heavyweight Pocket Tee',
        brand: { '@type': 'Brand', name: 'Studio Knit' },
        color: 'Navy',
        image: [sites.url('/img/tee.jpg')],
        offers: { price: '48.00', priceCurrency: 'USD' },
      })}</script></head><body></body></html>`),
    );
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options, outboundFetch: sites.outboundFetch },
    );
    let stdout = '';
    const output = new PassThrough();
    output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const status = await runSeed({
      args: ['--persona', 'demo', '--persona', 'sparse', '--password-stdin'],
      db: t.db,
      photos: t.photos,
      logger: t.logger,
      timeZone: 'America/New_York',
      weatherEnabled: true,
      input: Readable.from([`${DEMO_PASSWORD}\n`]),
      output,
      errors: new PassThrough(),
      now: new Date(),
    });
    expect(status, stdout).toBe(0);
    today = t.today();
    const cookie = await t.login(DEMO_EMAIL, DEMO_PASSWORD);
    for (let i = 0; i < 4; i++) {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: `Statements ${i}`, currentPassword: DEMO_PASSWORD },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      tokens.push(/closet_[A-Za-z0-9_-]{43}/.exec(res.body)![0]);
    }
    await findIds();
  }, 180_000);

  afterAll(async () => {
    await t?.cleanup();
    await stub?.close();
    await sites?.close();
  });

  async function findIds() {
    ids.theo = await userIdOf(t, DEMO_EMAIL);
    const [repaired] = await t.db
      .select({ id: garment.id })
      .from(garmentRepair)
      .innerJoin(garment, eq(garment.id, garmentRepair.garmentId))
      .where(and(eq(garment.ownerId, ids.theo), eq(garment.status, 'closet')))
      .orderBy(asc(garmentRepair.id))
      .limit(1);
    ids.garment = repaired.id;
    const closet = await t.db
      .select({ id: garment.id })
      .from(garment)
      .where(
        and(
          eq(garment.ownerId, ids.theo),
          eq(garment.status, 'closet'),
          ne(garment.id, ids.garment),
        ),
      )
      .orderBy(asc(garment.id))
      .limit(2);
    [ids.other, ids.copies] = closet.map((row) => row.id);
    const [plan] = await t.db
      .select({ id: wardrobePlan.id })
      .from(wardrobePlan)
      .where(
        and(eq(wardrobePlan.ownerId, ids.theo), eq(wardrobePlan.active, true)),
      );
    ids.plan = plan.id;
    const [candidate] = await t.db
      .select({
        planItemId: planItemCandidate.planItemId,
        garmentId: planItemCandidate.garmentId,
      })
      .from(planItemCandidate)
      .innerJoin(planItem, eq(planItem.id, planItemCandidate.planItemId))
      .where(eq(planItem.planId, plan.id))
      .orderBy(asc(planItemCandidate.garmentId))
      .limit(1);
    ids.planItem = candidate.planItemId;
    ids.wishlist = candidate.garmentId;
    const worn = sql<number>`count(*)`;
    const [favourite] = await t.db
      .select({ id: outfit.id, worn })
      .from(outfit)
      .innerJoin(outfitCalendar, eq(outfitCalendar.outfitId, outfit.id))
      .where(
        and(eq(outfit.ownerId, ids.theo), isNotNull(outfitCalendar.wornAt)),
      )
      .groupBy(outfit.id)
      .orderBy(desc(worn), asc(outfit.id))
      .limit(1);
    ids.outfit = favourite.id;
    const slots = await t.db
      .select({ garmentId: outfitSlot.garmentId })
      .from(outfitSlot)
      .where(
        and(
          eq(outfitSlot.outfitId, ids.outfit),
          isNotNull(outfitSlot.garmentId),
        ),
      )
      .orderBy(asc(outfitSlot.position));
    ids.outfitGarments = slots.map((slot) => slot.garmentId!);
    const [office] = await t.db
      .select({ id: capsule.id })
      .from(capsule)
      .where(and(eq(capsule.ownerId, ids.theo), eq(capsule.name, 'Office')));
    ids.capsule = office.id;
    const [firstTrip] = await t.db
      .select({ id: trip.id })
      .from(trip)
      .where(eq(trip.ownerId, ids.theo))
      .orderBy(asc(trip.id))
      .limit(1);
    ids.trip = firstTrip.id;
    const [share] = await t.db
      .select({ danaId: wardrobeShare.grantorId })
      .from(wardrobeShare)
      .where(eq(wardrobeShare.granteeId, ids.theo));
    ids.dana = share.danaId;
    const [danas] = await t.db
      .insert(capsule)
      .values({ ownerId: ids.dana, name: 'Dana’s own' })
      .returning({ id: capsule.id });
    ids.danaCapsule = danas.id;
  }

  const day = (offset: number) => addDays(today, offset);

  /**
   * The tool called once (a write's first effect, a forecast's first
   * fetch), then again, counted: the statements of the second call, the
   * token's last-use mark left out (LAST_USED). `againArgs` for a write
   * that refuses its own repeat (create_plan's name is taken by then).
   */
  async function statementsOf(
    name: string,
    args: Record<string, unknown>,
    againArgs = args,
  ) {
    const token = tokens[turn++ % tokens.length];
    const first = await callTool(t, token, name, args);
    expect(first.isError, JSON.stringify(first.value)).toBe(false);
    const record = await recordQueries(async () => {
      const again = await callTool(t, token, name, againArgs);
      expect(again.isError, JSON.stringify(again.value)).toBe(false);
    });
    return record.sql.filter((statement) => !LAST_USED.test(statement));
  }

  // The tool, its arguments (made anew for each call) and its statements
  // (the token's read included). Before #172 in the comment where it changed.
  let drafts = 0;
  const cases: [string, () => Record<string, unknown>, number][] = [
    ['get_today', () => ({}), 3], // 6: the weather twice, worn apart
    ['search_garments', () => ({ category: 'tops' }), 3],
    // get_wardrobe: the garments, then every garment's wears in one
    // grouped statement (`wearCountsByGarment`); a grantee's has the share read and no wears.
    ['get_wardrobe', () => ({}), 3],
    ['get_wardrobe', () => ({ ownerId: ids.dana }), 3],
    ['get_garment', () => ({ id: ids.garment }), 3], // 5
    ['get_garment_photo', () => ({ id: ids.garment }), 3],
    ['update_garment', () => ({ id: ids.other, warmth: 3 }), 5], // 7
    ['add_garment_copy', () => ({ id: ids.copies, copies: 1 }), 7], // 9
    ['list_wishlist', () => ({}), 2],
    [
      'add_garment_from_link',
      () => ({ url: sites.url('/products/tee'), destination: 'wishlist' }),
      13, // 14: the capsules and the wears apart
    ],
    ['list_capsules', () => ({}), 2],
    ['get_capsule', () => ({ id: ids.capsule }), 3],
    [
      'set_capsule_membership',
      () => ({ id: ids.capsule, add: [ids.garment] }),
      5, // 7: the capsule read first, and each side locked apart
    ],
    ['list_outfits', () => ({}), 2],
    ['get_outfit', () => ({ id: ids.outfit }), 2],
    [
      'create_outfit',
      () => ({ garmentIds: ids.outfitGarments, name: 'Statements' }),
      7, // 10 with four garments: a read per garment
    ],
    [
      'schedule_outfit',
      () => ({ outfitId: ids.outfit, date: day(5), occasion: 'evening' }),
      6, // 7: the day's entries read again for the occasion kept
    ],
    ['suggest_outfits', () => ({ date: day(1), occasion: 'work' }), 2],
    ['goes_with_closet', () => ({ garmentId: ids.wishlist }), 2],
    [
      'pick_outfit',
      () => ({
        garmentIds: ids.outfitGarments,
        date: day(6),
        occasion: 'evening',
      }),
      7,
    ],
    ['get_calendar', () => ({ from: day(-7), to: day(7) }), 2], // 3
    ['laundry_status', () => ({}), 2],
    ['mark_worn', () => ({ garmentId: ids.garment }), 2],
    ['mark_washed', () => ({ garmentIds: [ids.garment] }), 2],
    ['plan_week', () => ({}), 7],
    ['list_trips', () => ({}), 2],
    ['get_trip', () => ({ tripId: ids.trip }), 2],
    ['plan_trip_outfit', () => ({ tripId: ids.trip, outfitId: ids.outfit }), 2],
    ['wardrobe_stats', () => ({}), 3],
    ['get_weather', () => ({ from: today, to: day(3) }), 2],
    ['list_shared_wardrobes', () => ({}), 2],
    ['compare_with_shared_wardrobe', () => ({ ownerId: ids.dana }), 4],
    ['get_style_profile', () => ({}), 2], // 3
    ['list_plans', () => ({}), 4],
    ['create_plan', () => ({ name: `Statements ${++drafts}` }), 5],
    ['get_plan_gaps', () => ({}), 6], // 5; #278 reads the rejected products
    // token, plan, items, rejections (#278) and candidates (#295: needsProducts)
    ['get_plan_feedback', () => ({}), 5],
    ['propose_plan_item', () => ({ category: 'tops', name: 'Statements' }), 7],
    // #278: 6, plus the review read under the lock that the machine judges.
    ['update_plan_item', () => ({ itemId: ids.planItem, category: 'tops' }), 7],
    ['get_sizes', () => ({}), 3],
    ['get_shopping_list', () => ({}), 5],
    [
      'add_candidate',
      () => ({ itemId: ids.planItem, garmentId: ids.wishlist }),
      11,
    ],
    ['compare_plans', () => ({ a: ids.plan, b: ids.plan }), 4],
  ];

  it.each(cases)('%s', async (name, args, expected) => {
    const statements = await statementsOf(name, args(), args());
    expect(statements, statements.join('\n\n')).toHaveLength(expected);
  });

  it('lists every tool the server offers', async () => {
    const res = await mcpRequest(t, tokens[0], 'tools/list');
    const listed = res
      .json<{ result: { tools: { name: string }[] } }>()
      .result.tools.map((tool) => tool.name);
    expect(new Set(cases.map(([name]) => name))).toEqual(new Set(listed));
  });

  describe('the reads #172 dropped', () => {
    it('get_garment reads its capsules, wears and repairs in one statement', async () => {
      const statements = await statementsOf('get_garment', { id: ids.garment });
      const context = statements.filter((s) => s.includes('"capsule"'));
      expect(context).toHaveLength(1);
      expect(context[0]).toContain('"garment_wear"');
      expect(context[0]).toContain('"garment_repair"');
    });

    it('create_outfit reads its garments once, whatever their number', async () => {
      const statements = await statementsOf('create_outfit', {
        garmentIds: ids.outfitGarments,
      });
      expect(ids.outfitGarments.length).toBeGreaterThan(1);
      const before = statements.slice(0, statements.indexOf('begin'));
      expect(before.filter((s) => s.includes('from "garment"'))).toHaveLength(
        1,
      );
    });

    it('set_capsule_membership reads no capsule before its write, and refuses another’s after it', async () => {
      const statements = await statementsOf('set_capsule_membership', {
        id: ids.capsule,
        add: [ids.other],
      });
      expect(statements.indexOf('begin')).toBe(1);
      const refused = await callTool(t, tokens[0], 'set_capsule_membership', {
        id: ids.danaCapsule,
        add: [ids.garment],
      });
      expect(refused).toEqual({
        value: { error: 'Capsule not found' },
        isError: true,
      });
    });

    it('schedule_outfit answers the occasion an outfit kept without reading the day', async () => {
      const [first] = await t.db
        .select({ occasion: outfitCalendar.occasion })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.ownerId, ids.theo),
            eq(outfitCalendar.outfitId, ids.outfit),
            eq(outfitCalendar.day, day(5)),
          ),
        );
      expect(first.occasion).toBe('evening');
      const again = await callTool(t, tokens[1], 'schedule_outfit', {
        outfitId: ids.outfit,
        date: day(5),
        occasion: 'work',
      });
      expect(again.value).toEqual({
        outcome: 'already-scheduled',
        date: day(5),
        occasion: 'evening',
      });
    });

    it('get_today reads worn today and the weather in its first statement', async () => {
      const statements = await statementsOf('get_today', {});
      const day = statements.filter((s) => s.includes('"outfit_calendar"'));
      expect(day[0]).toContain('"user_weather"');
      expect(day[0]).toContain('"garment_wear"');
      // The ideas take the model's weather: nothing reads it again.
      expect(
        statements.filter((s) => s.includes('"user_weather"')),
      ).toHaveLength(1);
    });
  });
});
