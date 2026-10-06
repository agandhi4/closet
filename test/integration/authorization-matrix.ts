import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordCutoutEvent } from '../../src/cutout/queries';
import {
  optionGroup,
  orderItem,
  outfit as outfitTable,
  outfitCalendar,
  tripItem,
  tripOutfit,
  wardrobeShare,
  weekPlan,
} from '../../src/db/schema';
import type { SuggestionDecision } from '../../src/wardrobe/suggestions';
import { createToken } from '../../src/web/auth/personal-tokens';
import { setGarmentStatus } from '../../src/web/wardrobe/status';
import { decide, markSuggestion } from '../../src/web/wishlist/decisions';
import { saveStyleProfile } from '../../src/web/style/queries';
import { EMPTY_STYLE_PROFILE } from '../../src/web/style/validation';
import { LOGIN_PATH } from '../../src/web/auth/login-path';
import { addBrandSize } from '../../src/web/sizes/queries';
import { addRepair } from '../../src/web/wardrobe/repairs';
import { recordOrderEmail } from '../../src/web/wardrobe/order-mail/queries';
import { addDays, type IsoDate } from '../../src/web/calendar/calendar-date';
import {
  createGarment,
  createWishlistItem,
  garmentRow,
  jpegPhoto,
  photoFileName,
  pngCutout,
  uploadPhoto,
} from './garments';
import {
  createTestApp,
  type Env,
  OWNER_EMAIL,
  TestApp,
  type TestAppOptions,
  userIdOf,
} from './harness';
import { jpeg, type LinkSites, startLinkSites } from './link-sites';
import { planEntry, takeSelfie } from './selfies';
import { startJmapStub } from '../support/jmap-stub';
import { startWeatherStub } from '../support/weather-stub';

/**
 * The object-level authorization matrix, split by route group into
 * test/integration/authorization-*.spec.ts so Vitest spreads it across
 * workers (#113); each file hands its routes to describeMatrix. One owner (the harness's default
 * user) holds a garment (with a photo), an outfit and a calendar entry; every
 * route that takes one of their ids (plus the `?ownerId=` wardrobe routes)
 * is requested by the owner, a MANAGE grantee, a VIEW grantee, a registered
 * stranger and an anonymous visitor, with and without `?ownerId=<owner>`.
 * Each case asserts the status (or redirect), that refused requests leak
 * no names into the body, and that a refused write changed no row and no
 * stored file. Sharing covers the wardrobe, its garments and its capsules
 * (a VIEW grantee reads them, a MANAGE grantee also changes membership,
 * only the owner creates, renames and deletes a capsule): outfits and
 * calendar entries stay private to their owner whatever the share.
 *
 * Refusals follow WardrobeAccess (src/web/sharing/access.ts): what the
 * requester cannot see does not exist for them, a 404 like an unknown id (a
 * stranger's view of the owner's wardrobe, a garment outside the addressed
 * wardrobe, anyone else's outfit), so ids reveal nothing; what they can see
 * but may not change is a 403 (a VIEW grantee writing, a grantee archiving).
 * Calendar entries and outfits are never shared, so every refusal there is
 * a 404. The wishlist (#18) is the wardrobe's too: a VIEW grantee reads it,
 * a MANAGE grantee buys, only the owner restores an archived garment (and
 * archives what a purchase replaces). Wears, washes and away (#7) are the
 * owner's own records too, but
 * about a garment a grantee can see: with `?ownerId=` a 403, without it a
 * 404 (the garment is not in their wardrobe); a garment's condition is a
 * property like any other (MANAGE writes it). /laundry and insights (#17)
 * are always the requester's own: another user's ids are ignored. The
 * style profile (#34) is private like outfits: anyone else sees their own.
 * Outfit selfies (#19) are the calendar's: taking,
 * removing and seeing one is the owner's alone, and the public /file/**
 * routes refuse a selfie's name and share id to everyone, the owner too.
 * Trips (#10) are the owner's like outfits: every refusal is a 404 (or the
 * requester's own list), including a gallery pick for someone else's trip.
 * So are the weekly auto-plan's batches and the order mail's review list
 * (#25: ORDER_MAIL_OWNER's alone, a 404 like a missing route for anyone
 * else). A share row is its two parties' (grantor and grantee): anyone
 * else, a grantee of the same wardrobe included, gets a 404.
 *
 * authorization-coverage.spec.ts fails when a route that takes an id is in
 * no group here (#182).
 */

