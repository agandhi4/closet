import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outfit, outfitCalendar, outfitSlot } from '../../src/db/schema';
import { createToken } from '../../src/web/auth/personal-tokens';
import { changeCandidates } from '../../src/web/plans/candidates';
import { insertItems, saveStyleProfile } from '../../src/web/plans/queries';
import { EMPTY_STYLE_PROFILE } from '../../src/web/plans/validation';
import { LOGIN_PATH } from '../../src/web/auth/session-access';
import type { IsoDate } from '../../src/web/calendar/calendar-date';
import {
  createGarment,
  createWishlistItem,
  garmentRow,
  jpegPhoto,
  pngCutout,
  uploadPhoto,
} from './garments';
import {
  createTestApp,
  multipart,
  TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { jpeg, type LinkSites, startLinkSites } from './link-sites';

/**
 * The object-level authorization matrix. One owner (the harness's default
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
 * property like any other (MANAGE writes it). /laundry is always the
 * requester's own: another user's ids are ignored. Wardrobe plans and the
 * style profile (#34) are private like outfits: every refusal is a 404 or
 * the requester's own; starting a plan from the owner's closet needs a view
 * of it and lands in the requester's plans. The shopping loop (#34b) is the
 * plans': the shopping list, comparing, and both sides of a candidate link
 * are the owner's alone, and "Bought it"'s plan follow-ups are refused to a
 * grantee who may buy.
 */

type SignedIn = 'owner' | 'manager' | 'viewer' | 'stranger';
type ActorName = SignedIn | 'anonymous';
/** own: the URL as the app links it; ownerId: `?ownerId=<owner>` appended. */
type Via = 'own' | 'ownerId';

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
type Outcome =
  | 'ok'
  | 'hidden'
  | 'ignored'
  | 'forbidden'
  | 'notFound'
  | 'login'
  | 'unauthorized';

interface Fixture {
  garmentId: number;
  garmentName: string;
  /** A wishlist item replacing the garment (#18). */
  wishlistId: number;
  wishlistName: string;
  /** An archived garment (Restore). */
  archivedId: number;
  archivedName: string;
  /** A capsule holding the garment. */
  capsuleId: number;
  capsuleName: string;
  outfitId: number;
  outfitName: string;
  /** The calendar entry, planned on `today` (so worn may mark it). */
  entryId: number;
  /** The owner's id (the wardrobe a plan is started from). */
  ownerId: number;
  /** A wardrobe plan of the owner's (#34), not active past the first fixture. */
  planId: number;
  planName: string;
  /** An item of it their agent proposed (so accepting it writes). */
  planItemId: number;
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
}

interface Route {
  name: string;
  kind: 'read' | 'write' | 'clone';
  /** Status the route answers on success. */
  ok: number;
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

const BOTH: Via[] = ['own', 'ownerId'];
const garmentName = (f: Fixture) => f.garmentName;
const wishlistName = (f: Fixture) => f.wishlistName;
const archivedName = (f: Fixture) => f.archivedName;
const capsuleName = (f: Fixture) => f.capsuleName;
const outfitName = (f: Fixture) => f.outfitName;
const planName = (f: Fixture) => f.planName;
// One style profile per user, so one note every fixture saves again.
const OWNER_STYLE_NOTE = 'Owner style notes, never shared';
const styleNote = () => OWNER_STYLE_NOTE;
// A calendar chip whose outfit has photos shows thumbnails, not the name,
// so the chip's link stands in for it. (Error pages echo the request path,
// which rules out the /calendar/:id URLs themselves.)
const calendarEntry = (f: Fixture) =>
  `/outfits/${f.outfitId}/edit?returnTo=/calendar`;
const OWNER_TOKEN_NAME = 'Owner laptop token';

let photo: Buffer;
let cutout: Buffer;
/** The link import's "internet": a shop serving /photo.jpg. */
let sites: LinkSites;

const ROUTES: Route[] = [
  // Wardrobe-level routes: the only id they take is ?ownerId.
  {
    name: 'GET /wardrobe',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe${q}` }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    name: 'GET /wardrobe/new',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/new${q}` }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe',
    kind: 'write',
    ok: 302,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({
      method: 'POST',
      url: `/wardrobe${q}`,
      payload: { name: 'Planted', category: 'shirt' },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  // Adding from a link (link-import/routes.tsx) is a write to the addressed
  // wardrobe. The two posts fetch a photo from the local shop and store it
  // (bytes only, no row), which is the change a success makes.
  {
    name: 'GET /wardrobe/new/from-link',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/new/from-link${q}` }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/new/from-link',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({
      method: 'POST',
      url: `/wardrobe/new/from-link${q}`,
      payload: { url: sites.url('/photo.jpg') },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/new/from-link/photo',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({
      method: 'POST',
      url: `/wardrobe/new/from-link/photo${q}`,
      payload: { url: sites.url('/photo.jpg') },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    // Not `shows`: the card is the wardrobe's newest untagged garment, and
    // other cases add garments to the owner's wardrobe, so which one it is
    // depends on order. Refusals must still leak no name. Without ?ownerId
    // a grantee tags their own wardrobe.
    name: 'GET /wardrobe/tag',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/tag${q}` }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'forbidden'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    // Only ?ownerId: without it a grantee addresses their own wardrobe,
    // where the owner's ids are ignored like unknown ones (a 303 that
    // changes nothing; garment-bulk.spec.ts covers it).
    name: 'POST /wardrobe/bulk',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: ['ownerId'],
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/bulk${q}`,
      payload: { ids: [f.garmentId], property: 'warmth', warmth: '4' },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },

  // Garment routes. Without ?ownerId a grantee addresses their own wardrobe,
  // which does not hold the owner's garment.
  {
    name: 'GET /wardrobe/:id',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({ method: 'GET', url: `/wardrobe/${f.garmentId}${q}` }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/:id/edit',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.garmentId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // A VIEW grantee may clone (audit L3): the copy lands in the grantee's
    // own wardrobe and the owner's data is only read. The garment page shows
    // the button to everyone who can see the garment (tested below).
    name: 'GET /wardrobe/:id/clone',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.garmentId}/clone${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/clone',
    kind: 'clone',
    ok: 302,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/clone${q}`,
      payload: { name: 'Cloned', category: 'shirt' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id',
    kind: 'write',
    ok: 302,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}${q}`,
      payload: { name: 'Edited', category: 'pants' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/tag',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/tag${q}`,
      payload: { warmth: '3' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // The garment is looked up before the body is read, so a refused upload
    // stores nothing; the snapshot includes DATA_PATH, which proves it.
    name: 'POST /wardrobe/:id/photo',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          photo: {
            data: photo,
            filename: 'photo.jpg',
            contentType: 'image/jpeg',
          },
        },
      );
      return {
        method: 'POST',
        url: `/wardrobe/${f.garmentId}/photo${q}`,
        ...body,
      };
    },
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/nobg',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          nobgPhoto: {
            data: cutout,
            filename: 'cutout.png',
            contentType: 'image/png',
          },
        },
      );
      return {
        method: 'POST',
        url: `/wardrobe/${f.garmentId}/nobg${q}`,
        ...body,
      };
    },
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  // The wishlist (#18): shared like capsules. Without ?ownerId a grantee
  // sees their own (empty) wishlist.
  {
    name: 'GET /wardrobe/wishlist',
    kind: 'read',
    ok: 200,
    secret: wishlistName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/wishlist${q}` }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    name: 'GET /wardrobe/:id/bought',
    kind: 'read',
    ok: 200,
    secret: wishlistName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.wishlistId}/bought${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // "Bought it" is a garment write (the owner and MANAGE); archiving the
    // garment it replaces is the owner's (wishlist.spec.ts: a grantee asking
    // for it is a 403).
    name: 'POST /wardrobe/:id/bought',
    kind: 'write',
    ok: 303,
    secret: wishlistName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.wishlistId}/bought${q}`,
      payload: { acquiredOn: f.today, price: '10' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/restore',
    kind: 'write',
    ok: 200,
    secret: archivedName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.archivedId}/restore${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // Archive and delete are owner-only, even for a MANAGE grantee.
    name: 'POST /wardrobe/:id/archive',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/archive${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'DELETE /wardrobe/:id',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/wardrobe/${f.garmentId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },

  // Wears, washes and away (#7): the owner's own records about a garment a
  // grantee may see, so `?ownerId=` is a 403 and their own wardrobe a 404.
  // Plain posts (no htmx): the 303 back to the garment.
  ...(['wear', 'washed', 'away'] as const).map(
    (action): Route => ({
      name: `POST /wardrobe/:id/${action}`,
      kind: 'write',
      ok: 303,
      secret: garmentName,
      vias: BOTH,
      request: (f, q) => ({
        method: 'POST',
        url: `/wardrobe/${f.garmentId}/${action}${q}`,
        payload: {
          wear: { worn: '1' },
          washed: {},
          away: { away: 'lent', awayNote: 'Planted note' },
        }[action],
      }),
      expect: {
        owner: 'ok',
        manager: ['notFound', 'forbidden'],
        viewer: ['notFound', 'forbidden'],
        stranger: 'notFound',
      },
    }),
  ),
  {
    // Condition is a garment property: the owner and a MANAGE grantee.
    name: 'POST /wardrobe/:id/condition',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/condition${q}`,
      payload: { condition: 'needs_repair', conditionNote: 'Planted' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },

  // Capsules are part of the wardrobe (owner decision on #8): the same
  // ?ownerId= resolution as the garment routes. Without ?ownerId a grantee
  // addresses their own wardrobe, which holds no such capsule.
  {
    name: 'GET /capsules',
    kind: 'read',
    ok: 200,
    secret: capsuleName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/capsules${q}` }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    name: 'GET /capsules/new',
    kind: 'read',
    ok: 200,
    secret: capsuleName,
    vias: ['ownerId'],
    request: (_, q) => ({ method: 'GET', url: `/capsules/new${q}` }),
    expect: {
      owner: 'ok',
      manager: 'forbidden',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /capsules',
    kind: 'write',
    ok: 303,
    secret: capsuleName,
    vias: ['ownerId'],
    request: (_, q) => ({
      method: 'POST',
      url: `/capsules${q}`,
      payload: { name: 'Planted capsule' },
    }),
    expect: {
      owner: 'ok',
      manager: 'forbidden',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /capsules/:id',
    kind: 'read',
    ok: 200,
    secret: capsuleName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({ method: 'GET', url: `/capsules/${f.capsuleId}${q}` }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /capsules/:id/edit',
    kind: 'read',
    ok: 200,
    secret: capsuleName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/capsules/${f.capsuleId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /capsules/:id',
    kind: 'write',
    ok: 303,
    secret: capsuleName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/capsules/${f.capsuleId}${q}`,
      // A name of its own: an owner's capsule names are unique.
      payload: { name: `Renamed ${f.capsuleName}` },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'DELETE /capsules/:id',
    kind: 'write',
    ok: 200,
    secret: capsuleName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/capsules/${f.capsuleId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // The picker's Save: the garment was shown and left unchecked, so it
    // leaves the capsule (a change a refusal must not make).
    name: 'POST /capsules/:id/garments',
    kind: 'write',
    ok: 303,
    secret: capsuleName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/capsules/${f.capsuleId}/garments${q}`,
      payload: { shown: [f.garmentId] },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // The garment page's toggles: the capsule was listed and unchecked.
    name: 'POST /wardrobe/:id/capsules',
    kind: 'write',
    ok: 200,
    secret: capsuleName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/capsules${q}`,
      payload: { shown: [f.capsuleId] },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // The grid filtered to the capsule: without ?ownerId a grantee's own
    // wardrobe has no such capsule.
    name: 'GET /wardrobe?capsule=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe${q ? `${q}&` : '?'}capsule=${f.capsuleId}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    // The picker. A VIEW grantee gets the grid without it, as with
    // ?select=1; in their own wardrobe the capsule is unknown. Narrowed to
    // the garment by name: successful writes (clones, purchases, restores)
    // add newer garments, which would push it off the first page.
    name: 'GET /wardrobe?pick=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe${q ? `${q}&` : '?'}pick=${f.capsuleId}&keyword=${encodeURIComponent(f.garmentName)}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },

  // Outfits and calendar are not shared and ignore ?ownerId; the ownerId
  // via proves a grantee cannot reach them by naming the owner.
  {
    name: 'GET /outfits',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/outfits${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    // Building from a capsule: the requester's own capsules only, whatever
    // the share (outfits hold only their owner's garments).
    name: 'GET /outfits/new?capsule=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/outfits/new${q ? `${q}&` : '?'}capsule=${f.capsuleId}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // The builder's row within a capsule: someone else's capsule cycles
    // none of the requester's garments (an empty row, nothing revealed).
    name: 'GET /outfits/row-fragment?capsule=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/outfits/row-fragment${q ? `${q}&` : '?'}category=shirt&capsule=${f.capsuleId}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'GET /outfits/:id',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({ method: 'GET', url: `/outfits/${f.outfitId}${q}` }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /outfits/:id/edit',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/outfits/${f.outfitId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /outfits/:id',
    kind: 'write',
    ok: 302,
    secret: outfitName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/outfits/${f.outfitId}${q}`,
      payload: { name: 'Renamed' },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'DELETE /outfits/:id',
    kind: 'write',
    ok: 200,
    secret: outfitName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/outfits/${f.outfitId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /calendar',
    kind: 'read',
    ok: 200,
    secret: calendarEntry,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/calendar${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    // The plan page lists the requester's own outfits to plan (#13).
    name: 'GET /calendar/plan',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({
      method: 'GET',
      url: `/calendar/plan${q ? `${q}&` : '?'}for=day:2030-10-09&occasion=evening`,
    }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'POST /calendar',
    kind: 'write',
    ok: 302,
    secret: outfitName,
    vias: BOTH,
    // Not the entry's day: the fixture already planned the outfit then, and
    // scheduling is idempotent, so the same day would change no row.
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar${q}`,
      payload: {
        date: '2030-10-09',
        outfitId: String(f.outfitId),
        occasion: 'evening',
      },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /calendar/:id/delete',
    kind: 'write',
    ok: 303,
    secret: calendarEntry,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar/${f.entryId}/delete${q}`,
      payload: { week: f.today },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // The requester's own hamper whatever `?ownerId=` says. Not `shows`:
    // the fixture's garment is not worn (the owner's page lists nothing).
    name: 'GET /laundry',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/laundry${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'POST /laundry',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/laundry${q}`,
      payload: { ids: [String(f.garmentId)] },
    }),
    expect: {
      owner: 'ok',
      manager: 'ignored',
      viewer: 'ignored',
      stranger: 'ignored',
    },
  },
  // Wardrobe plans and the style profile (#34) are the owner's own, like
  // outfits: never shared, ?ownerId= ignored, another user's plan a 404.
  {
    name: 'GET /wardrobe/plans',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/plans${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'GET /wardrobe/plans/:id',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/plans/${f.planId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/plans/:id/edit',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/plans/${f.planId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/plans/:id',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}${q}`,
      payload: { name: `Renamed ${f.planName}` },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'DELETE /wardrobe/plans/:id',
    kind: 'write',
    ok: 200,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/wardrobe/plans/${f.planId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // Every fixture after the first holds an inactive plan: activating it
    // moves the owner's active plan.
    name: 'POST /wardrobe/plans/:id/activate',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/activate${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/plans/:id/duplicate',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/duplicate${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/plans/:id/items',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/items${q}`,
      payload: { category: 'tops' },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/plans/:id/items/:itemId',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/items/${f.planItemId}${q}`,
      payload: { category: 'bottoms' },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // The fixture's item is a proposal (the agent's), so accepting it writes.
    name: 'POST /wardrobe/plans/:id/items/:itemId/accept',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/items/${f.planItemId}/accept${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'DELETE /wardrobe/plans/:id/items/:itemId',
    kind: 'write',
    ok: 200,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/wardrobe/plans/${f.planId}/items/${f.planItemId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // Start a plan from the owner's closet: needs a view of it, like a
    // clone, and lands in the requester's own plans.
    name: 'POST /wardrobe/plans/from-wardrobe',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: ['own'],
    request: (f) => ({
      method: 'POST',
      url: '/wardrobe/plans/from-wardrobe',
      payload: { ownerId: String(f.ownerId) },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'ok',
      stranger: 'notFound',
    },
  },
  // The shopping loop (#34b) is the plans': the owner's own, ?ownerId=
  // ignored, anyone else's plan, item or wishlist item a 404.
  {
    name: 'GET /wardrobe/shopping?plan=',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/shopping${q ? `${q}&` : '?'}plan=${f.planId}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/plans/compare',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/plans/compare${q ? `${q}&` : '?'}a=${f.planId}&b=${f.planId}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/plans/:id/items/:itemId/candidates',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/plans/${f.planId}/items/${f.planItemId}/candidates${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // Unticks the fixture's candidate (the wishlist item), so it writes.
    name: 'POST /wardrobe/plans/:id/items/:itemId/candidates',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/items/${f.planItemId}/candidates${q}`,
      payload: { shown: [String(f.wishlistId)] },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/:id/plan-items',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.wishlistId}/plan-items${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/plan-items',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.wishlistId}/plan-items${q}`,
      payload: { shown: [String(f.planItemId)] },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // "Bought it" with a plan follow-up: the plans are the owner's, so a
    // MANAGE grantee who may buy may not ask for it.
    name: 'POST /wardrobe/:id/bought (plan follow-ups)',
    kind: 'write',
    ok: 303,
    secret: wishlistName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.wishlistId}/bought${q}`,
      payload: {
        acquiredOn: f.today,
        price: '10',
        adjustItems: [String(f.planItemId)],
      },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // Everyone's own profile; the owner's notes never reach anyone else.
    name: 'GET /auth/profile/style',
    kind: 'read',
    ok: 200,
    secret: styleNote,
    shows: true,
    vias: ['own'],
    request: () => ({ method: 'GET', url: '/auth/profile/style' }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  // Agent access (#33): a user's own tokens only. Not object-level through
  // a share: tokens are the account's, like its password.
  {
    name: 'GET /auth/tokens',
    kind: 'read',
    ok: 200,
    secret: () => OWNER_TOKEN_NAME,
    shows: true,
    vias: ['own'],
    request: async (f) => {
      await f.ownerToken();
      return { method: 'GET', url: '/auth/tokens' };
    },
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'POST /auth/tokens/:id/revoke',
    kind: 'write',
    ok: 303,
    secret: () => OWNER_TOKEN_NAME,
    vias: ['own'],
    request: async (f) => ({
      method: 'POST',
      url: `/auth/tokens/${await f.ownerToken()}/revoke`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // The MCP endpoint takes a bearer token and nothing else: every
    // session, the owner's included, is a 401 (mcp.spec.ts drives the tools
    // with tokens, shares included).
    name: 'POST /mcp (a session cookie)',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_garment',
          arguments: {
            id: f.garmentId,
            ...(q ? { ownerId: Number(q.split('=')[1]) } : {}),
          },
        },
      },
    }),
    expect: {
      owner: 'unauthorized',
      manager: 'unauthorized',
      viewer: 'unauthorized',
      stranger: 'unauthorized',
    },
    anonymous: 'unauthorized',
  },
  {
    name: 'POST /calendar/:id/worn',
    kind: 'write',
    ok: 303,
    secret: calendarEntry,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar/${f.entryId}/worn${q}`,
      payload: { week: f.today },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
];

interface Case {
  title: string;
  route: Route;
  actor: ActorName;
  via: Via;
  outcome: Outcome;
}

const CASES: Case[] = ROUTES.flatMap((route) =>
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

describe('authorization matrix', () => {
  let t: TestApp;
  const actors = {} as Record<ActorName, { id?: number; cookie?: string }>;
  /** Read-only and refused cases share it; successful writes get their own. */
  let shared: Fixture;

  const signUp = async (email: string) => {
    const cookie = await t.register(email);
    const id = await userIdOf(t, email);
    return { id, cookie };
  };

  const share = async (grantee: SignedIn, permission: 'VIEW' | 'MANAGE') => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission },
      headers: { cookie: actors.owner.cookie, 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(res.body);
    if (!token) throw new Error(`No invite URL in partial:\n${res.body}`);
    const accept = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token[1]}/accept`,
      headers: { cookie: actors[grantee].cookie },
    });
    expect(accept.headers.location).toBe('/wardrobe-share/manage');
  };

  const createFixture = async (): Promise<Fixture> => {
    const cookie = actors.owner.cookie!;
    const tag = randomUUID().slice(0, 8);
    const garmentName = `Coat ${tag}`;
    const capsuleName = `Capsule ${tag}`;
    const outfitName = `Look ${tag}`;
    const garmentId = await createGarment(t, { name: garmentName, cookie });
    await uploadPhoto(t, garmentId, photo, cookie);
    const wishlistName = `Wish ${tag}`;
    const wishlistId = await createWishlistItem(t, {
      name: wishlistName,
      replaces: garmentId,
      cookie,
    });
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

    const planName = `Plan ${tag}`;
    const plan = await t.inject({
      method: 'POST',
      url: '/wardrobe/plans',
      payload: { name: planName },
      headers: { cookie },
    });
    const planId = Number(
      /^\/wardrobe\/plans\/(\d+)\?/.exec(plan.headers.location as string)?.[1],
    );
    expect(planId).toBeGreaterThan(0);
    const [planItemId] = await insertItems(
      t.db,
      planId,
      [
        {
          name: `Item ${tag}`,
          category: 'tops',
          type: null,
          colors: null,
          materials: null,
          warmthMin: null,
          warmthMax: null,
          formalityMin: null,
          formalityMax: null,
          quantity: 1,
          priority: 'medium',
          budget: null,
          note: null,
        },
      ],
      { proposed: true },
    );
    // The wishlist item is a candidate for it (#34b).
    await changeCandidates(t.db, t.owner.id, {
      add: { itemIds: [planItemId], garmentIds: [wishlistId] },
    });
    await saveStyleProfile(t.db, t.owner.id, {
      ...EMPTY_STYLE_PROFILE,
      notes: OWNER_STYLE_NOTE,
    });
    return {
      garmentId,
      garmentName,
      wishlistId,
      wishlistName,
      archivedId,
      archivedName,
      capsuleId,
      capsuleName,
      outfitId,
      outfitName,
      entryId: entry.id,
      today,
      ownerId: t.owner.id,
      planId,
      planName,
      planItemId,
      ownerToken: async () => {
        const token = await createToken(t.db, t.owner.id, OWNER_TOKEN_NAME);
        if (!token.created) throw new Error('The owner holds too many tokens');
        return token.id;
      },
    };
  };

  /**
   * Every row a wardrobe request could touch plus the photo files on disk,
   * one sorted string per row, so a diff names exactly what changed.
   */
  const snapshot = async (): Promise<string[]> => {
    const tables = [
      'garment',
      'capsule',
      'capsule_garment',
      'garment_wear',
      'file',
      'pending_photo',
      'outfit',
      'outfit_slot',
      'outfit_calendar',
      'wardrobe_share',
      'personal_access_token',
      'wardrobe_plan',
      'plan_item',
      'plan_item_candidate',
      'style_profile',
      'style_rhythm',
    ];
    const rows = await Promise.all(
      tables.map(async (table) => {
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

  interface Observed {
    actor: ActorName;
    res: LightMyRequestResponse;
    secret: string;
    before: string[];
    after: string[];
  }

  const expectSuccess = async (
    route: Route,
    { actor, res, secret, before, after }: Observed,
  ) => {
    expect(res.statusCode).toBe(route.ok);
    if (route.kind === 'read') {
      if (route.shows) expect(res.body).toContain(secret);
      expect(after).toEqual(before);
    } else if (route.kind === 'write') {
      expect(after).not.toEqual(before);
    } else {
      const cloneId = Number(
        /^\/wardrobe\/(\d+)$/.exec(res.headers.location as string)?.[1],
      );
      const clone = await garmentRow(t, cloneId);
      expect(clone?.ownerId).toBe(actors[actor].id);
      // Added rows only: nothing that existed (the source) was modified.
      expect(after).toEqual(expect.arrayContaining(before));
    }
  };

  const REFUSED_STATUS: Record<Exclude<Outcome, 'ok' | 'ignored'>, number> = {
    hidden: 200,
    forbidden: 403,
    notFound: 404,
    login: 302,
    unauthorized: 401,
  };

  const expectRefused = (
    route: Route,
    outcome: Exclude<Outcome, 'ok'>,
    { res, secret, before, after }: Observed,
  ) => {
    expect(res.statusCode).toBe(
      outcome === 'ignored' ? route.ok : REFUSED_STATUS[outcome],
    );
    if (outcome === 'login') expect(res.headers.location).toBe(LOGIN_PATH);
    expect(res.body).not.toContain(secret);
    expect(after).toEqual(before);
  };

  beforeAll(async () => {
    sites = await startLinkSites();
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
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
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it.each(CASES)('$title', async ({ route, actor, via, outcome }) => {
    const mutates = outcome === 'ok' && route.kind === 'write';
    const fixture = mutates ? await createFixture() : shared;
    const secret = route.secret(fixture);
    const { cookie } = actors[actor];
    const ownerQuery = via === 'ownerId' ? `?ownerId=${actors.owner.id}` : '';
    const request = await route.request(fixture, ownerQuery);

    const before = await snapshot();
    const res = await t.inject({
      ...request,
      headers: { ...request.headers, ...(cookie ? { cookie } : {}) },
      anonymous: actor === 'anonymous',
    });
    const after = await snapshot();

    const observed = { actor, res, secret, before, after };

    if (outcome === 'ok') await expectSuccess(route, observed);
    else expectRefused(route, outcome, observed);
  });

  // The page offers what the routes allow: clone to anyone who can see the
  // garment, edit (and condition) to the owner and a MANAGE grantee,
  // archive, delete and the wear section to the owner only.
  it.each([
    ['owner', { clone: true, edit: true, remove: true }],
    ['manager', { clone: true, edit: true, remove: false }],
    ['viewer', { clone: true, edit: false, remove: false }],
  ] as const)(
    'the garment page shows %s the actions they may take',
    async (actor, can) => {
      const q = `?ownerId=${actors.owner.id}`;
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe/${shared.garmentId}${q}`,
        headers: { cookie: actors[actor].cookie },
      });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      const id = shared.garmentId;
      expect(html.includes(`href="/wardrobe/${id}/clone`)).toBe(can.clone);
      expect(html.includes(`href="/wardrobe/${id}/edit`)).toBe(can.edit);
      expect(html.includes('name="photo"')).toBe(can.edit);
      expect(html.includes(`hx-delete="/wardrobe/${id}`)).toBe(can.remove);
      expect(html.includes(`/wardrobe/${id}/archive`)).toBe(can.remove);
      expect(html.includes(`/wardrobe/${id}/condition`)).toBe(can.edit);
      expect(html.includes('id="garment-wear"')).toBe(can.remove);
      expect(html.includes(`/wardrobe/${id}/wear`)).toBe(can.remove);
    },
  );

  // The outfit form posts garment ids; ids outside the requester's own
  // wardrobe are dropped (the row stays, empty), so no outfit can reference
  // a shared garment.
  const slotsOf = async (outfitId: number) => {
    const [row] = await t.db
      .select({ slots: count(), garments: count(outfitSlot.garmentId) })
      .from(outfitSlot)
      .where(eq(outfitSlot.outfitId, outfitId));
    return row;
  };

  it.each(['manager', 'viewer', 'stranger'] as const)(
    "POST /outfits as %s drops the owner's garment ids",
    async (actor) => {
      const res = await t.inject({
        method: 'POST',
        url: `/outfits?ownerId=${actors.owner.id}`,
        payload: {
          name: `Borrowed ${actor}`,
          category: 'shirt',
          garmentId: String(shared.garmentId),
        },
        headers: { cookie: actors[actor].cookie },
      });
      expect(res.statusCode).toBe(302);
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(res.headers.location as string)?.[1],
      );
      const [created] = await t.db
        .select({ ownerId: outfit.ownerId })
        .from(outfit)
        .where(eq(outfit.id, outfitId));
      expect(created.ownerId).toBe(actors[actor].id);
      expect(await slotsOf(outfitId)).toEqual({ slots: 1, garments: 0 });

      const edit = await t.inject({
        method: 'POST',
        url: `/outfits/${outfitId}`,
        payload: { category: 'shirt', garmentId: String(shared.garmentId) },
        headers: { cookie: actors[actor].cookie },
      });
      expect(edit.statusCode).toBe(302);
      expect(await slotsOf(outfitId)).toEqual({ slots: 1, garments: 0 });
    },
  );
});
