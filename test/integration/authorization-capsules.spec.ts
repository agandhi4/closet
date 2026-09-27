import {
  describeMatrix,
  type Route,
  BOTH,
  garmentName,
  capsuleName,
} from './authorization-matrix';

// The authorization matrix (authorization-matrix.ts): capsules.
const ROUTES: Route[] = [
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
];

describeMatrix('capsules', ROUTES);