export type SignedIn = 'owner' | 'manager' | 'viewer' | 'stranger';
export type ActorName = SignedIn | 'anonymous';
/** own: the URL as the app links it; ownerId: `?ownerId=<owner>` appended. */
export type Via = 'own' | 'ownerId';

/**
 * ok: the route's success status. Reads that `show` their subject must
 *     render its name; writes must change stored data; clones must add a
 *     garment to the requester's wardrobe and modify nothing that existed.
 * hidden: 200, but the requester's own data only (no owner names).
 * ignored: the route's success status, but the owner's ids were ignored:
 *     nothing leaked, nothing changed (/laundry's batch).
 * forbidden / notFound / login: refused, nothing leaked, nothing changed.
 * unauthorized: a 401 without a body worth reading: the MCP endpoint, where
 *     a session cookie never counts (only a personal access token does).
 */
export type Outcome =
  | 'ok'
  | 'hidden'
  | 'ignored'
  | 'forbidden'
  | 'notFound'
  | 'login'
  | 'unauthorized';

export interface Fixture {
  garmentId: number;
  garmentName: string;
  /** A wishlist item replacing the garment (#18). */
  wishlistId: number;
  wishlistName: string;
  /**
   * A Muse need of the owner's (#333) with two options, one set aside; a
   * need set aside; and a pick bought (so Returned writes).
   */
  needId: number;
  needName: string;
  needPickId: number;
  setAsidePickId: number;
  asideNeedId: number;
  boughtPickId: number;
  /** An archived garment (Restore). */
  archivedId: number;
  archivedName: string;
  /** A capsule holding the garment. */
  capsuleId: number;
  capsuleName: string;
  outfitId: number;
  outfitName: string;
  /** One of Muse's outfits (#335) waiting on the owner, and one set aside. */
  museOutfitId: number;
  museDeclinedId: number;
  /** The calendar entry, planned on `today` (so worn may mark it). */
  entryId: number;
  /** The entry's outfit selfie (#19), and its photo's names. */
  selfieId: number;
  selfieFileName: string;
  selfieShareableId: string;
  /** The owner's id. */
  ownerId: number;
  /**
   * A trip of the owner's (#10) on today and tomorrow: the outfit on it for
   * today, the garment packed, one extra; and another trip with an extra.
   */
  tripId: number;
  tripName: string;
  tripOutfitId: number;
  tripItemId: number;
  otherTripId: number;
  /**
   * The app's today (t.today(), APP_TIMEZONE) when the fixture was made:
   * the entry's day, and the day a wishlist item is bought.
   */
  today: IsoDate;
  /**
   * A new personal access token of the owner's (OWNER_TOKEN_NAME), made
   * when a request asks for it: few routes need one, and the owner may hold
   * only MAX_ACTIVE_TOKENS.
   */
  ownerToken: () => Promise<number>;
  /**
   * The owner's size note (#24) for the wishlist item's brand, which only
   * the owner's own pages show (OWNER_SIZE_NOTE).
   */
  brandSizeId: number;
  brand: string;
  /** A repair log entry on the garment (#23), the owner's own record. */
  repairId: number;
  /**
   * A pending item of the owner's order mail (#25), whose product page the
   * link sites do not serve (the add form opens with the order's details).
   */
  orderItemId: number;
  orderItemName: string;
  /** A batch of the weekly auto-plan of the owner's, all its entries gone. */
  weekPlanId: number;
  /** An open invite link to the owner's wardrobe, not yet accepted. */
  inviteShareId: number;
  /** A phone photo and a cutout to upload, the file's own for every test. */
  photo: Buffer;
  cutout: Buffer;
  /** The link import's "internet": a shop's photo URL (link-sites.ts). */
  shopPhotoUrl: string;
}

