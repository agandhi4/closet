import {
  describeMatrix,
  type Route,
  BOTH,
  wishlistName,
  planName,
  styleNote,
} from './authorization-matrix';

// The authorization matrix (authorization-matrix.ts): wardrobe plans, the style profile and the shopping loop.
const ROUTES: Route[] = [
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
    // The item forms show the plan they belong to.
    name: 'GET /wardrobe/plans/:id/items/new',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/plans/${f.planId}/items/new${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/plans/:id/items/:itemId/edit',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/plans/${f.planId}/items/${f.planItemId}/edit${q}`,
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
    name: 'GET /wardrobe/plans/:id/items/:itemId/change',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/plans/${f.planId}/items/${f.planItemId}/change${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // #278: the fixture's proposal goes back to the agent with a note.
    name: 'POST /wardrobe/plans/:id/items/:itemId/change',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/items/${f.planItemId}/change${q}`,
      payload: { note: 'Darker, please' },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/plans/:id/items/:itemId/decline',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/items/${f.planItemId}/decline${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // The fixture's declined item comes back as a proposal.
    name: 'POST /wardrobe/plans/:id/items/:itemId/reconsider',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/items/${f.planDeclinedItemId}/reconsider${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // #291: the fixture's proposed look is loved.
    name: 'POST /wardrobe/plans/:id/looks/:lookId/love',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/looks/${f.planLookId}/love${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/plans/:id/looks/:lookId/change',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/plans/${f.planId}/looks/${f.planLookId}/change${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/plans/:id/looks/:lookId/change',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/looks/${f.planLookId}/change${q}`,
      payload: { note: 'Warmer, please' },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/plans/:id/looks/:lookId/decline',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/looks/${f.planLookId}/decline${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // The fixture's turned-down look comes back to review.
    name: 'POST /wardrobe/plans/:id/looks/:lookId/reconsider',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/looks/${f.planDeclinedLookId}/reconsider${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // #292: the fixture's look of closet garments becomes an outfit.
    name: 'POST /wardrobe/plans/:id/looks/:lookId/save',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/looks/${f.planCompleteLookId}/save${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/plans/:id/review',
    kind: 'read',
    ok: 200,
    secret: planName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/plans/${f.planId}/review${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    // Picks the fixture's candidate for its proposed item (#271), so it
    // writes; no removal box, so the wishlist item stays for the rows after.
    name: 'POST /wardrobe/plans/:id/review',
    kind: 'write',
    ok: 303,
    secret: planName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/review${q}`,
      payload: {
        shown: [String(f.planItemId)],
        pick: [`${f.planItemId}:${f.wishlistId}`],
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
];

describeMatrix('plans', ROUTES);
