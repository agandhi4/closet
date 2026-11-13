import {
  type Route,
  BOTH,
  garmentName,
  capsuleName,
} from './authorization-matrix';

// The authorization matrix (authorization-matrix.ts): capsules.
export const ROUTES: Route[] = [
  // Capsules are part of the wardrobe (owner decision on #8): the same
  // ?ownerId= resolution as the garment routes. Without ?ownerId a grantee
  // addresses their own wardrobe, which holds no such capsule. Every write,
  // the list and a capsule's read replay on their /api/v1 twin (#194b, `api`).
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
    api: {
      ok: 200,
      request: (_, q) => ({ method: 'GET', url: `/api/v1/capsules${q}` }),
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
    api: {
      ok: 201,
      // A name of its own: the page's case planted the other.
      request: (f, q) => ({
        method: 'POST',
        url: `/api/v1/capsules${q}`,
        payload: { name: `Planted ${f.capsuleName}` },
      }),
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
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'GET',
        url: `/api/v1/capsules/${f.capsuleId}${q}`,
      }),
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
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PUT',
        url: `/api/v1/capsules/${f.capsuleId}${q}`,
        payload: { name: `Renamed ${f.capsuleName}` },
      }),
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
    api: {
      ok: 204,
      request: (f, q) => ({
        method: 'DELETE',
        url: `/api/v1/capsules/${f.capsuleId}${q}`,
      }),
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
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PATCH',
        url: `/api/v1/capsules/${f.capsuleId}/members${q}`,
        payload: { remove: [f.garmentId] },
      }),
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
    api: {
      ok: 200,
      request: (f, q) => ({
        method: 'PATCH',
        url: `/api/v1/garments/${f.garmentId}/capsules${q}`,
        payload: { remove: [f.capsuleId] },
      }),
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
];