export interface Route {
  name: string;
  kind: 'read' | 'write' | 'clone';
  /** Status the route answers on success. */
  ok: number;
  /**
   * An optional feature the route exists only with: the group's app runs
   * with it on, against its stand-in (featureApp).
   */
  feature?: Feature;
  /** Text naming the owner's row: must appear on success, never on a refusal. */
  secret: (f: Fixture) => string;
  /** Success renders the secret (detail pages, lists, forms). */
  shows?: boolean;
  vias: Via[];
  request: (
    f: Fixture,
    ownerQuery: string,
  ) => InjectOptions | Promise<InjectOptions>;
  /** Per signed-in actor, one outcome for every via or one per via. */
  expect: Record<SignedIn, Outcome | Outcome[]>;
  /** A signed-out visitor's outcome when it is not the login redirect. */
  anonymous?: Outcome;
}

export const BOTH: Via[] = ['own', 'ownerId'];
export const garmentName = (f: Fixture) => f.garmentName;
export const wishlistName = (f: Fixture) => f.wishlistName;
export const needName = (f: Fixture) => f.needName;
export const archivedName = (f: Fixture) => f.archivedName;
export const capsuleName = (f: Fixture) => f.capsuleName;
export const outfitName = (f: Fixture) => f.outfitName;
export const tripName = (f: Fixture) => f.tripName;
export const orderItemName = (f: Fixture) => f.orderItemName;
// One style profile per user, so one note every fixture saves again.
export const OWNER_STYLE_NOTE = 'Owner style notes, never shared';
export const styleNote = () => OWNER_STYLE_NOTE;
// The owner's note on the wishlist item's brand (#24): the owner's body,
// never shown to anyone else, a shared wardrobe's pages included.
export const OWNER_SIZE_NOTE = 'Owner size note, never shared';
export const sizeNote = () => OWNER_SIZE_NOTE;
// A calendar row's edit link: only the entry's owner is shown it. (Error
// pages echo the request path, which rules out the /calendar/:id URLs
// themselves.)
export const calendarEntry = (f: Fixture) =>
  `/styling?outfit=${f.outfitId}&amp;returnTo=`;
export const selfieName = (f: Fixture) => f.selfieFileName;
export const OWNER_TOKEN_NAME = 'Owner laptop token';

/** A feature off by default whose routes exist only with it on. */
export type Feature = 'weather' | 'orderMail';

const ORDER_MAIL_TOKEN = 'authorization-matrix';

/**
 * The environment and stand-ins that turn `features` on for createTestApp
 * (the weather against weather-stub.ts, the order mail against
 * jmap-stub.ts, with the harness's owner as ORDER_MAIL_OWNER); `close`
 * stops the stand-ins. authorization-coverage.spec.ts boots with every one.
 */
export async function featureApp(features: ReadonlySet<Feature>): Promise<{
  env: Env;
  options: TestAppOptions;
  close: () => Promise<void>;
}> {
  const [weather, jmap] = await Promise.all([
    features.has('weather') ? startWeatherStub() : undefined,
    features.has('orderMail') ? startJmapStub(ORDER_MAIL_TOKEN) : undefined,
  ]);
  return {
    env: {
      ...(weather ? { WEATHER_ENABLED: 'true' } : {}),
      ...(jmap
        ? {
            ORDER_MAIL_JMAP_TOKEN: ORDER_MAIL_TOKEN,
            ORDER_MAIL_SENDERS: 'orders@example.com',
            ORDER_MAIL_OWNER: OWNER_EMAIL,
          }
        : {}),
    },
    options: { weather: weather?.options, orderMail: jmap?.options },
    close: async () => {
      await Promise.all([weather?.close(), jmap?.close()]);
    },
  };
}

/** Every table a wardrobe request could touch. */
const TABLES = [
  'garment',
  'capsule',
  'capsule_garment',
  'garment_wear',
  'garment_repair',
  'file',
  'pending_photo',
  'outfit',
  'outfit_slot',
  'outfit_calendar',
  'selfie',
  'wardrobe_share',
  'personal_access_token',
  'style_profile',
  'week_template',
  'week_plan',
  'week_plan_entry',
  'trip',
  'trip_outfit',
  'trip_item',
  'trip_garment_packed',
  'brand_size',
  'body_measurements',
  // POST /wardrobe marks an order item added (#25).
  'order_item',
  // Muse's needs (#333): a decision settles or sets one aside.
  'option_group',
];

