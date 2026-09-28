import { expect, it } from 'vitest';
import { multipart, unescapeHtml } from './harness';
import {
  describeMatrix,
  type Route,
  BOTH,
  garmentName,
  wishlistName,
  archivedName,
} from './authorization-matrix';

// The authorization matrix (authorization-matrix.ts): the wardrobe, garments, link import, the wishlist, wears.
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
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/new/from-link${q}`,
      payload: { url: f.shopPhotoUrl },
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
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/new/from-link/photo${q}`,
      payload: { url: f.shopPhotoUrl },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    // The add sheet's camera and library (#97): the wardrobe is checked
    // before the body is read, so a refusal stores nothing (the snapshot
    // includes DATA_PATH); a success stores the pending photo.
    name: 'POST /wardrobe/new/photo',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: ['ownerId'],
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          photo: {
            data: f.photo,
            filename: 'photo.jpg',
            contentType: 'image/jpeg',
          },
        },
      );
      return { method: 'POST', url: `/wardrobe/new/photo${q}`, ...body };
    },
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
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          photo: {
            data: f.photo,
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
            data: f.cutout,
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
  // The repair log (#23) is the owner's own record, like wears: a grantee
  // who sees the garment gets a 403 with ?ownerId=, a 404 without it.
  {
    name: 'POST /wardrobe/:id/repairs',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/repairs${q}`,
      payload: { day: f.today, kind: 'alteration', note: 'Planted hem' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/repairs/:repairId/delete',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/repairs/${f.repairId}/delete${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
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
  // The duplicate check (#20) is part of adding to the wardrobe, like
  // GET /wardrobe/new; "Add a copy" changes the quantity, a garment
  // property, like condition.
  {
    name: 'GET /wardrobe/lookalikes',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({
      method: 'GET',
      url: `/wardrobe/lookalikes${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/copies',
    kind: 'write',
    ok: 303,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/copies${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
];

describeMatrix('wardrobe', ROUTES, (m) => {
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
      const q = `?ownerId=${m.actors.owner.id}`;
      const res = await m.t.inject({
        method: 'GET',
        url: `/wardrobe/${m.shared.garmentId}${q}`,
        headers: { cookie: m.actors[actor].cookie },
      });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      const id = m.shared.garmentId;
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

  // "Goes with my closet" (#18b) judges a wishlist item against the owner's
  // closet and clashes: the owner's alone, like ideas, though every grantee
  // reads the item itself (mcp-seed.spec.ts refuses goes_with_closet to a
  // grantee's token).
  it.each([
    ['owner', true],
    ['manager', false],
    ['viewer', false],
  ] as const)(
    'a wishlist item’s page shows %s "Goes with my closet": %s',
    async (actor, shown) => {
      const res = await m.t.inject({
        method: 'GET',
        url: `/wardrobe/${m.shared.wishlistId}?ownerId=${m.actors.owner.id}`,
        headers: { cookie: m.actors[actor].cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(m.shared.wishlistName);
      expect(res.body.includes('id="goes-with"')).toBe(shown);
    },
  );
});
