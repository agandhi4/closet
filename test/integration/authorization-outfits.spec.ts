import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { outfit, outfitSlot } from '../../src/db/schema';
import { addDays } from '../../src/web/calendar/calendar-date';
import { multipart } from './harness';
import {
  describeMatrix,
  type Route,
  BOTH,
  garmentName,
  outfitName,
  calendarEntry,
  selfieName,
} from './authorization-matrix';

// The authorization matrix (authorization-matrix.ts): outfits, the calendar, laundry, insights, selfies and images.
const ROUTES: Route[] = [
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
    // Styling (#42) from a capsule: the addressed wardrobe's capsule. A
    // grantee styles the owner's through `?ownerId=` (browsing only); by
    // itself the capsule is not in their wardrobe.
    name: 'GET /styling?capsule=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling${q ? `${q}&` : '?'}capsule=${f.capsuleId}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    // A strip's next page within a capsule: someone else's capsule matches
    // none of the requester's garments (an empty page, nothing revealed).
    name: 'GET /styling/garments?capsule=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling/garments${q ? `${q}&` : '?'}role=none&before=2147483647&capsule=${f.capsuleId}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    // "Style this": Styling over a shared wardrobe browses it (a view is
    // enough); Save never takes its garments (POST /styling below). By
    // itself the garment is not in a grantee's wardrobe.
    name: 'GET /styling?with=',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling${q ? `${q}&` : '?'}with=${f.garmentId}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    // Save: the requester's own garments only, whatever the share.
    name: 'POST /styling',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/styling${q}`,
      payload: {
        garmentId: String(f.garmentId),
        scheduleDate: addDays(f.today, 2),
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
    // An outfit opened in Styling (#42; /outfits/:id/edit redirects here).
    name: 'GET /styling?outfit=',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/styling${q ? `${q}&` : '?'}outfit=${f.outfitId}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /styling (an outfit)',
    kind: 'write',
    ok: 303,
    secret: outfitName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/styling${q}`,
      payload: {
        outfit: String(f.outfitId),
        garmentId: String(f.garmentId),
        name: 'Styled again',
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
    // The month of collages (R6): the entry is planned today, in this month,
    // and its cell names its outfit.
    name: 'GET /calendar/month',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/calendar/month${q}` }),
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
    // Insights (#17) read the wear log: the requester's own whatever
    // `?ownerId=` says. The owner's never-worn garment is in their
    // unworn list; nobody else's page names it.
    name: 'GET /wardrobe/insights',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/insights${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    // The year in review (#26) reads the wear log like insights: the
    // requester's own whatever `?ownerId=` says. (The fixture's garment is
    // never worn, so no year is recapped; recap.spec.ts proves a grantee
    // with `?ownerId=` sees their own figures, never the owner's.)
    name: 'GET /wardrobe/recap',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/recap${q}` }),
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
  // Outfit selfies (#19) are the owner's like the calendar: every refusal
  // is a 404 and stores nothing (the upload is refused before its body is
  // read). A new one replaces the fixture's.
  {
    name: 'POST /calendar/:id/selfie',
    kind: 'write',
    ok: 303,
    secret: selfieName,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          photo: {
            data: f.photo,
            filename: 'selfie.jpg',
            contentType: 'image/jpeg',
          },
        },
      );
      return {
        method: 'POST',
        url: `/calendar/${f.entryId}/selfie${q}`,
        ...body,
      };
    },
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /selfies/:id/delete',
    kind: 'write',
    ok: 303,
    secret: selfieName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/selfies/${f.selfieId}/delete${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  // The images: the owner's session only, never by name alone.
  ...(['', 'thumb/'] as const).map(
    (variant): Route => ({
      name: `GET /selfies/${variant}:fileName`,
      kind: 'read',
      ok: 200,
      secret: selfieName,
      vias: ['own'],
      request: (f) => ({
        method: 'GET',
        url: `/selfies/${variant}${f.selfieFileName}?v=1`,
      }),
      expect: {
        owner: 'ok',
        manager: 'notFound',
        viewer: 'notFound',
        stranger: 'notFound',
      },
    }),
  ),
  // The public image routes serve garment photos by unguessable name to
  // anyone; a selfie's name or share id is a 404 to everyone, its owner
  // included (their pages use /selfies/).
  ...(['', 'thumb/', 'nobg/'] as const).map(
    (variant): Route => ({
      name: `GET /file/${variant}:fileName of a selfie`,
      kind: 'read',
      ok: 200,
      secret: selfieName,
      vias: ['own'],
      request: (f) => ({
        method: 'GET',
        url: `/file/${variant}${f.selfieFileName}?v=1`,
      }),
      expect: {
        owner: 'notFound',
        manager: 'notFound',
        viewer: 'notFound',
        stranger: 'notFound',
      },
      anonymous: 'notFound',
    }),
  ),
  {
    name: 'GET /file/watermark/:shareableId of a selfie',
    kind: 'read',
    ok: 200,
    secret: selfieName,
    vias: ['own'],
    request: (f) => ({
      method: 'GET',
      url: `/file/watermark/${f.selfieShareableId}`,
    }),
    expect: {
      owner: 'notFound',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
    anonymous: 'notFound',
  },
];

describeMatrix('outfits', ROUTES, (m) => {
  // The outfit form posts garment ids; an id outside the requester's own
  // wardrobe refuses the save whole (#219): a 404 like an unknown id, the
  // garment never named, nothing written. So no outfit can reference a
  // shared garment.
  const outfitsOf = (ownerId: number) =>
    m.t.db.$count(outfit, eq(outfit.ownerId, ownerId));

  it.each(['manager', 'viewer', 'stranger'] as const)(
    "POST /outfits as %s refuses the owner's garment ids",
    async (actor) => {
      const { id, cookie } = m.actors[actor];
      if (id === undefined) throw new Error(`${actor} has no account`);
      const before = await outfitsOf(id);
      const res = await m.t.inject({
        method: 'POST',
        url: `/outfits?ownerId=${m.actors.owner.id}`,
        payload: {
          name: `Borrowed ${actor}`,
          category: 'shirt',
          garmentId: String(m.shared.garmentId),
        },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(m.shared.garmentName);
      expect(await outfitsOf(id)).toBe(before);

      // Their own empty outfit, then an edit naming the owner's garment.
      const own = await m.t.inject({
        method: 'POST',
        url: '/outfits',
        payload: { name: `Own ${actor}` },
        headers: { cookie },
      });
      expect(own.statusCode).toBe(302);
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(own.headers.location as string)?.[1],
      );
      const edit = await m.t.inject({
        method: 'POST',
        url: `/outfits/${outfitId}`,
        payload: { category: 'shirt', garmentId: String(m.shared.garmentId) },
        headers: { cookie },
      });
      expect(edit.statusCode).toBe(404);
      expect(edit.body).not.toContain(m.shared.garmentName);
      expect(
        await m.t.db.$count(outfitSlot, eq(outfitSlot.outfitId, outfitId)),
      ).toBe(0);
    },
  );
});