interface Case {
  title: string;
  route: Route;
  actor: ActorName;
  via: Via;
  outcome: Outcome;
}

const casesOf = (routes: Route[]): Case[] =>
  routes.flatMap((route) =>
    route.vias.flatMap((via, i) =>
      (['owner', 'manager', 'viewer', 'stranger', 'anonymous'] as const).map(
        (actor): Case => {
          const expected =
            actor === 'anonymous'
              ? (route.anonymous ?? 'login')
              : route.expect[actor];
          const outcome = Array.isArray(expected) ? expected[i] : expected;
          const where = via === 'ownerId' ? ' ?ownerId=<owner>' : '';
          return {
            title: `${route.name}${where} as ${actor}: ${outcome}`,
            route,
            actor,
            via,
            outcome,
          };
        },
      ),
    ),
  );

/**
 * What an extra test beside a group's matrix reads, set by the matrix's
 * beforeAll (read it inside a test, never at collection).
 */
export interface Matrix {
  t: TestApp;
  actors: Record<ActorName, { id?: number; cookie?: string }>;
  /** The fixture the read-only and refused cases share. */
  shared: Fixture;
}

/** One authorization-<group>.spec.ts's routes, as describeMatrix received them. */
export interface MatrixGroup {
  group: string;
  routes: Route[];
}

/**
 * Set while collectMatrix loads the group files: describeMatrix records its
 * routes here instead of describing them.
 */
let collecting: MatrixGroup[] | undefined;

/**
 * Every group's routes, without running the matrix: loads each
 * authorization-<group>.spec.ts with describeMatrix recording instead of
 * describing (so no suite and no `extras` test is registered in the
 * caller's file). The route-coverage spec (authorization-coverage.spec.ts)
 * holds the app's routes against them.
 */
export async function collectMatrix(
  load: () => Promise<unknown>,
): Promise<MatrixGroup[]> {
  const groups: MatrixGroup[] = [];
  collecting = groups;
  try {
    await load();
  } finally {
    collecting = undefined;
  }
  return groups;
}

/**
 * The matrix for one group of routes: five actors, each route by each via,
 * on its own scratch database (one spec file each, so Vitest runs the groups
 * in parallel), and `extras`, the group's own tests over the same app and
 * fixture.
 */
export function describeMatrix(
  group: string,
  routes: Route[],
  extras?: (matrix: Matrix) => void,
): void {
  if (collecting) {
    collecting.push({ group, routes });
    return;
  }
  describe(`authorization matrix: ${group}`, () => {
    let t: TestApp;
    const actors = {} as Record<ActorName, { id?: number; cookie?: string }>;
    /** Read-only and refused cases share it; successful writes get their own. */
    let shared: Fixture;
    let photo: Buffer;
    let cutout: Buffer;
    /** The link import's "internet": a shop serving /photo.jpg. */
    let sites: LinkSites;
    /** The stand-ins of the features the group's routes need. */
    let features: Awaited<ReturnType<typeof featureApp>> | undefined;

    const signUp = async (email: string) => {
      const cookie = await t.register(email);
      const id = await userIdOf(t, email);
      return { id, cookie };
    };

    /** A new open invite link to the owner's wardrobe; its token. */
    const createInviteLink = async (permission: 'VIEW' | 'MANAGE') => {
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission },
        headers: { cookie: actors.owner.cookie, 'hx-request': 'true' },
      });
      const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(res.body);
      if (!token) throw new Error(`No invite URL in partial:\n${res.body}`);
      return token[1];
    };

    const share = async (grantee: SignedIn, permission: 'VIEW' | 'MANAGE') => {
      const token = await createInviteLink(permission);
      const accept = await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${token}/accept`,
        headers: { cookie: actors[grantee].cookie },
      });
      expect(accept.headers.location).toBe('/auth/profile#sharing');
    };

    /** The owner's Muse needs and picks (#333), written through the one writers. */
    const museFixture = async (tag: string) => {
      const ownerId = t.owner.id;
      const cookie = actors.owner.cookie!;
      const need = async (name: string) => {
        const [row] = await t.db
          .insert(optionGroup)
          .values({ ownerId, name, budget: '100' })
          .returning({ id: optionGroup.id });
        return row.id;
      };
      const pick = async (name: string, groupId: number) => {
        const id = await createWishlistItem(t, { name, price: '90', cookie });
        const marked = await markSuggestion(t.db, ownerId, id, {
          tokenId: null,
          groupId,
          note: `Muse on ${name}`,
          rank: null,
        });
        if (marked !== 'marked') throw new Error(`${name}: ${marked}`);
        return id;
      };
      const decided = async (decision: SuggestionDecision) => {
        const outcome = await decide(t.db, ownerId, decision);
        if (!outcome.ok) throw new Error(`${decision.kind}: ${outcome.reason}`);
      };
      const needName = `Need ${tag}`;
      const needId = await need(needName);
      const needPickId = await pick(`Pick ${tag}`, needId);
      const setAsidePickId = await pick(`Aside ${tag}`, needId);
      await decided({
        kind: 'dismiss-pick',
        garmentId: setAsidePickId,
        reason: 'too_pricey',
        note: null,
      });
      const asideNeedId = await need(`Aside need ${tag}`);
      await decided({
        kind: 'dismiss-group',
        groupId: asideNeedId,
        reason: 'not_now',
        note: null,
      });
      const boughtPickId = await pick(
        `Bought ${tag}`,
        await need(`Bought need ${tag}`),
      );
      const bought = await setGarmentStatus(t.db, boughtPickId, ownerId, {
        event: 'buy',
        acquiredOn: null,
        price: null,
      });
      if (!bought.ok) throw new Error(`Bought ${tag}: ${bought.reason}`);
      await decided({ kind: 'bought', garmentId: boughtPickId });
      return {
        needId,
        needName,
        needPickId,
        setAsidePickId,
        asideNeedId,
        boughtPickId,
      };
    };

    const createFixture = async (): Promise<Fixture> => {
      const cookie = actors.owner.cookie!;
      const tag = randomUUID().slice(0, 8);
      const garmentName = `Coat ${tag}`;
      const capsuleName = `Capsule ${tag}`;
      const outfitName = `Look ${tag}`;
      const garmentId = await createGarment(t, { name: garmentName, cookie });
      await uploadPhoto(t, garmentId, photo, cookie);
      // Its cutout failed (no queue runs here), so "Try again" requeues it:
      // a job taken and failed through the cutout's state machine.
      const fileName = await photoFileName(t, garmentId);
      const started = await recordCutoutEvent(t.db, fileName, {
        type: 'start',
        worker: 'authorization-matrix',
      });
      if (!started.ok || started.state.jobVersion === null) {
        throw new Error(`The cutout of ${fileName} did not start`);
      }
      const failed = await recordCutoutEvent(t.db, fileName, {
        type: 'fail',
        jobVersion: started.state.jobVersion,
      });
      if (!failed.ok) throw new Error(`The cutout of ${fileName} did not fail`);
      const wishlistName = `Wish ${tag}`;
      const brand = `Brand ${tag}`;
      const wishlistId = await createWishlistItem(t, {
        name: wishlistName,
        brand,
        replaces: garmentId,
        cookie,
      });
      const brandSizeId = await addBrandSize(t.db, t.owner.id, {
        brand,
        size: 'M',
        note: OWNER_SIZE_NOTE,
      });
      if (brandSizeId === 'brand-taken') throw new Error(`${brand} is taken`);
      const muse = await museFixture(tag);
      const archivedName = `Old ${tag}`;
      const archivedId = await createGarment(t, { name: archivedName, cookie });
      const archived = await t.inject({
        method: 'POST',
        url: `/wardrobe/${archivedId}/archive`,
        headers: { cookie },
      });
      expect(archived.statusCode).toBe(200);

      const created = await t.inject({
        method: 'POST',
        url: '/capsules',
        payload: { name: capsuleName },
        headers: { cookie },
      });
      const capsuleId = Number(
        /^\/capsules\/(\d+)\?/.exec(created.headers.location as string)?.[1],
      );
      expect(capsuleId).toBeGreaterThan(0);
      const chosen = await t.inject({
        method: 'POST',
        url: `/capsules/${capsuleId}/garments`,
        payload: { ids: [garmentId], shown: [garmentId] },
        headers: { cookie },
      });
      expect(chosen.statusCode).toBe(303);

      const outfit = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload: {
          name: outfitName,
          category: 'shirt',
          garmentId: String(garmentId),
        },
        headers: { cookie },
      });
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(outfit.headers.location as string)?.[1],
      );
      expect(outfitId).toBeGreaterThan(0);
      // Muse's outfits (#335): the garment with the wishlist item, then
      // marked as proposed, as the agent's tool will (phase 3).
      const museOutfit = async (
        reaction: 'proposed' | 'declined',
        garments: number[],
      ) => {
        const made = await t.inject({
          method: 'POST',
          url: '/outfits',
          payload: {
            name: `Muse ${reaction} ${tag}`,
            category: garments.map(() => 'shirt'),
            garmentId: garments.map(String),
          },
          headers: { cookie },
        });
        const id = Number(
          /^\/outfits\/(\d+)$/.exec(made.headers.location as string)?.[1],
        );
        expect(id, made.body).toBeGreaterThan(0);
        await t.db
          .update(outfitTable)
          .set({
            proposedAt: new Date(),
            proposalNote: 'Why this',
            reaction,
            dismissedReason: reaction === 'declined' ? 'style' : null,
          })
          .where(eq(outfitTable.id, id));
        return id;
      };
      // Garment sets of their own: a save of a set already saved reuses it.
      const museOutfitId = await museOutfit('proposed', [
        garmentId,
        wishlistId,
      ]);
      const museDeclinedId = await museOutfit('declined', [wishlistId]);

      const today = t.today();
      const scheduled = await t.inject({
        method: 'POST',
        url: '/calendar',
        payload: { date: today, outfitId: String(outfitId) },
        headers: { cookie },
      });
      expect(scheduled.statusCode).toBe(302);
      const [entry] = await t.db
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(eq(outfitCalendar.outfitId, outfitId));
      // The owner's mirror photo (#19) of the same outfit yesterday, which
      // marks that entry worn (today's stays unworn for the pages' wear
      // controls and the worn pill).
      const ownSelfie = await takeSelfie(
        t,
        await planEntry(t, outfitId, addDays(today, -1), cookie),
        cookie,
      );

      await saveStyleProfile(t.db, t.owner.id, {
        ...EMPTY_STYLE_PROFILE,
        notes: OWNER_STYLE_NOTE,
      });

      const tripName = `Trip ${tag}`;
      const newTrip = async (name: string) => {
        const created = await t.inject({
          method: 'POST',
          url: '/trips',
          payload: { name, startsOn: today, endsOn: addDays(today, 1) },
          headers: { cookie },
        });
        const id = Number(
          /^\/trips\/(\d+)\?/.exec(created.headers.location as string)?.[1],
        );
        expect(id).toBeGreaterThan(0);
        return id;
      };
      const tripId = await newTrip(tripName);
      const otherTripId = await newTrip(`Other ${tag}`);
      for (const [url, payload] of [
        [
          `/trips/${tripId}/outfits`,
          { outfitId: String(outfitId), day: today },
        ],
        [`/trips/${tripId}/items`, { label: 'Charger' }],
        [`/trips/${tripId}/packed`, { packed: String(garmentId) }],
        [`/trips/${otherTripId}/items`, { label: 'Passport' }],
      ] as const) {
        const res = await t.inject({
          method: 'POST',
          url,
          payload,
          headers: { cookie },
        });
        expect(res.statusCode, url).toBe(303);
      }
      const [{ id: tripOutfitId }] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, tripId));
      const [{ id: tripItemId }] = await t.db
        .select({ id: tripItem.id })
        .from(tripItem)
        .where(eq(tripItem.tripId, tripId));
      const repairId = await addRepair(t.db, t.owner.id, garmentId, {
        day: today,
        kind: 'repair',
        note: `Mended ${tag}`,
        cost: '12.00',
      });
      if (repairId === undefined) throw new Error('No repair logged');

      const orderItemName = `Ordered ${tag}`;
      const listed = await recordOrderEmail(
        t.db,
        {
          accountId: 'authorization-matrix',
          emailId: `order-${tag}`,
          receivedAt: new Date(),
          outcome: 'imported',
        },
        t.owner.id,
        today,
        [
          {
            productUrl: sites.url(`/products/${tag}`),
            name: orderItemName,
            brand: null,
            price: '30.00',
            currency: 'USD',
          },
        ],
      );
      expect(listed).toBe(1);
      const [{ id: orderItemId }] = await t.db
        .select({ id: orderItem.id })
        .from(orderItem)
        .where(eq(orderItem.name, orderItemName));
      const [{ id: weekPlanId }] = await t.db
        .insert(weekPlan)
        .values({ ownerId: t.owner.id })
        .returning({ id: weekPlan.id });
      const inviteToken = await createInviteLink('VIEW');
      const [{ id: inviteShareId }] = await t.db
        .select({ id: wardrobeShare.id })
        .from(wardrobeShare)
        .where(eq(wardrobeShare.inviteToken, inviteToken));
      return {
        garmentId,
        garmentName,
        wishlistId,
        wishlistName,
        ...muse,
        archivedId,
        archivedName,
        capsuleId,
        capsuleName,
        outfitId,
        outfitName,
        museOutfitId,
        museDeclinedId,
        entryId: entry.id,
        selfieId: ownSelfie.id,
        selfieFileName: ownSelfie.fileName,
        selfieShareableId: ownSelfie.shareableId,
        today,
        ownerId: t.owner.id,
        tripId,
        tripName,
        tripOutfitId,
        tripItemId,
        otherTripId,
        brand,
        brandSizeId,
        repairId,
        orderItemId,
        orderItemName,
        weekPlanId,
        inviteShareId,
        photo,
        cutout,
        shopPhotoUrl: sites.url('/photo.jpg'),
        ownerToken: async () => {
          const token = await createToken(t.db, t.owner.id, OWNER_TOKEN_NAME);
          if (!token.created)
            throw new Error('The owner holds too many tokens');
          return token.id;
        },
      };
    };

    const results = {} as Matrix;

    /**
     * What a request could have changed, in one statement: an md5 per table
     * over its rows as text, sorted (equal digests are equal rows), and the
     * photo files on disk. Refused and read-only cases compare digests alone;
     * only a difference fetches rows, to name what changed (changedRows).
     * Selecting every row of 25 tables twice per case was over a third of the
     * matrix's time (#113).
     */
    const snapshot = async (): Promise<Record<string, string>> => {
      const { rows } = await t.db.execute<{ name: string; digest: string }>(
        sql.raw(
          TABLES.map(
            (table) =>
              `select '${table}' as name, md5(coalesce(string_agg(r::text, E'\\n' order by r::text), '')) as digest from "${table}" r`,
          ).join(' union all '),
        ),
      );
      const stored = (await readdir(t.dataPath))
        .filter((name) => name.endsWith('.webp'))
        .sort();
      return {
        ...Object.fromEntries(rows.map((row) => [row.name, row.digest])),
        stored: stored.join(' '),
      };
    };

    const changedTables = (
      before: Record<string, string>,
      after: Record<string, string>,
    ): string[] =>
      Object.keys(after).filter((key) => after[key] !== before[key]);

    /** The rows now in each changed table: a failure's explanation. */
    const changedRows = async (changed: string[]): Promise<string[]> => {
      const lines = await Promise.all(
        changed.map(async (table) => {
          if (table === 'stored') return ['stored photo files changed'];
          const result = await t.db.execute<Record<string, unknown>>(
            sql.raw(`select * from "${table}"`),
          );
          return [
            `${table} changed; now:`,
            ...result.rows.map((row) => `  ${JSON.stringify(row)}`),
          ];
        }),
      );
      return lines.flat();
    };

    /**
     * Every row a wardrobe request could touch plus the photo files, one
     * sorted string per row: a clone's success is judged row by row (rows
     * added, none modified).
     */
    const allRows = async (): Promise<string[]> => {
      const rows = await Promise.all(
        TABLES.map(async (table) => {
          const result = await t.db.execute<Record<string, unknown>>(
            sql.raw(`select * from "${table}"`),
          );
          return result.rows.map((row) => `${table} ${JSON.stringify(row)}`);
        }),
      );
      const stored = (await readdir(t.dataPath))
        .filter((name) => name.endsWith('.webp'))
        .map((name) => `stored ${name}`);
      return [...rows.flat(), ...stored].sort();
    };

    const send = (
      actor: ActorName,
      request: InjectOptions,
    ): Promise<LightMyRequestResponse> => {
      const { cookie } = actors[actor];
      return t.inject({
        ...request,
        headers: { ...request.headers, ...(cookie ? { cookie } : {}) },
        anonymous: actor === 'anonymous',
      });
    };

    const REFUSED_STATUS: Record<Exclude<Outcome, 'ok' | 'ignored'>, number> = {
      hidden: 200,
      forbidden: 403,
      notFound: 404,
      login: 302,
      unauthorized: 401,
    };

    /**
     * The answer: a success's status (a read that shows its subject names
     * it), or a refusal's, leaking nothing.
     */
    const expectAnswer = (
      route: Route,
      outcome: Outcome,
      res: LightMyRequestResponse,
      secret: string,
    ) => {
      if (outcome === 'ok') {
        expect(res.statusCode).toBe(route.ok);
        if (route.kind === 'read' && route.shows) {
          expect(res.body).toContain(secret);
        }
        return;
      }
      expect(res.statusCode).toBe(
        outcome === 'ignored' ? route.ok : REFUSED_STATUS[outcome],
      );
      if (outcome === 'login') expect(res.headers.location).toBe(LOGIN_PATH);
      expect(res.body).not.toContain(secret);
    };

    /** A clone lands in the requester's wardrobe and only adds rows. */
    const expectCloned = async (
      route: Route,
      actor: ActorName,
      request: InjectOptions,
    ) => {
      const before = await allRows();
      const res = await send(actor, request);
      const after = await allRows();
      expect(res.statusCode).toBe(route.ok);
      const cloneId = Number(
        /^\/wardrobe\/(\d+)$/.exec(res.headers.location as string)?.[1],
      );
      const clone = await garmentRow(t, cloneId);
      expect(clone?.ownerId).toBe(actors[actor].id);
      // Added rows only: nothing that existed (the source) was modified.
      expect(after).toEqual(expect.arrayContaining(before));
    };

    beforeAll(async () => {
      sites = await startLinkSites();
      features = await featureApp(
        new Set(routes.flatMap(({ feature }) => feature ?? [])),
      );
      t = await createTestApp(features.env, {
        ...features.options,
        outboundFetch: sites.outboundFetch,
      });
      [photo, cutout] = await Promise.all([
        jpegPhoto(320, 240),
        pngCutout(320, 240),
      ]);
      sites.serve('/photo.jpg', jpeg(photo));
      actors.owner = t.owner;
      actors.manager = await signUp('manager@example.com');
      actors.viewer = await signUp('viewer@example.com');
      actors.stranger = await signUp('stranger@example.com');
      actors.anonymous = {};
      await share('manager', 'MANAGE');
      await share('viewer', 'VIEW');
      shared = await createFixture();
      Object.assign(results, { t, actors, shared });
    });

    afterAll(async () => {
      await t?.cleanup();
      await sites?.close();
      await features?.close();
    });

    it.each(casesOf(routes))(
      '$title',
      async ({ route, actor, via, outcome }) => {
        const mutates = outcome === 'ok' && route.kind === 'write';
        const fixture = mutates ? await createFixture() : shared;
        const secret = route.secret(fixture);
        const ownerQuery =
          via === 'ownerId' ? `?ownerId=${actors.owner.id}` : '';
        const request = await route.request(fixture, ownerQuery);

        if (outcome === 'ok' && route.kind === 'clone') {
          await expectCloned(route, actor, request);
          return;
        }

        const before = await snapshot();
        const res = await send(actor, request);
        const changed = changedTables(before, await snapshot());

        expectAnswer(route, outcome, res, secret);
        // A successful write changed something; nothing else changes a row.
        if (outcome === 'ok' && route.kind === 'write') {
          expect(changed).not.toEqual([]);
          return;
        }
        expect(await changedRows(changed)).toEqual([]);
      },
    );

    extras?.(results);
  });
}
