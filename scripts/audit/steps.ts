import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { multipart } from '../../test/support/multipart';
import {
  ACCOUNT_PASSWORD,
  type Actor,
  type AuditRequest,
  type Fixture,
  PERSONA_PASSWORD,
} from './fixture';
import { http, job, type Phase, type Step } from './walk';

/**
 * Every page, fragment, action, file, MCP tool and job the page audits
 * name (#158-#174, the Scope line of each), as the demo persona. Pages first
 * over the seed as it is, then the writes (a write that needs something to
 * act on makes it in `prepare`, unmeasured), then the jobs. A new route
 * joins its audit issue's group here; the report lists every route template
 * or MCP tool no step reaches (`Not walked`).
 */

const TODAY = { issue: 158, area: 'Today' } as const;
const GRID = { issue: 159, area: 'Wardrobe grid' } as const;
const GARMENT = { issue: 160, area: 'Garment page' } as const;
const FORM = { issue: 161, area: 'Add and edit a garment' } as const;
const PHOTOS = { issue: 162, area: 'Photos and cutouts' } as const;
const STYLING = { issue: 163, area: 'Styling' } as const;
const OUTFITS = { issue: 164, area: 'Outfits and saved outfits' } as const;
const CALENDAR = { issue: 165, area: 'Calendar and week plan' } as const;
const TRIPS = { issue: 166, area: 'Trips and packing' } as const;
const PLANS = {
  issue: 167,
  area: 'Plans, shopping list, wishlist and Bought it',
} as const;
const IDEAS = { issue: 168, area: 'Ideas gallery' } as const;
const INSIGHTS = { issue: 169, area: 'Insights and yearly recap' } as const;
const SHARING = { issue: 170, area: 'Sharing and shared views' } as const;
const ACCOUNT = { issue: 171, area: 'Auth, account and push' } as const;
const MCP = { issue: 172, area: 'MCP tools' } as const;
const JOBS = { issue: 173, area: 'Background jobs' } as const;
const PLATFORM = { issue: 174, area: 'Per-request platform overhead' } as const;

// --- helpers --------------------------------------------------------------

const day = (f: Fixture, offset: number) =>
  f.build.calendar.addDays(f.today(), offset);

const get = (url: string, extra: Partial<AuditRequest> = {}): AuditRequest => ({
  method: 'GET',
  url,
  ...extra,
});

/** The seed photo's URL as a page renders it: signed by the build's imageUrl. */
const photoUrl = (f: Fixture, variant: 'original' | 'nobg' | 'thumb') =>
  f.build.imageUrl.imageUrl(
    f.build.fileQueries.readPhotoRef(f.ids.photo),
    variant,
  );

const post = (
  url: string,
  form: AuditRequest['form'] = {},
  extra: Partial<AuditRequest> = {},
): AuditRequest => ({ method: 'POST', url, form, ...extra });

/** The id a create's redirect names: `/wardrobe/12?...` with `/wardrobe/(\d+)`. */
function idFrom(res: LightMyRequestResponse, pattern: RegExp): number {
  const location = String(res.headers.location ?? '');
  const match = pattern.exec(location);
  if (!match) {
    throw new Error(`No id in the redirect "${location}" (${res.statusCode})`);
  }
  return Number(match[1]);
}

function photoUpload(f: Fixture, field = 'photo', count = 1) {
  const photo = {
    data: f.photo,
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
  };
  return multipart(
    {},
    {
      [field]: count === 1 ? photo : Array.from({ length: count }, () => photo),
    },
  );
}

/**
 * The add sheet's upload of `count` photos (#97, #200): the pending photo,
 * or a batch's first draft, that its redirect opens.
 */
async function uploadedPhoto(f: Fixture, count = 1): Promise<string> {
  const res = await f.send(
    {
      method: 'POST',
      url: '/wardrobe/new/photo',
      raw: await photoUpload(f, 'photo', count),
    },
    303,
  );
  const photo = new URL(
    String(res.headers.location),
    'http://audit',
  ).searchParams.get('photo');
  if (!photo) throw new Error(`No photo in "${res.headers.location}"`);
  return photo;
}

/**
 * Theo's drafts gone (their bytes left to reconciliation), so a step's runs
 * never reach MAX_DRAFTS_PER_USER: each run uploads a batch.
 */
async function clearDrafts(f: Fixture): Promise<void> {
  const s = f.build.schema;
  await f.closet.db
    .delete(s.pendingPhoto)
    .where(
      and(
        eq(s.pendingPhoto.userId, f.theo.id),
        isNotNull(s.pendingPhoto.batchId),
      ),
    );
}

async function newGarment(f: Fixture, name = 'Audit tee'): Promise<number> {
  const res = await f.send(post('/wardrobe', { name, category: 'tops' }), 302);
  return idFrom(res, /^\/wardrobe\/(\d+)/);
}

async function newOutfit(f: Fixture): Promise<number> {
  const res = await f.send(
    post('/outfits', {
      name: 'Audit outfit',
      category: ['top', 'bottom'],
      garmentId: f.ids.outfitGarmentIds.slice(0, 2).map(String),
    }),
    302,
  );
  return idFrom(res, /^\/outfits\/(\d+)/);
}

async function newestId<T extends { id: number }>(
  rows: Promise<T[]>,
  what: string,
): Promise<number> {
  const [row] = await rows;
  if (!row) throw new Error(`No ${what} was made`);
  return row.id;
}

/** An invite link of Theo's; its token. */
async function newInvite(f: Fixture): Promise<string> {
  const res = await f.send(
    post(
      '/wardrobe-share/create-invite-link',
      { permission: 'VIEW' },
      { htmx: true },
    ),
    200,
  );
  const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(res.body)?.[1];
  if (!token) throw new Error('The invite link is not on the answer');
  return token;
}

/** The body of an MCP tools/call answer, refused when the tool said so. */
function mcpRefusal(body: string): string | undefined {
  const answer = JSON.parse(body) as {
    result?: { isError?: boolean; content: { text?: string }[] };
    error?: { message: string };
  };
  if (answer.error) return `JSON-RPC error: ${answer.error.message}`;
  if (answer.result?.isError) {
    return `tool error: ${answer.result.content[0]?.text ?? ''}`;
  }
  return undefined;
}

let mcpCall = 0;
let mcpTool = 0;
let auditDrafts = 0;

/** One tool, called as Claude Code calls it: a token, JSON-RPC, no cookie or Origin. */
function mcp<P = undefined>(
  name: string,
  args: (f: Fixture, prepared: P) => Record<string, unknown>,
  options: {
    runs?: number;
    warmup?: number;
    label?: string;
    prepare?: (f: Fixture) => Promise<P>;
  } = {},
): Step {
  const token = mcpTool++;
  const { label, ...rest } = options;
  return http<P>({
    ...MCP,
    ...rest,
    name: label ?? name,
    kind: 'mcp',
    route: 'POST /mcp',
    target: `mcp ${name}`,
    request: (f, prepared) => ({
      method: 'POST',
      url: '/mcp',
      as: null,
      sameOrigin: false,
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${f.mcpTokens[token % f.mcpTokens.length]}`,
      },
      json: {
        jsonrpc: '2.0',
        id: ++mcpCall,
        method: 'tools/call',
        params: { name, arguments: args(f, prepared) },
      },
    }),
    expect: 200,
    check: mcpRefusal,
  });
}

// --- pages (reads) --------------------------------------------------------

const pages: Step[] = [
  // #158 Today
  http({
    ...TODAY,
    name: 'Today',
    kind: 'page',
    route: 'GET /',
    request: () => get('/'),
    expect: 200,
  }),
  http({
    ...TODAY,
    name: 'Refresh an ideas row',
    kind: 'fragment',
    route: 'GET /today/ideas',
    request: () => get('/today/ideas?occasion=all-day&page=2', { htmx: true }),
    expect: 200,
  }),
  http({
    ...TODAY,
    name: 'Weather summary',
    kind: 'fragment',
    route: 'GET /weather/summary',
    request: (f) =>
      get(`/weather/summary?from=${f.today()}&to=${day(f, 6)}`, { htmx: true }),
    expect: 200,
  }),

  // #159 Wardrobe grid
  http({
    ...GRID,
    name: 'Grid',
    kind: 'page',
    route: 'GET /wardrobe',
    request: () => get('/wardrobe'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Grid fragment (scope row, filters)',
    kind: 'fragment',
    route: 'GET /wardrobe',
    request: () => get('/wardrobe?category=tops', { htmx: true }),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Search',
    kind: 'page',
    route: 'GET /wardrobe',
    request: () => get('/wardrobe?keyword=shirt'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Filters: category, colour, warmth',
    kind: 'page',
    route: 'GET /wardrobe',
    request: () => get('/wardrobe?category=tops&color=blue&warmth=2'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Care filters: needs a wash, attention',
    kind: 'page',
    route: 'GET /wardrobe',
    request: () => get('/wardrobe?needsWash=true&attention=true'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Show archived',
    kind: 'page',
    route: 'GET /wardrobe',
    request: () => get('/wardrobe?archived=true'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Capsule filter',
    kind: 'page',
    route: 'GET /wardrobe',
    request: (f) => get(`/wardrobe?capsule=${f.ids.capsuleId}`),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Next page (tiles)',
    kind: 'fragment',
    route: 'GET /wardrobe/tiles',
    request: (f) =>
      get(`/wardrobe/tiles?before=${f.ids.secondPageBefore}`, { htmx: true }),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Select mode',
    kind: 'page',
    route: 'GET /wardrobe',
    request: () => get('/wardrobe?select=1'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Capsule picker',
    kind: 'page',
    route: 'GET /wardrobe',
    request: (f) => get(`/wardrobe?pick=${f.ids.capsuleId}`),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Tagging mode',
    kind: 'page',
    route: 'GET /wardrobe/tag',
    request: () => get('/wardrobe/tag'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Laundry tab',
    kind: 'page',
    route: 'GET /laundry',
    request: () => get('/laundry'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Capsules tab',
    kind: 'page',
    route: 'GET /capsules',
    request: () => get('/capsules'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'A capsule',
    kind: 'page',
    route: 'GET /capsules/:id',
    request: (f) => get(`/capsules/${f.ids.capsuleId}`),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'New capsule form',
    kind: 'page',
    route: 'GET /capsules/new',
    request: () => get('/capsules/new'),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Edit capsule form',
    kind: 'page',
    route: 'GET /capsules/:id/edit',
    request: (f) => get(`/capsules/${f.ids.capsuleId}/edit`),
    expect: 200,
  }),

  // #160 Garment page
  http({
    ...GARMENT,
    name: 'Garment page',
    kind: 'page',
    route: 'GET /wardrobe/:id',
    request: (f) => get(`/wardrobe/${f.ids.garmentId}`),
    expect: 200,
  }),

  // #161 Add and edit
  http({
    ...FORM,
    name: 'Add form',
    kind: 'page',
    route: 'GET /wardrobe/new',
    request: () => get('/wardrobe/new'),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Edit form',
    kind: 'page',
    route: 'GET /wardrobe/:id/edit',
    request: (f) => get(`/wardrobe/${f.ids.garmentId}/edit`),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Clone form',
    kind: 'page',
    route: 'GET /wardrobe/:id/clone',
    request: (f) => get(`/wardrobe/${f.ids.garmentId}/clone`),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Properties after a category change',
    kind: 'fragment',
    route: 'POST /wardrobe/properties-fragment',
    request: () =>
      post(
        '/wardrobe/properties-fragment',
        { category: 'footwear' },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Lookalike check',
    kind: 'fragment',
    route: 'GET /wardrobe/lookalikes',
    request: () =>
      get('/wardrobe/lookalikes?category=tops&color=blue&brand=Uniqlo', {
        htmx: true,
      }),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Link page',
    kind: 'page',
    route: 'GET /wardrobe/new/from-link',
    request: () => get('/wardrobe/new/from-link'),
    expect: 200,
  }),

  // #162 Photos: served files, by the URLs a page renders (imageUrl's,
  // signed: answered from storage alone), and by an old page's unsigned
  // URL (answered through the row).
  http({
    ...PHOTOS,
    name: 'Original',
    kind: 'file',
    route: 'GET /file/:fileName',
    request: (f) => get(photoUrl(f, 'original'), { as: null }),
    expect: 200,
  }),
  http({
    ...PHOTOS,
    name: 'Cutout',
    kind: 'file',
    route: 'GET /file/nobg/:fileName',
    request: (f) => get(photoUrl(f, 'nobg'), { as: null }),
    expect: 200,
  }),
  http({
    ...PHOTOS,
    name: 'Thumb',
    kind: 'file',
    route: 'GET /file/thumb/:fileName',
    request: (f) => get(photoUrl(f, 'thumb'), { as: null }),
    expect: 200,
  }),
  http({
    ...PHOTOS,
    name: 'Thumb, unsigned (an old page)',
    kind: 'file',
    route: 'GET /file/thumb/:fileName',
    request: (f) =>
      get(`/file/thumb/${f.ids.photo.fileName}?v=${f.ids.photo.version}`, {
        as: null,
      }),
    expect: 200,
  }),
  http({
    ...PHOTOS,
    name: 'Thumb, regenerated',
    kind: 'file',
    route: 'GET /file/thumb/:fileName',
    // The stored thumb gone, as an old photo's: made on this request.
    prepare: async (f) => {
      const stem = f.ids.photo.fileName.replace(/\.webp$/, '');
      for (const name of await readdir(f.dataPath)) {
        if (name.startsWith(`${stem}-thumb`))
          await unlink(join(f.dataPath, name));
      }
    },
    // Signed, as the page renders it: the named file is missing, so the
    // row answers and the thumb is made.
    request: (f) => get(photoUrl(f, 'thumb'), { as: null }),
    expect: 200,
  }),
  http({
    ...PHOTOS,
    name: 'Cutout poll (pending page)',
    kind: 'fragment',
    route: 'GET /wardrobe/:id/cutout',
    request: (f) => get(`/wardrobe/${f.ids.garmentId}/cutout`, { htmx: true }),
    expect: 200,
  }),

  // #163 Styling
  http({
    ...STYLING,
    name: 'Styling',
    kind: 'page',
    route: 'GET /styling',
    request: () => get('/styling'),
    expect: 200,
  }),
  http({
    ...STYLING,
    name: 'Style this (?with=)',
    kind: 'page',
    route: 'GET /styling',
    request: (f) => get(`/styling?with=${f.ids.garmentId}`),
    expect: 200,
  }),
  http({
    ...STYLING,
    name: 'Edit an outfit (?outfit=)',
    kind: 'page',
    route: 'GET /styling',
    request: (f) =>
      get(`/styling?outfit=${f.ids.outfitId}&returnTo=%2Fcalendar`),
    expect: 200,
  }),
  http({
    ...STYLING,
    name: 'For a planned evening (?for=)',
    kind: 'page',
    route: 'GET /styling',
    request: (f) => get(`/styling?for=day:${day(f, 1)}&occasion=evening`),
    expect: 200,
  }),
  http({
    ...STYLING,
    name: 'Shuffle, one row locked',
    kind: 'fragment',
    route: 'GET /styling/shuffle',
    request: (f) => {
      const [top] = f.ids.outfitGarmentIds;
      const query = new URLSearchParams([
        ['role', 'top'],
        ['garmentId', String(top)],
        ['lock', '1'],
        ['role', 'bottom'],
        ['garmentId', ''],
        ['lock', ''],
        ['role', 'footwear'],
        ['garmentId', ''],
        ['lock', ''],
      ]);
      return get(`/styling/shuffle?${query}`, { htmx: true });
    },
    expect: 200,
  }),
  http({
    ...STYLING,
    name: 'Add a row',
    kind: 'fragment',
    route: 'GET /styling/row',
    request: () => {
      const query = new URLSearchParams([
        ['role', 'top'],
        ['garmentId', ''],
        ['lock', ''],
        ['role', 'bottom'],
        ['garmentId', ''],
        ['lock', ''],
        ['add', 'accessory'],
      ]);
      return get(`/styling/row?${query}`, { htmx: true });
    },
    expect: 200,
  }),
  http({
    ...STYLING,
    name: 'Strip paging',
    kind: 'fragment',
    route: 'GET /styling/garments',
    request: () =>
      get('/styling/garments?role=top&before=2147483647', { htmx: true }),
    expect: 200,
  }),
  http({
    ...STYLING,
    name: 'Old builder link (/outfits/new)',
    kind: 'page',
    route: 'GET /outfits/new',
    request: () => get('/outfits/new'),
    expect: 302,
  }),
  http({
    ...STYLING,
    name: 'Old edit link (/outfits/:id/edit)',
    kind: 'page',
    route: 'GET /outfits/:id/edit',
    request: (f) => get(`/outfits/${f.ids.outfitId}/edit`),
    expect: 302,
  }),

  // #164 Outfits
  http({
    ...OUTFITS,
    name: 'Outfits (Saved)',
    kind: 'page',
    route: 'GET /outfits',
    request: () => get('/outfits'),
    expect: 200,
  }),
  http({
    ...OUTFITS,
    name: 'Saved, picking for a day',
    kind: 'page',
    route: 'GET /outfits',
    request: (f) => get(`/outfits?for=day:${day(f, 1)}&occasion=evening`),
    expect: 200,
  }),
  http({
    ...OUTFITS,
    name: 'Outfit page (Worn strip)',
    kind: 'page',
    route: 'GET /outfits/:id',
    request: (f) => get(`/outfits/${f.ids.outfitId}`),
    expect: 200,
  }),

  // #165 Calendar
  http({
    ...CALENDAR,
    name: 'Week agenda',
    kind: 'page',
    route: 'GET /calendar',
    request: () => get('/calendar'),
    expect: 200,
  }),
  http({
    ...CALENDAR,
    name: 'Next week',
    kind: 'page',
    route: 'GET /calendar',
    request: (f) => get(`/calendar?week=${day(f, 7)}`),
    expect: 200,
  }),
  http({
    ...CALENDAR,
    name: 'Month collages',
    kind: 'page',
    route: 'GET /calendar/month',
    request: () => get('/calendar/month'),
    expect: 200,
  }),
  http({
    ...CALENDAR,
    name: 'Last month',
    kind: 'page',
    route: 'GET /calendar/month',
    request: (f) => get(`/calendar/month?month=${day(f, -31).slice(0, 7)}`),
    expect: 200,
  }),
  http({
    ...CALENDAR,
    name: 'Month weather chips',
    kind: 'fragment',
    route: 'GET /weather/summary',
    // WeatherMonthLoader's ask (#201), as this month's page makes it.
    prepare: async (f) => {
      const month = await f.send(get('/calendar/month'), 200);
      const url = /hx-get="(\/weather\/summary[^"]*)"/.exec(month.body)?.[1];
      if (!url) throw new Error('No month weather loader on /calendar/month');
      return url.replaceAll('&amp;', '&');
    },
    request: (_f, url: string) => get(url, { htmx: true }),
    expect: 200,
  }),
  http({
    ...CALENDAR,
    name: '+ Plan sheet',
    kind: 'page',
    route: 'GET /calendar/plan',
    request: (f) => get(`/calendar/plan?for=day:${day(f, 1)}&occasion=evening`),
    expect: 200,
  }),
  http({
    ...CALENDAR,
    name: 'Selfie',
    kind: 'file',
    route: 'GET /selfies/:fileName',
    request: (f) =>
      get(`/selfies/${f.ids.selfie.fileName}?v=${f.ids.selfie.version}`),
    expect: 200,
  }),
  http({
    ...CALENDAR,
    name: 'Selfie thumb',
    kind: 'file',
    route: 'GET /selfies/thumb/:fileName',
    request: (f) =>
      get(`/selfies/thumb/${f.ids.selfie.fileName}?v=${f.ids.selfie.version}`),
    expect: 200,
  }),

  // #166 Trips
  http({
    ...TRIPS,
    name: 'Trips',
    kind: 'page',
    route: 'GET /trips',
    request: () => get('/trips'),
    expect: 200,
  }),
  http({
    ...TRIPS,
    name: 'Trip page and packing list',
    kind: 'page',
    route: 'GET /trips/:id',
    request: (f) => get(`/trips/${f.ids.tripId}`),
    expect: 200,
  }),
  http({
    ...TRIPS,
    name: 'New trip form',
    kind: 'page',
    route: 'GET /trips/new',
    request: () => get('/trips/new'),
    expect: 200,
  }),
  http({
    ...TRIPS,
    name: 'Edit trip form',
    kind: 'page',
    route: 'GET /trips/:id/edit',
    request: (f) => get(`/trips/${f.ids.tripId}/edit`),
    expect: 200,
  }),
  http({
    ...TRIPS,
    name: 'Add-an-outfit page',
    kind: 'page',
    route: 'GET /trips/:id/outfits/new',
    request: (f) => get(`/trips/${f.ids.tripId}/outfits/new`),
    expect: 200,
  }),
  http({
    ...TRIPS,
    name: 'Trip weather',
    kind: 'fragment',
    route: 'GET /trips/:id/weather',
    request: (f) => get(`/trips/${f.ids.tripId}/weather`, { htmx: true }),
    expect: 200,
  }),
  http({
    ...TRIPS,
    name: 'Ideas for the trip',
    kind: 'page',
    route: 'GET /outfits/ideas',
    request: (f) => get(`/outfits/ideas?for=trip:${f.ids.tripId}`),
    expect: 200,
  }),

  // #167 Plans, shopping list, wishlist
  http({
    ...PLANS,
    name: 'Plans',
    kind: 'page',
    route: 'GET /wardrobe/plans',
    request: () => get('/wardrobe/plans'),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Plan page (gaps)',
    kind: 'page',
    route: 'GET /wardrobe/plans/:id',
    request: (f) => get(`/wardrobe/plans/${f.ids.planId}`),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'New plan form',
    kind: 'page',
    route: 'GET /wardrobe/plans/new',
    request: () => get('/wardrobe/plans/new'),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Edit plan form',
    kind: 'page',
    route: 'GET /wardrobe/plans/:id/edit',
    request: (f) => get(`/wardrobe/plans/${f.ids.planId}/edit`),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'New item form',
    kind: 'page',
    route: 'GET /wardrobe/plans/:id/items/new',
    request: (f) => get(`/wardrobe/plans/${f.ids.planId}/items/new`),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Edit item form',
    kind: 'page',
    route: 'GET /wardrobe/plans/:id/items/:itemId/edit',
    request: (f) =>
      get(`/wardrobe/plans/${f.ids.planId}/items/${f.ids.planItemId}/edit`),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Candidates picker',
    kind: 'page',
    route: 'GET /wardrobe/plans/:id/items/:itemId/candidates',
    request: (f) =>
      get(
        `/wardrobe/plans/${f.ids.planId}/items/${f.ids.planItemId}/candidates`,
      ),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Shopping list',
    kind: 'page',
    route: 'GET /wardrobe/shopping',
    request: () => get('/wardrobe/shopping'),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Compare plans',
    kind: 'page',
    route: 'GET /wardrobe/plans/compare',
    request: () => get('/wardrobe/plans/compare'),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Wishlist',
    kind: 'page',
    route: 'GET /wardrobe/wishlist',
    request: () => get('/wardrobe/wishlist'),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Wishlist item',
    kind: 'page',
    route: 'GET /wardrobe/:id',
    request: (f) => get(`/wardrobe/${f.ids.wishlistId}`),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Wishlist form',
    kind: 'page',
    route: 'GET /wardrobe/new',
    request: (f) =>
      get(`/wardrobe/new?to=wishlist&replaces=${f.ids.garmentId}`),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Goes with my closet',
    kind: 'fragment',
    route: 'GET /wardrobe/:id/outfit-count',
    request: (f) =>
      get(`/wardrobe/${f.ids.wishlistId}/outfit-count`, { htmx: true }),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Plan items of a wishlist item',
    kind: 'page',
    route: 'GET /wardrobe/:id/plan-items',
    request: (f) => get(`/wardrobe/${f.ids.wishlistId}/plan-items`),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Bought it form',
    kind: 'page',
    route: 'GET /wardrobe/:id/bought',
    request: (f) => get(`/wardrobe/${f.ids.wishlistId}/bought`),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Style profile',
    kind: 'page',
    route: 'GET /auth/profile/style',
    request: () => get('/auth/profile/style'),
    expect: 200,
  }),
  // The order mail's review list (#25), with the fixture's seeded order.
  http({
    ...PLANS,
    name: 'From your orders',
    kind: 'page',
    route: 'GET /wardrobe/orders',
    request: () => get('/wardrobe/orders'),
    expect: 200,
  }),

  // #168 Ideas
  http({
    ...IDEAS,
    name: 'Ideas',
    kind: 'page',
    route: 'GET /outfits/ideas',
    request: () => get('/outfits/ideas'),
    expect: 200,
  }),
  http({
    ...IDEAS,
    name: 'Ideas for a planned evening',
    kind: 'page',
    route: 'GET /outfits/ideas',
    request: (f) => get(`/outfits/ideas?for=day:${day(f, 1)}&occasion=evening`),
    expect: 200,
  }),
  http({
    ...IDEAS,
    name: 'Ideas with a garment',
    kind: 'page',
    route: 'GET /outfits/ideas',
    request: (f) => get(`/outfits/ideas?with=${f.ids.garmentId}`),
    expect: 200,
  }),
  http({
    ...IDEAS,
    name: 'More ideas (page 2)',
    kind: 'fragment',
    route: 'GET /outfits/ideas/more',
    request: () => get('/outfits/ideas/more?seed=7&page=2', { htmx: true }),
    expect: 200,
  }),
  http({
    ...IDEAS,
    name: 'More ideas (page 50, the cap)',
    kind: 'fragment',
    route: 'GET /outfits/ideas/more',
    request: () => get('/outfits/ideas/more?seed=7&page=50', { htmx: true }),
    expect: 200,
  }),

  // #169 Insights
  http({
    ...INSIGHTS,
    name: 'Insights',
    kind: 'page',
    route: 'GET /wardrobe/insights',
    request: () => get('/wardrobe/insights'),
    expect: 200,
  }),
  http({
    ...INSIGHTS,
    name: 'Insights, unworn 30 days',
    kind: 'page',
    route: 'GET /wardrobe/insights',
    request: () => get('/wardrobe/insights?unworn=30'),
    expect: 200,
  }),
  http({
    ...INSIGHTS,
    name: 'Year in review',
    kind: 'page',
    route: 'GET /wardrobe/recap',
    request: () => get('/wardrobe/recap'),
    expect: 200,
  }),
  http({
    ...INSIGHTS,
    name: 'Year in review, last year',
    kind: 'page',
    route: 'GET /wardrobe/recap',
    request: (f) =>
      get(`/wardrobe/recap?year=${Number(f.today().slice(0, 4)) - 1}`),
    expect: 200,
  }),

  // #170 Sharing: Theo as Dana's grantee, public share pages
  http({
    ...SHARING,
    name: 'Shared wardrobe',
    kind: 'page',
    route: 'GET /wardrobe',
    request: (f) => get(`/wardrobe?ownerId=${f.ids.dana.id}`),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Shared garment',
    kind: 'page',
    route: 'GET /wardrobe/:id',
    request: (f) =>
      get(`/wardrobe/${f.ids.dana.garmentId}?ownerId=${f.ids.dana.id}`),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Shared capsules',
    kind: 'page',
    route: 'GET /capsules',
    request: (f) => get(`/capsules?ownerId=${f.ids.dana.id}`),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Shared wishlist',
    kind: 'page',
    route: 'GET /wardrobe/wishlist',
    request: (f) => get(`/wardrobe/wishlist?ownerId=${f.ids.dana.id}`),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Styling a shared wardrobe',
    kind: 'page',
    route: 'GET /styling',
    request: (f) => get(`/styling?ownerId=${f.ids.dana.id}`),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Share page, garment (signed out)',
    kind: 'page',
    route: 'GET /share',
    request: (f) =>
      get(`/share?shareableId=${f.ids.garmentShareableId}&type=garment`, {
        as: null,
      }),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Share page, outfit (signed out)',
    kind: 'page',
    route: 'GET /share',
    request: (f) =>
      get(`/share?shareableId=${f.ids.outfitShareableId}&type=outfit`, {
        as: null,
      }),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Share preview image',
    kind: 'file',
    route: 'GET /file/watermark/:shareableId',
    request: (f) =>
      get(`/file/watermark/${f.ids.photo.shareableId}`, { as: null }),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Old manage page',
    kind: 'page',
    route: 'GET /wardrobe-share/manage',
    request: () => get('/wardrobe-share/manage'),
    expect: 301,
  }),

  // #171 Auth and account
  http({
    ...ACCOUNT,
    name: 'Profile',
    kind: 'page',
    route: 'GET /auth/profile',
    request: () => get('/auth/profile'),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Sign-in page',
    kind: 'page',
    route: 'GET /auth/login',
    request: () => get('/auth/login', { as: null }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Registration page',
    kind: 'page',
    route: 'GET /auth/register',
    request: () => get('/auth/register', { as: null }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Change email page',
    kind: 'page',
    route: 'GET /auth/update-email',
    request: () => get('/auth/update-email'),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Change password page',
    kind: 'page',
    route: 'GET /auth/change-password',
    request: () => get('/auth/change-password'),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Delete account page',
    kind: 'page',
    route: 'GET /auth/delete-account',
    request: () => get('/auth/delete-account'),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Agent access (tokens)',
    kind: 'page',
    route: 'GET /auth/tokens',
    request: () => get('/auth/tokens'),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Sign-out page',
    kind: 'page',
    route: 'GET /auth/logout',
    request: () => get('/auth/logout'),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Sizes',
    kind: 'page',
    route: 'GET /auth/profile/sizes',
    request: () => get('/auth/profile/sizes'),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Brand size hint',
    kind: 'fragment',
    route: 'GET /auth/profile/sizes/hint',
    request: () => get('/auth/profile/sizes/hint?brand=Uniqlo', { htmx: true }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'VAPID public key',
    kind: 'fragment',
    route: 'GET /push/vapid-public-key',
    request: () => get('/push/vapid-public-key'),
    expect: 200,
  }),

  // #174 Platform
  http({
    ...PLATFORM,
    name: 'Health check',
    kind: 'platform',
    route: 'GET /healthz',
    request: () => get('/healthz', { as: null }),
    expect: 204,
  }),
  http({
    ...PLATFORM,
    name: 'About, signed in',
    kind: 'platform',
    route: 'GET /about',
    request: () => get('/about'),
    expect: 200,
  }),
  http({
    ...PLATFORM,
    name: 'About, signed out',
    kind: 'platform',
    route: 'GET /about',
    request: () => get('/about', { as: null }),
    expect: 200,
  }),
  http({
    ...PLATFORM,
    name: 'Offline page',
    kind: 'platform',
    route: 'GET /offline.html',
    request: () => get('/offline.html'),
    expect: 200,
  }),
  http({
    ...PLATFORM,
    name: 'Manifest',
    kind: 'platform',
    route: 'GET /manifest.json',
    request: () => get('/manifest.json', { as: null }),
    expect: 200,
  }),
  http({
    ...PLATFORM,
    name: 'Asset links',
    kind: 'platform',
    route: 'GET /.well-known/*',
    request: () => get('/.well-known/assetlinks.json', { as: null }),
    expect: 200,
  }),
  http({
    ...PLATFORM,
    name: 'Stylesheet',
    kind: 'platform',
    route: 'GET /*',
    request: () => get('/bundle.css', { as: null }),
    expect: 200,
  }),
  http({
    ...PLATFORM,
    name: 'Service worker',
    kind: 'platform',
    route: 'GET /*',
    request: () => get('/sw.js', { as: null }),
    expect: 200,
  }),
  http({
    ...PLATFORM,
    name: 'A page script',
    kind: 'platform',
    route: 'GET /*',
    request: () => get('/js/vitals.js', { as: null }),
    expect: 200,
  }),
  http({
    ...PLATFORM,
    name: 'Not found page',
    kind: 'platform',
    route: 'GET (unmatched)',
    request: () => get('/no-such-page'),
    expect: 404,
  }),
  http({
    ...PLATFORM,
    name: 'Metrics scrape',
    kind: 'platform',
    route: 'GET /metrics',
    request: () => get('/metrics', { as: null }),
    expect: 200,
  }),
];

// --- writes ---------------------------------------------------------------

const writes: Step[] = [
  // #158 Today
  http({
    ...TODAY,
    name: 'Wear this',
    kind: 'action',
    route: 'POST /today/wear',
    request: (f) =>
      post('/today/wear', {
        garmentId: f.ids.outfitGarmentIds.map(String),
        occasion: 'evening',
      }),
    expect: 303,
  }),
  http({
    ...TODAY,
    name: 'Wore it (from Today)',
    kind: 'action',
    route: 'POST /calendar/:id/worn',
    prepare: (f) =>
      f.send(post(`/calendar/${f.ids.wornEntryId}/worn`, { worn: '0' }), 303),
    request: (f) =>
      post(`/calendar/${f.ids.wornEntryId}/worn`, { worn: '1', returnTo: '/' }),
    expect: 303,
  }),
  http({
    ...TODAY,
    name: 'Reminders form (this device)',
    kind: 'fragment',
    route: 'POST /push/reminders/form',
    request: (f) =>
      post(
        '/push/reminders/form',
        { endpoint: f.pushEndpoint },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...TODAY,
    name: 'Save reminders',
    kind: 'action',
    route: 'POST /push/reminders',
    request: (f) =>
      post(
        '/push/reminders',
        {
          endpoint: f.pushEndpoint,
          morningOn: '1',
          morning: '450',
          eveningOn: '1',
          evening: '1260',
        },
        { htmx: true },
      ),
    expect: 200,
  }),

  // #159 Wardrobe grid: bulk edit, tagging, laundry, capsules
  http({
    ...GRID,
    name: 'Bulk edit (select mode’s Set…)',
    kind: 'action',
    route: 'POST /wardrobe/bulk',
    request: (f) =>
      post('/wardrobe/bulk', {
        ids: [String(f.ids.garmentId), String(f.ids.otherGarmentId)],
        property: 'warmth',
        warmth: '3',
      }),
    expect: 303,
  }),
  http({
    ...GRID,
    name: 'Tag a garment',
    kind: 'action',
    route: 'POST /wardrobe/:id/tag',
    request: (f) =>
      post(
        `/wardrobe/${f.ids.otherGarmentId}/tag`,
        { warmth: '3' },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...GRID,
    name: 'Laundry: washed',
    kind: 'action',
    route: 'POST /laundry',
    request: (f) => post('/laundry', { ids: [String(f.ids.otherGarmentId)] }),
    expect: 303,
  }),
  http({
    ...GRID,
    name: 'New capsule',
    kind: 'action',
    route: 'POST /capsules',
    request: () => post('/capsules', { name: `Audit capsule ${unique()}` }),
    expect: 303,
  }),
  http({
    ...GRID,
    name: 'Edit capsule',
    kind: 'action',
    route: 'POST /capsules/:id',
    request: (f) => post(`/capsules/${f.ids.capsuleId}`, { name: 'Office' }),
    expect: 303,
  }),
  http({
    ...GRID,
    name: 'Capsule members (picker save)',
    kind: 'action',
    route: 'POST /capsules/:id/garments',
    request: (f) =>
      post(`/capsules/${f.ids.capsuleId}/garments`, {
        ids: [String(f.ids.garmentId)],
        shown: [String(f.ids.garmentId), String(f.ids.otherGarmentId)],
      }),
    expect: 303,
  }),
  http({
    ...GRID,
    name: 'Delete capsule',
    kind: 'action',
    route: 'DELETE /capsules/:id',
    prepare: async (f) =>
      idFrom(
        await f.send(post('/capsules', { name: 'Doomed capsule' }), 303),
        /^\/capsules\/(\d+)/,
      ),
    request: (_f, id: number) => ({
      method: 'DELETE',
      url: `/capsules/${id}`,
      htmx: true,
    }),
    expect: 200,
  }),

  // #160 Garment page
  http({
    ...GARMENT,
    name: 'Wore today',
    kind: 'action',
    route: 'POST /wardrobe/:id/wear',
    request: (f) =>
      post(`/wardrobe/${f.ids.garmentId}/wear`, { worn: '1' }, { htmx: true }),
    expect: 200,
  }),
  http({
    ...GARMENT,
    name: 'Washed',
    kind: 'action',
    route: 'POST /wardrobe/:id/washed',
    request: (f) =>
      post(`/wardrobe/${f.ids.garmentId}/washed`, {}, { htmx: true }),
    expect: 200,
  }),
  http({
    ...GARMENT,
    name: 'Where it is (away)',
    kind: 'action',
    route: 'POST /wardrobe/:id/away',
    request: (f) =>
      post(
        `/wardrobe/${f.ids.otherGarmentId}/away`,
        { away: '' },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...GARMENT,
    name: 'Condition',
    kind: 'action',
    route: 'POST /wardrobe/:id/condition',
    request: (f) =>
      post(
        `/wardrobe/${f.ids.garmentId}/condition`,
        { condition: 'good' },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...GARMENT,
    name: 'Capsules row (saved on change)',
    kind: 'action',
    route: 'POST /wardrobe/:id/capsules',
    request: (f) =>
      post(`/wardrobe/${f.ids.garmentId}/capsules`, {
        ids: [String(f.ids.capsuleId)],
        shown: [String(f.ids.capsuleId)],
      }),
    expect: 200,
  }),
  http({
    ...GARMENT,
    name: 'Log a repair',
    kind: 'action',
    route: 'POST /wardrobe/:id/repairs',
    request: (f) =>
      post(`/wardrobe/${f.ids.garmentId}/repairs`, {
        day: f.today(),
        kind: 'alteration',
        note: 'Hemmed',
      }),
    expect: 303,
  }),
  http({
    ...GARMENT,
    name: 'Delete a repair',
    kind: 'action',
    route: 'POST /wardrobe/:id/repairs/:repairId/delete',
    prepare: async (f) => {
      await f.send(
        post(`/wardrobe/${f.ids.garmentId}/repairs`, {
          day: f.today(),
          kind: 'alteration',
          note: 'Doomed',
        }),
        303,
      );
      const s = f.build.schema;
      return newestId(
        f.closet.db
          .select({ id: s.garmentRepair.id })
          .from(s.garmentRepair)
          .where(eq(s.garmentRepair.garmentId, f.ids.garmentId))
          .orderBy(desc(s.garmentRepair.id))
          .limit(1),
        'repair',
      );
    },
    request: (f, id: number) =>
      post(`/wardrobe/${f.ids.garmentId}/repairs/${id}/delete`),
    expect: 303,
  }),
  http({
    ...GARMENT,
    name: 'Archive',
    kind: 'action',
    route: 'POST /wardrobe/:id/archive',
    prepare: async (f) => newGarment(f, 'Audit archive'),
    request: (_f, id: number) =>
      post(`/wardrobe/${id}/archive`, {}, { htmx: true }),
    expect: 200,
  }),
  http({
    ...GARMENT,
    name: 'Restore',
    kind: 'action',
    route: 'POST /wardrobe/:id/restore',
    prepare: async (f) => {
      const id = await newGarment(f, 'Audit restore');
      await f.send(post(`/wardrobe/${id}/archive`, {}, { htmx: true }), 200);
      return id;
    },
    request: (_f, id: number) =>
      post(`/wardrobe/${id}/restore`, {}, { htmx: true }),
    expect: 200,
  }),

  // #161 Add and edit
  http({
    ...FORM,
    name: 'Save a new garment',
    kind: 'action',
    route: 'POST /wardrobe',
    request: () =>
      post('/wardrobe', {
        name: 'Audit oxford',
        category: 'tops',
        brand: 'Uniqlo',
        color: ['blue', 'white'],
        props: '1',
        type: 'shirt',
        warmth: '2',
      }),
    expect: 302,
  }),
  http({
    ...FORM,
    name: 'Save an edit',
    kind: 'action',
    route: 'POST /wardrobe/:id',
    request: (f) =>
      post(`/wardrobe/${f.ids.otherGarmentId}`, {
        name: 'Edited by the audit',
        category: 'tops',
      }),
    expect: 302,
  }),
  http({
    ...FORM,
    name: 'Import a link',
    kind: 'action',
    route: 'POST /wardrobe/new/from-link',
    // LINK_IMPORT_LIMIT: 10 a minute between this and the photo choice.
    runs: 4,
    warmup: 1,
    request: (f) => post('/wardrobe/new/from-link', { url: f.productUrl }),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Choose a link’s photo',
    kind: 'action',
    route: 'POST /wardrobe/new/from-link/photo',
    runs: 4,
    warmup: 1,
    request: (f) =>
      post(
        '/wardrobe/new/from-link/photo',
        { url: f.productUrl.replace('/products/tee', '/img/tee.jpg') },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Add from a photo (upload)',
    kind: 'action',
    route: 'POST /wardrobe/new/photo',
    prepare: (f) => photoUpload(f),
    request: (_f, body) => ({
      method: 'POST',
      url: '/wardrobe/new/photo',
      raw: body,
    }),
    expect: 303,
  }),
  http({
    ...FORM,
    name: 'Add form with a pending photo',
    kind: 'page',
    route: 'GET /wardrobe/new',
    prepare: async (f) => {
      const res = await f.send(
        {
          method: 'POST',
          url: '/wardrobe/new/photo',
          raw: await photoUpload(f),
        },
        303,
      );
      return String(res.headers.location);
    },
    request: (_f, location: string) => get(location),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Clone',
    kind: 'action',
    route: 'POST /wardrobe/:id/clone',
    request: (f) =>
      post(`/wardrobe/${f.ids.garmentId}/clone`, {
        name: 'Audit clone',
        category: 'tops',
      }),
    expect: 302,
  }),
  http({
    ...FORM,
    name: 'Add a copy',
    kind: 'action',
    route: 'POST /wardrobe/:id/copies',
    request: (f) =>
      post(`/wardrobe/${f.ids.otherGarmentId}/copies`, {}, { htmx: true }),
    expect: 303,
  }),
  http({
    ...FORM,
    name: 'Delete a garment',
    kind: 'action',
    route: 'DELETE /wardrobe/:id',
    prepare: (f) => newGarment(f, 'Audit doomed'),
    request: (_f, id: number) => ({
      method: 'DELETE',
      url: `/wardrobe/${id}`,
      htmx: true,
    }),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Save with a pending photo',
    kind: 'action',
    route: 'POST /wardrobe',
    prepare: (f) => uploadedPhoto(f),
    request: (_f, photo: string) =>
      post('/wardrobe', {
        name: 'Audit upload',
        category: 'tops',
        linkPhoto: photo,
      }),
    expect: 302,
  }),
  // Several photos at once (#200): a batch of drafts, each draft's form,
  // its save (on to the next draft) and its discard.
  http({
    ...FORM,
    name: 'Add several photos (a batch of drafts)',
    kind: 'action',
    route: 'POST /wardrobe/new/photo',
    prepare: async (f) => {
      await clearDrafts(f);
      return photoUpload(f, 'photo', 2);
    },
    request: (_f, body) => ({
      method: 'POST',
      url: '/wardrobe/new/photo',
      raw: body,
    }),
    expect: 303,
  }),
  http({
    ...FORM,
    name: 'A draft’s form',
    kind: 'page',
    route: 'GET /wardrobe/new',
    prepare: async (f) => {
      await clearDrafts(f);
      return uploadedPhoto(f, 2);
    },
    request: (_f, photo: string) =>
      get(`/wardrobe/new?photo=${encodeURIComponent(photo)}`),
    expect: 200,
  }),
  http({
    ...FORM,
    name: 'Save a draft',
    kind: 'action',
    route: 'POST /wardrobe',
    prepare: async (f) => {
      await clearDrafts(f);
      return uploadedPhoto(f, 2);
    },
    request: (_f, photo: string) =>
      post('/wardrobe', {
        name: 'Audit draft',
        category: 'tops',
        linkPhoto: photo,
      }),
    expect: 303,
  }),
  http({
    ...FORM,
    name: 'Discard a draft',
    kind: 'action',
    route: 'POST /wardrobe/new/drafts/discard',
    prepare: async (f) => {
      await clearDrafts(f);
      return uploadedPhoto(f, 2);
    },
    request: (_f, photo: string) =>
      post('/wardrobe/new/drafts/discard', { photo }),
    expect: 303,
  }),

  // #162 Photos: uploads, mask edit, retry
  http({
    ...PHOTOS,
    name: 'Upload a photo',
    kind: 'action',
    route: 'POST /wardrobe/:id/photo',
    prepare: (f) => photoUpload(f),
    request: (f, body) => ({
      method: 'POST',
      url: `/wardrobe/${f.ids.otherGarmentId}/photo`,
      raw: body,
    }),
    expect: 303,
  }),
  http({
    ...PHOTOS,
    name: 'Save a mask edit',
    kind: 'action',
    route: 'POST /wardrobe/:id/nobg',
    prepare: (f) => photoUpload(f, 'nobgPhoto'),
    request: (f, body) => ({
      method: 'POST',
      url: `/wardrobe/${f.ids.garmentId}/nobg`,
      raw: body,
    }),
    expect: 200,
  }),
  http({
    ...PHOTOS,
    name: 'Rotate the photo',
    kind: 'action',
    route: 'POST /wardrobe/:id/photo/rotate',
    // A quarter turn each run: every run rewrites the original and its
    // variants, as a tap does.
    request: (f) =>
      post(`/wardrobe/${f.ids.otherGarmentId}/photo/rotate`, {
        direction: 'right',
      }),
    expect: 303,
  }),
  http({
    ...PHOTOS,
    name: 'Try the cutout again',
    kind: 'action',
    route: 'POST /wardrobe/:id/cutout/retry',
    request: (f) => post(`/wardrobe/${f.ids.otherGarmentId}/cutout/retry`),
    expect: 303,
  }),

  // #163 Styling
  http({
    ...STYLING,
    name: 'Save an outfit',
    kind: 'action',
    route: 'POST /styling',
    request: (f) =>
      post('/styling', {
        role: ['top', 'bottom'],
        garmentId: f.ids.outfitGarmentIds.slice(0, 2).map(String),
        lock: ['', ''],
        name: 'Audit look',
      }),
    expect: 303,
  }),
  http({
    ...STYLING,
    name: 'Save refused, the page again (an archived garment)',
    kind: 'action',
    route: 'POST /styling',
    prepare: async (f) => {
      const id = await newGarment(f, 'Audit archived tee');
      await f.send(post(`/wardrobe/${id}/archive`, {}, { htmx: true }), 200);
      return id;
    },
    request: (f, id: number) =>
      post('/styling', {
        role: ['top', 'bottom'],
        garmentId: [String(id), String(f.ids.outfitGarmentIds[1])],
        lock: ['', ''],
        name: 'Audit refused look',
      }),
    expect: 409,
  }),

  // #164 Outfits
  http({
    ...OUTFITS,
    name: 'Create an outfit',
    kind: 'action',
    route: 'POST /outfits',
    request: (f) =>
      post('/outfits', {
        name: 'Audit outfit',
        category: ['top', 'bottom'],
        garmentId: f.ids.outfitGarmentIds.slice(0, 2).map(String),
      }),
    expect: 302,
  }),
  http({
    ...OUTFITS,
    name: 'Edit an outfit',
    kind: 'action',
    route: 'POST /outfits/:id',
    prepare: (f) => newOutfit(f),
    request: (f, id: number) =>
      post(`/outfits/${id}`, {
        name: 'Renamed by the audit',
        category: ['top', 'bottom'],
        garmentId: f.ids.outfitGarmentIds.slice(0, 2).map(String),
      }),
    expect: 302,
  }),
  http({
    ...OUTFITS,
    name: 'Delete an outfit',
    kind: 'action',
    route: 'DELETE /outfits/:id',
    prepare: (f) => newOutfit(f),
    request: (_f, id: number) => ({
      method: 'DELETE',
      url: `/outfits/${id}`,
      htmx: true,
    }),
    expect: 200,
  }),

  // #165 Calendar
  http({
    ...CALENDAR,
    name: 'Plan an outfit on a day',
    kind: 'action',
    route: 'POST /calendar',
    request: (f) =>
      post('/calendar', {
        date: day(f, 3),
        outfitId: String(f.ids.outfitId),
        occasion: 'evening',
      }),
    expect: 302,
  }),
  http({
    ...CALENDAR,
    name: 'Remove a planned entry',
    kind: 'action',
    route: 'POST /calendar/:id/delete',
    prepare: async (f) => {
      await f.send(
        post('/calendar', {
          date: day(f, 4),
          outfitId: String(f.ids.outfitId),
          occasion: 'night-out',
        }),
        302,
      );
      const s = f.build.schema;
      return newestId(
        f.closet.db
          .select({ id: s.outfitCalendar.id })
          .from(s.outfitCalendar)
          .where(eq(s.outfitCalendar.ownerId, f.theo.id))
          .orderBy(desc(s.outfitCalendar.id))
          .limit(1),
        'calendar entry',
      );
    },
    request: (f, id: number) =>
      post(`/calendar/${id}/delete`, { week: f.today() }),
    expect: 303,
  }),
  http({
    ...CALENDAR,
    name: 'Mark worn (calendar)',
    kind: 'action',
    route: 'POST /calendar/:id/worn',
    prepare: (f) =>
      f.send(post(`/calendar/${f.ids.wornEntryId}/worn`, { worn: '0' }), 303),
    request: (f) =>
      post(`/calendar/${f.ids.wornEntryId}/worn`, {
        worn: '1',
        week: f.today(),
      }),
    expect: 303,
  }),
  http({
    ...CALENDAR,
    name: 'Plan my week',
    kind: 'action',
    route: 'POST /calendar/plan-week',
    request: () => post('/calendar/plan-week'),
    expect: 303,
  }),
  http({
    ...CALENDAR,
    name: 'Undo Plan my week',
    kind: 'action',
    route: 'POST /calendar/plan-week/:id/undo',
    prepare: async (f) => {
      await f.send(post('/calendar/plan-week'), 303);
      const s = f.build.schema;
      return newestId(
        f.closet.db
          .select({ id: s.weekPlan.id })
          .from(s.weekPlan)
          .where(eq(s.weekPlan.ownerId, f.theo.id))
          .orderBy(desc(s.weekPlan.id))
          .limit(1),
        'week plan',
      );
    },
    request: (_f, id: number) => post(`/calendar/plan-week/${id}/undo`),
    expect: 303,
  }),
  http({
    ...CALENDAR,
    name: 'Save the week template',
    kind: 'action',
    route: 'POST /auth/profile/week',
    // Theo's own template posted back as the form posts it: a save that
    // changes nothing, so the steps after it (plan_week) still plan his
    // week. The form's fields are by weekday number (`day-1`); names it
    // does not have are stripped, which saved an empty template.
    prepare: async (f) =>
      f.build.weekTemplate.weekTemplatePost(
        await f.build.weekTemplate.findWeekTemplate(f.closet.db, f.theo.id),
      ),
    request: (_f, form) => post('/auth/profile/week', form),
    expect: 303,
  }),
  http({
    ...CALENDAR,
    name: 'Add a selfie',
    kind: 'action',
    route: 'POST /calendar/:id/selfie',
    prepare: (f) => photoUpload(f),
    request: (f, body) => ({
      method: 'POST',
      url: `/calendar/${f.ids.wornEntryId}/selfie`,
      raw: body,
    }),
    expect: 303,
  }),
  http({
    ...CALENDAR,
    name: 'Remove a selfie',
    kind: 'action',
    route: 'POST /selfies/:id/delete',
    prepare: async (f) => {
      await f.send(
        {
          method: 'POST',
          url: `/calendar/${f.ids.wornEntryId}/selfie`,
          raw: await photoUpload(f),
        },
        303,
      );
      const s = f.build.schema;
      return newestId(
        f.closet.db
          .select({ id: s.selfie.id })
          .from(s.selfie)
          .where(eq(s.selfie.ownerId, f.theo.id))
          .orderBy(desc(s.selfie.id))
          .limit(1),
        'selfie',
      );
    },
    request: (_f, id: number) => post(`/selfies/${id}/delete`),
    expect: 303,
  }),

  // #166 Trips
  http({
    ...TRIPS,
    name: 'Create a trip',
    kind: 'action',
    route: 'POST /trips',
    request: (f) =>
      post('/trips', {
        name: 'Audit trip',
        startsOn: day(f, 30),
        endsOn: day(f, 33),
      }),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Edit a trip',
    kind: 'action',
    route: 'POST /trips/:id',
    request: (f) =>
      post(`/trips/${f.ids.tripId}`, {
        name: f.ids.trip.name,
        startsOn: f.ids.trip.startsOn,
        endsOn: f.ids.trip.endsOn,
      }),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Delete a trip',
    kind: 'action',
    route: 'DELETE /trips/:id',
    prepare: async (f) =>
      idFrom(
        await f.send(
          post('/trips', {
            name: 'Doomed trip',
            startsOn: day(f, 50),
            endsOn: day(f, 51),
          }),
          303,
        ),
        /^\/trips\/(\d+)/,
      ),
    request: (_f, id: number) => ({
      method: 'DELETE',
      url: `/trips/${id}`,
      htmx: true,
    }),
    expect: 200,
  }),
  http({
    ...TRIPS,
    name: 'Add an outfit to the trip',
    kind: 'action',
    route: 'POST /trips/:id/outfits',
    request: (f) =>
      post(`/trips/${f.ids.tripId}/outfits`, {
        outfitId: String(f.ids.outfitId),
        day: '',
        occasion: '',
      }),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Remove a trip outfit',
    kind: 'action',
    route: 'POST /trips/:id/outfits/:tripOutfitId/delete',
    prepare: async (f) => {
      await f.send(
        post(`/trips/${f.ids.tripId}/outfits`, {
          outfitId: String(f.ids.outfitId),
          day: '',
          occasion: '',
        }),
        303,
      );
      const s = f.build.schema;
      return newestId(
        f.closet.db
          .select({ id: s.tripOutfit.id })
          .from(s.tripOutfit)
          .where(eq(s.tripOutfit.tripId, f.ids.tripId))
          .orderBy(desc(s.tripOutfit.id))
          .limit(1),
        'trip outfit',
      );
    },
    request: (f, id: number) =>
      post(`/trips/${f.ids.tripId}/outfits/${id}/delete`),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Wear on a trip day',
    kind: 'action',
    route: 'POST /trips/:id/outfits/:tripOutfitId/wear',
    // Only on the trip's day: a trip of today's with the outfit on it.
    prepare: async (f) => {
      const tripId = idFrom(
        await f.send(
          post('/trips', {
            name: 'Day trip',
            startsOn: f.today(),
            endsOn: f.today(),
          }),
          303,
        ),
        /^\/trips\/(\d+)/,
      );
      await f.send(
        post(`/trips/${tripId}/outfits`, {
          outfitId: String(f.ids.outfitId),
          day: f.today(),
          occasion: 'daytime',
        }),
        303,
      );
      const s = f.build.schema;
      const tripOutfitId = await newestId(
        f.closet.db
          .select({ id: s.tripOutfit.id })
          .from(s.tripOutfit)
          .where(eq(s.tripOutfit.tripId, tripId))
          .orderBy(desc(s.tripOutfit.id))
          .limit(1),
        'trip outfit',
      );
      return { tripId, tripOutfitId };
    },
    request: (
      _f,
      { tripId, tripOutfitId }: { tripId: number; tripOutfitId: number },
    ) => post(`/trips/${tripId}/outfits/${tripOutfitId}/wear`),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Pack garments',
    kind: 'action',
    route: 'POST /trips/:id/packed',
    request: (f) =>
      post(`/trips/${f.ids.tripId}/packed`, {
        packed: [String(f.ids.outfitGarmentIds[0])],
        shown: f.ids.outfitGarmentIds.map(String),
      }),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Add a packing item',
    kind: 'action',
    route: 'POST /trips/:id/items',
    request: (f) => post(`/trips/${f.ids.tripId}/items`, { label: 'Adapter' }),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Pack items',
    kind: 'action',
    route: 'POST /trips/:id/items/packed',
    request: (f) =>
      post(`/trips/${f.ids.tripId}/items/packed`, {
        packed: [String(f.ids.tripItemId)],
        shown: [String(f.ids.tripItemId)],
      }),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Remove a packing item',
    kind: 'action',
    route: 'POST /trips/:id/items/:itemId/delete',
    prepare: async (f) => {
      await f.send(
        post(`/trips/${f.ids.tripId}/items`, { label: 'Doomed' }),
        303,
      );
      const s = f.build.schema;
      return newestId(
        f.closet.db
          .select({ id: s.tripItem.id })
          .from(s.tripItem)
          .where(eq(s.tripItem.tripId, f.ids.tripId))
          .orderBy(desc(s.tripItem.id))
          .limit(1),
        'trip item',
      );
    },
    request: (f, id: number) =>
      post(`/trips/${f.ids.tripId}/items/${id}/delete`),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Copy another trip’s items',
    kind: 'action',
    route: 'POST /trips/:id/items/copy',
    prepare: async (f) =>
      idFrom(
        await f.send(
          post('/trips', {
            name: 'Copy target',
            startsOn: day(f, 60),
            endsOn: day(f, 61),
          }),
          303,
        ),
        /^\/trips\/(\d+)/,
      ),
    request: (f, id: number) =>
      post(`/trips/${id}/items/copy`, { from: String(f.ids.tripId) }),
    expect: 303,
  }),
  http({
    ...TRIPS,
    name: 'Destination search',
    kind: 'fragment',
    route: 'GET /trips/:id/places',
    // WEATHER_SEARCH_LIMIT: 20 a minute.
    runs: 16,
    warmup: 1,
    request: (f) =>
      get(`/trips/${f.ids.tripId}/places?q=brooklyn`, { htmx: true }),
    expect: 200,
  }),
  http({
    ...TRIPS,
    name: 'Set the destination',
    kind: 'action',
    route: 'POST /trips/:id/destination',
    // WEATHER_LOCATION_LIMIT: 10 a minute.
    runs: 8,
    warmup: 1,
    request: (f) =>
      post(
        `/trips/${f.ids.tripId}/destination`,
        { name: 'Brooklyn', latitude: '40.65', longitude: '-73.95' },
        { htmx: true },
      ),
    expect: 303,
  }),

  // #167 Plans, shopping, wishlist, Bought it
  http({
    ...PLANS,
    name: 'Create a plan',
    kind: 'action',
    route: 'POST /wardrobe/plans',
    request: () => post('/wardrobe/plans', { name: `Audit plan ${unique()}` }),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Plan from a wardrobe',
    kind: 'action',
    route: 'POST /wardrobe/plans/from-wardrobe',
    request: (f) =>
      post('/wardrobe/plans/from-wardrobe', { ownerId: String(f.ids.dana.id) }),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Edit a plan',
    kind: 'action',
    route: 'POST /wardrobe/plans/:id',
    request: (f) =>
      post(`/wardrobe/plans/${f.ids.planId}`, { name: 'NYC minimal' }),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Duplicate a plan',
    kind: 'action',
    route: 'POST /wardrobe/plans/:id/duplicate',
    request: (f) => post(`/wardrobe/plans/${f.ids.planId}/duplicate`),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Activate a plan',
    kind: 'action',
    route: 'POST /wardrobe/plans/:id/activate',
    request: (f) => post(`/wardrobe/plans/${f.ids.planId}/activate`),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Delete a plan',
    kind: 'action',
    route: 'DELETE /wardrobe/plans/:id',
    prepare: async (f) =>
      idFrom(
        await f.send(post('/wardrobe/plans', { name: 'Doomed plan' }), 303),
        /^\/wardrobe\/plans\/(\d+)/,
      ),
    request: (_f, id: number) => ({
      method: 'DELETE',
      url: `/wardrobe/plans/${id}`,
      htmx: true,
    }),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Add a plan item',
    kind: 'action',
    route: 'POST /wardrobe/plans/:id/items',
    request: (f) =>
      post(`/wardrobe/plans/${f.ids.planId}/items`, {
        category: 'tops',
        name: 'Audit item',
      }),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Edit a plan item',
    kind: 'action',
    route: 'POST /wardrobe/plans/:id/items/:itemId',
    prepare: async (f) => {
      await f.send(
        post(`/wardrobe/plans/${f.ids.planId}/items`, {
          category: 'tops',
          name: 'Edited item',
        }),
        303,
      );
      return newestPlanItem(f);
    },
    request: (f, id: number) =>
      post(`/wardrobe/plans/${f.ids.planId}/items/${id}`, {
        category: 'bottoms',
        name: 'Edited item',
      }),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Accept a proposed item',
    kind: 'action',
    route: 'POST /wardrobe/plans/:id/items/:itemId/accept',
    prepare: async (f) => {
      await f.send(proposeItem(f), 200);
      return newestPlanItem(f);
    },
    request: (f, id: number) =>
      post(`/wardrobe/plans/${f.ids.planId}/items/${id}/accept`),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Delete a plan item',
    kind: 'action',
    route: 'DELETE /wardrobe/plans/:id/items/:itemId',
    prepare: async (f) => {
      await f.send(
        post(`/wardrobe/plans/${f.ids.planId}/items`, {
          category: 'tops',
          name: 'Doomed item',
        }),
        303,
      );
      return newestPlanItem(f);
    },
    request: (f, id: number) => ({
      method: 'DELETE',
      url: `/wardrobe/plans/${f.ids.planId}/items/${id}`,
      htmx: true,
    }),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Save candidates',
    kind: 'action',
    route: 'POST /wardrobe/plans/:id/items/:itemId/candidates',
    request: (f) =>
      post(
        `/wardrobe/plans/${f.ids.planId}/items/${f.ids.planItemId}/candidates`,
        {
          garmentIds: [String(f.ids.wishlistId)],
          shown: [String(f.ids.wishlistId)],
        },
      ),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Save a wishlist item’s plan items',
    kind: 'action',
    route: 'POST /wardrobe/:id/plan-items',
    request: (f) =>
      post(`/wardrobe/${f.ids.wishlistId}/plan-items`, {
        itemIds: [String(f.ids.planItemId)],
        shown: [String(f.ids.planItemId)],
      }),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Bought it',
    kind: 'action',
    route: 'POST /wardrobe/:id/bought',
    prepare: async (f) => {
      // As the wishlist's form posts it (test/integration/garments.ts).
      const res = await f.send(
        post('/wardrobe', {
          name: 'Audit wish',
          category: 'tops',
          to: 'wishlist',
          wishlist: '1',
        }),
        302,
      );
      return idFrom(res, /^\/wardrobe\/(\d+)/);
    },
    request: (f, id: number) =>
      post(`/wardrobe/${id}/bought`, { acquiredOn: f.today(), price: '40' }),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Save the style profile',
    kind: 'action',
    route: 'POST /auth/profile/style',
    request: () =>
      post('/auth/profile/style', {
        styles: ['minimal'],
        budget: '',
        notes: 'Audit',
      }),
    expect: 303,
  }),
  http({
    ...PLANS,
    name: 'Add an order item to the closet',
    kind: 'action',
    route: 'POST /wardrobe/orders/:id/add',
    // Its own LINK_IMPORT_LIMIT: 10 a minute. The form opens; nothing is
    // saved, so the item stays pending for the next run.
    runs: 8,
    warmup: 1,
    request: (f) => post(`/wardrobe/orders/${f.orders.addItemId}/add`),
    expect: 200,
  }),
  http({
    ...PLANS,
    name: 'Dismiss an order item',
    kind: 'action',
    route: 'POST /wardrobe/orders/:id/dismiss',
    prepare: (f) => newOrderItem(f),
    request: (_f, id: number) => post(`/wardrobe/orders/${id}/dismiss`),
    expect: 303,
  }),

  // #168 Ideas
  http({
    ...IDEAS,
    name: 'Pick an idea',
    kind: 'action',
    route: 'POST /outfits/ideas/pick',
    request: (f) =>
      post('/outfits/ideas/pick', {
        garmentId: f.ids.outfitGarmentIds.map(String),
      }),
    expect: 303,
  }),
  http({
    ...IDEAS,
    name: 'Never pair these (clash)',
    kind: 'action',
    route: 'POST /outfits/ideas/avoid',
    request: (f) =>
      post('/outfits/ideas/avoid', {
        garmentId: f.ids.outfitGarmentIds.slice(0, 2).map(String),
      }),
    expect: 303,
  }),
  http({
    ...IDEAS,
    name: 'Pair them again',
    kind: 'action',
    route: 'POST /outfits/ideas/allow',
    prepare: (f) =>
      f.send(
        post('/outfits/ideas/avoid', {
          garmentId: f.ids.outfitGarmentIds.slice(0, 2).map(String),
        }),
        303,
      ),
    request: (f) =>
      post('/outfits/ideas/allow', {
        garmentId: f.ids.outfitGarmentIds.slice(0, 2).map(String),
      }),
    expect: 303,
  }),
  http({
    ...IDEAS,
    name: 'Too warm',
    kind: 'action',
    route: 'POST /outfits/ideas/feedback',
    request: () => post('/outfits/ideas/feedback', { feeling: 'too-warm' }),
    expect: 303,
  }),

  // #170 Sharing: invites
  http({
    ...SHARING,
    name: 'Create an invite link',
    kind: 'action',
    route: 'POST /wardrobe-share/create-invite-link',
    request: () =>
      post(
        '/wardrobe-share/create-invite-link',
        { permission: 'VIEW' },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Invite landing',
    kind: 'page',
    route: 'GET /wardrobe-share/invite/:token',
    prepare: async (f) => ({
      token: await newInvite(f),
      guest: await f.newAccount(),
    }),
    request: (_f, { token, guest }: { token: string; guest: Actor }) =>
      get(`/wardrobe-share/invite/${token}`, { as: guest }),
    expect: 200,
  }),
  http({
    ...SHARING,
    name: 'Accept an invite',
    kind: 'action',
    route: 'POST /wardrobe-share/invite/:token/accept',
    prepare: async (f) => ({
      token: await newInvite(f),
      guest: await f.newAccount(),
    }),
    request: (_f, { token, guest }: { token: string; guest: Actor }) =>
      post(`/wardrobe-share/invite/${token}/accept`, {}, { as: guest }),
    expect: 302,
  }),
  http({
    ...SHARING,
    name: 'Decline an invite',
    kind: 'action',
    route: 'POST /wardrobe-share/invite/:token/decline',
    prepare: async (f) => ({
      token: await newInvite(f),
      guest: await f.newAccount(),
    }),
    request: (_f, { token, guest }: { token: string; guest: Actor }) =>
      post(`/wardrobe-share/invite/${token}/decline`, {}, { as: guest }),
    expect: 302,
  }),
  http({
    ...SHARING,
    name: 'Remove a share',
    kind: 'action',
    route: 'POST /wardrobe-share/:id/remove',
    prepare: async (f) => {
      const token = await newInvite(f);
      const guest = await f.newAccount();
      await f.send(
        post(`/wardrobe-share/invite/${token}/accept`, {}, { as: guest }),
        302,
      );
      const s = f.build.schema;
      return newestId(
        f.closet.db
          .select({ id: s.wardrobeShare.id })
          .from(s.wardrobeShare)
          .where(
            and(
              eq(s.wardrobeShare.grantorId, f.theo.id),
              eq(s.wardrobeShare.granteeId, guest.id),
            ),
          ),
        'share',
      );
    },
    request: (_f, id: number) => post(`/wardrobe-share/${id}/remove`),
    expect: 302,
  }),
  http({
    ...SHARING,
    name: 'Edit a shared garment (MANAGE)',
    kind: 'action',
    route: 'POST /wardrobe/:id',
    request: (f) =>
      post(`/wardrobe/${f.ids.dana.garmentId}?ownerId=${f.ids.dana.id}`, {
        name: 'Dana’s, edited by Theo',
        category: 'tops',
      }),
    expect: 302,
  }),

  // #171 Auth, account, push
  http({
    ...ACCOUNT,
    name: 'Sign in',
    kind: 'action',
    route: 'POST /auth/login',
    prepare: () => Promise.resolve({ 'x-forwarded-for': nextClient() }),
    request: (f, headers: Record<string, string>) =>
      post(
        '/auth/login',
        { email: f.theo.email, password: PERSONA_PASSWORD },
        { as: null, headers },
      ),
    expect: 302,
  }),
  http({
    ...ACCOUNT,
    name: 'Register',
    kind: 'action',
    route: 'POST /auth/register',
    prepare: () =>
      Promise.resolve({
        email: `joiner-${nextClient()}@example.com`,
        client: nextClient(),
      }),
    request: (_f, { email, client }: { email: string; client: string }) =>
      post(
        '/auth/register',
        {
          email,
          password: ACCOUNT_PASSWORD,
          confirmPassword: ACCOUNT_PASSWORD,
        },
        { as: null, headers: { 'x-forwarded-for': client } },
      ),
    expect: 302,
  }),
  http({
    ...ACCOUNT,
    name: 'Validate registration (as typed)',
    kind: 'fragment',
    route: 'POST /auth/validate/register',
    request: () =>
      post(
        '/auth/validate/register',
        {
          email: 'someone@example.com',
          password: 'short',
          confirmPassword: 'other',
        },
        { as: null, htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Validate an email change',
    kind: 'fragment',
    route: 'POST /auth/validate/update-email',
    request: () =>
      post(
        '/auth/validate/update-email',
        { email: 'new@example.com', confirmEmail: 'new@example.com' },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Change email',
    kind: 'action',
    route: 'POST /auth/update-email',
    prepare: (f) => f.newAccount(),
    request: (_f, who: Actor) =>
      post(
        '/auth/update-email',
        {
          email: `moved-${who.id}@example.com`,
          confirmEmail: `moved-${who.id}@example.com`,
          currentPassword: ACCOUNT_PASSWORD,
        },
        { as: who },
      ),
    expect: 302,
  }),
  http({
    ...ACCOUNT,
    name: 'Change password',
    kind: 'action',
    route: 'POST /auth/change-password',
    prepare: (f) => f.newAccount(),
    request: (_f, who: Actor) =>
      post(
        '/auth/change-password',
        {
          currentPassword: ACCOUNT_PASSWORD,
          newPassword: 'Audit-pass-2',
          confirmPassword: 'Audit-pass-2',
        },
        { as: who },
      ),
    expect: 302,
  }),
  http({
    ...ACCOUNT,
    name: 'Delete account',
    kind: 'action',
    route: 'POST /auth/delete-account',
    prepare: (f) => f.newAccount(),
    request: (_f, who: Actor) =>
      post(
        '/auth/delete-account',
        { email: who.email, password: ACCOUNT_PASSWORD },
        { as: who },
      ),
    expect: 302,
  }),
  http({
    ...ACCOUNT,
    name: 'Create an access token',
    kind: 'action',
    route: 'POST /auth/tokens',
    prepare: (f) => f.newAccount(),
    request: (_f, who: Actor) =>
      post(
        '/auth/tokens',
        { name: 'Laptop', currentPassword: ACCOUNT_PASSWORD },
        { as: who },
      ),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Revoke an access token',
    kind: 'action',
    route: 'POST /auth/tokens/:id/revoke',
    prepare: async (f) => {
      const created = await f.build.tokens.createToken(
        f.closet.db,
        f.theo.id,
        'Doomed',
      );
      if (!created.created) throw new Error('Theo has too many tokens');
      return created.id;
    },
    request: (_f, id: number) => post(`/auth/tokens/${id}/revoke`),
    expect: 303,
  }),
  http({
    ...ACCOUNT,
    name: 'Sign out',
    kind: 'action',
    route: 'POST /auth/logout',
    request: () => post('/auth/logout'),
    expect: 303,
  }),
  http({
    ...ACCOUNT,
    name: 'Subscribe a device',
    kind: 'action',
    route: 'POST /push/subscribe',
    request: () => ({
      method: 'POST',
      url: '/push/subscribe',
      json: newSubscription(),
    }),
    expect: 204,
  }),
  http({
    ...ACCOUNT,
    name: 'Unsubscribe a device',
    kind: 'action',
    route: 'POST /push/unsubscribe',
    prepare: async (f) => {
      const subscription = newSubscription();
      await f.send(
        { method: 'POST', url: '/push/subscribe', json: subscription },
        204,
      );
      return subscription.endpoint;
    },
    request: (_f, endpoint: string) => ({
      method: 'POST',
      url: '/push/unsubscribe',
      json: { endpoint },
    }),
    expect: 204,
  }),
  http({
    ...ACCOUNT,
    name: 'Send a test notification',
    kind: 'action',
    route: 'POST /push/test',
    request: () => post('/push/test', {}, { htmx: true }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Sizes: unit',
    kind: 'action',
    route: 'POST /auth/profile/sizes/unit',
    request: () => post('/auth/profile/sizes/unit', { unit: 'in' }),
    expect: 303,
  }),
  http({
    ...ACCOUNT,
    name: 'Sizes: measurements',
    kind: 'action',
    route: 'POST /auth/profile/sizes/measurements',
    request: () =>
      post('/auth/profile/sizes/measurements', { unit: 'in', chest: '40' }),
    expect: 303,
  }),
  http({
    ...ACCOUNT,
    name: 'Sizes: add a brand',
    kind: 'action',
    route: 'POST /auth/profile/sizes/brands',
    prepare: () => Promise.resolve(`Audit brand ${nextClient()}`),
    request: (_f, brand: string) =>
      post('/auth/profile/sizes/brands', {
        brand,
        size: 'M',
        note: 'Runs small',
      }),
    expect: 303,
  }),
  http({
    ...ACCOUNT,
    name: 'Sizes: edit a brand',
    kind: 'action',
    route: 'POST /auth/profile/sizes/brands/:id',
    request: (f) =>
      post(`/auth/profile/sizes/brands/${f.ids.brandSizeId}`, {
        brand: 'Uniqlo',
        size: 'M',
      }),
    expect: 303,
  }),
  http({
    ...ACCOUNT,
    name: 'Sizes: remove a brand',
    kind: 'action',
    route: 'POST /auth/profile/sizes/brands/:id/delete',
    prepare: async (f) => {
      await f.send(
        post('/auth/profile/sizes/brands', {
          brand: `Doomed ${nextClient()}`,
          size: 'M',
        }),
        303,
      );
      const s = f.build.schema;
      return newestId(
        f.closet.db
          .select({ id: s.brandSize.id })
          .from(s.brandSize)
          .where(eq(s.brandSize.userId, f.theo.id))
          .orderBy(desc(s.brandSize.id))
          .limit(1),
        'brand size',
      );
    },
    request: (_f, id: number) =>
      post(`/auth/profile/sizes/brands/${id}/delete`),
    expect: 303,
  }),
  http({
    ...ACCOUNT,
    name: 'Weather: city search',
    kind: 'fragment',
    route: 'GET /weather/places',
    // WEATHER_SEARCH_LIMIT: 20 a minute, shared with nothing else here.
    runs: 16,
    warmup: 1,
    request: () => get('/weather/places?q=brooklyn', { htmx: true }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Weather: set home',
    kind: 'action',
    route: 'POST /weather/home',
    runs: 8,
    warmup: 1,
    request: () =>
      post(
        '/weather/home',
        {
          name: 'Fort Greene, Brooklyn',
          latitude: '40.69',
          longitude: '-73.98',
        },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Weather: use this phone’s location',
    kind: 'action',
    route: 'POST /weather/here',
    runs: 8,
    warmup: 1,
    request: () =>
      post(
        '/weather/here',
        { latitude: '40.712776', longitude: '-74.005974' },
        { htmx: true },
      ),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Weather: stop using this phone’s location',
    kind: 'action',
    route: 'POST /weather/here/clear',
    request: () => post('/weather/here/clear', {}, { htmx: true }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Weather: unit',
    kind: 'action',
    route: 'POST /weather/unit',
    request: () =>
      post('/weather/unit', { unit: 'fahrenheit' }, { htmx: true }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Weather: feels warmer or colder',
    kind: 'action',
    route: 'POST /weather/feedback',
    request: () =>
      post('/weather/feedback', { feeling: 'too-cold' }, { htmx: true }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Weather: reset the offset',
    kind: 'action',
    route: 'POST /weather/offset/reset',
    request: () => post('/weather/offset/reset', {}, { htmx: true }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Weather: remove home',
    kind: 'action',
    route: 'POST /weather/home/clear',
    // Home back afterwards: the pages measured later read Theo's weather.
    request: () => post('/weather/home/clear', {}, { htmx: true }),
    expect: 200,
  }),
  http({
    ...ACCOUNT,
    name: 'Weather: set home again',
    kind: 'action',
    route: 'POST /weather/home',
    runs: 1,
    warmup: 0,
    request: () =>
      post(
        '/weather/home',
        {
          name: 'Fort Greene, Brooklyn',
          latitude: '40.69',
          longitude: '-73.98',
        },
        { htmx: true },
      ),
    expect: 200,
  }),

  // #174 Platform: the beacons
  http({
    ...PLATFORM,
    name: 'Device timings beacon',
    kind: 'platform',
    route: 'POST /metrics/vitals',
    // VITALS_LIMIT: 30 a minute.
    runs: 20,
    // sendBeacon's text/plain string (src/web/metrics/beacon.ts).
    request: () => ({
      method: 'POST',
      url: '/metrics/vitals',
      raw: {
        payload: JSON.stringify({
          samples: [
            {
              route: '/wardrobe',
              kind: 'full',
              cache: false,
              ms: { ttfb: 120, lcp: 480 },
            },
          ],
        }),
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
      },
    }),
    expect: 204,
  }),
  http({
    ...PLATFORM,
    name: 'Script error beacon',
    kind: 'platform',
    route: 'POST /errors/client',
    // CLIENT_ERROR_LIMIT: 10 a minute. Forwarded to the Bugsink stand-in.
    runs: 8,
    warmup: 1,
    request: () => ({
      method: 'POST',
      url: '/errors/client',
      raw: {
        payload: JSON.stringify({
          message: 'Error: page audit',
          route: '/wardrobe',
        }),
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
      },
    }),
    expect: 204,
  }),
];

// --- MCP tools (#172) -----------------------------------------------------

const tools: Step[] = [
  mcp('get_today', () => ({})),
  mcp('search_garments', () => ({ category: 'tops' })),
  mcp('search_garments', () => ({ keyword: 'shirt' }), {
    label: 'search_garments (keyword)',
  }),
  mcp('get_garment', (f) => ({ id: f.ids.garmentId })),
  mcp('get_garment_photo', (f) => ({ id: f.ids.garmentId })),
  mcp('update_garment', (f) => ({ id: f.ids.otherGarmentId, warmth: 3 })),
  // A garment of its own each run: one holds at most 30 copies.
  mcp('add_garment_copy', (_f, id: number) => ({ id, copies: 1 }), {
    prepare: (f) => newGarment(f, 'Audit copies'),
  }),
  mcp('list_wishlist', () => ({})),
  mcp(
    'add_garment_from_link',
    (f) => ({ url: f.productUrl, destination: 'wishlist' }),
    { runs: 8, warmup: 1 },
  ),
  mcp('list_capsules', () => ({})),
  mcp('get_capsule', (f) => ({ id: f.ids.capsuleId })),
  mcp('set_capsule_membership', (f) => ({
    id: f.ids.capsuleId,
    add: [f.ids.garmentId],
  })),
  mcp('list_outfits', () => ({})),
  mcp('get_outfit', (f) => ({ id: f.ids.outfitId })),
  mcp('create_outfit', (f) => ({
    garmentIds: f.ids.outfitGarmentIds,
    name: 'Audit (MCP)',
  })),
  mcp('schedule_outfit', (f) => ({
    outfitId: f.ids.outfitId,
    date: day(f, 5),
    occasion: 'evening',
  })),
  mcp('suggest_outfits', (f) => ({ date: day(f, 1), occasion: 'work' })),
  mcp('goes_with_closet', (f) => ({ garmentId: f.ids.wishlistId })),
  mcp('pick_outfit', (f) => ({
    garmentIds: f.ids.outfitGarmentIds,
    date: day(f, 6),
    occasion: 'evening',
  })),
  mcp('get_calendar', (f) => ({ from: day(f, -7), to: day(f, 7) })),
  mcp('laundry_status', () => ({})),
  mcp('mark_worn', (f) => ({ garmentId: f.ids.garmentId })),
  mcp('mark_washed', (f) => ({ garmentIds: [f.ids.garmentId] })),
  mcp('plan_week', () => ({})),
  mcp('list_trips', () => ({})),
  mcp('get_trip', (f) => ({ tripId: f.ids.tripId })),
  mcp('plan_trip_outfit', (f) => ({
    tripId: f.ids.tripId,
    outfitId: f.ids.outfitId,
  })),
  mcp('wardrobe_stats', () => ({})),
  mcp('get_weather', (f) => ({ from: f.today(), to: day(f, 3) })),
  mcp('list_shared_wardrobes', () => ({})),
  mcp('compare_with_shared_wardrobe', (f) => ({ ownerId: f.ids.dana.id })),
  mcp('get_style_profile', () => ({})),
  mcp('list_plans', () => ({})),
  // A name per run: the repeat of a taken name is refused (#269).
  mcp('create_plan', () => ({ name: `Audit draft ${++auditDrafts}` })),
  mcp('get_plan_gaps', () => ({})),
  mcp('propose_plan_item', () => ({
    category: 'tops',
    name: 'Audit proposal',
  })),
  mcp('update_plan_item', (f) => ({
    itemId: f.ids.planItemId,
    category: 'tops',
  })),
  mcp('get_sizes', () => ({})),
  mcp('get_shopping_list', () => ({})),
  mcp('add_candidate', (f) => ({
    itemId: f.ids.planItemId,
    garmentId: f.ids.wishlistId,
  })),
  mcp('compare_plans', (f) => ({ a: f.ids.planId, b: f.ids.planId })),
];

// --- jobs (#173) ----------------------------------------------------------

/** A second into `hour` today in the household's zone. */
const todayAt = (f: Fixture, hour: number, minute = 0) =>
  new Date(
    f.build.calendar.instantAt(f.today(), hour, f.timeZone, minute).getTime() +
      1000,
  );

function replanDeps(f: Fixture) {
  return {
    db: f.closet.db,
    weather: f.closet.weather,
    push: f.closet.push,
    timeZone: f.timeZone,
    logger: f.logger.child({ context: 'WeekPlan' }),
  };
}

function reminderDeps(f: Fixture) {
  return {
    db: f.closet.db,
    sender: f.closet.push!,
    weather: f.closet.weather,
    timeZone: f.timeZone,
    logger: f.logger.child({ context: 'Push' }),
    replan: replanDeps(f),
  };
}

const jobs: Step[] = [
  job({
    ...JOBS,
    name: 'Morning reminders (with the re-plan first)',
    kind: 'job',
    target: 'job reminders',
    // Today's claims gone, so each run claims and sends again.
    prepare: async (f) => {
      await f.build.reminders.pruneReminders(reminderDeps(f), day(f, 1));
      await f.build.replan.pruneReplans(replanDeps(f), day(f, 1));
    },
    run: async (f) => {
      const { morning } = f.build.pushSchedule.DEFAULT_REMINDER_TIMES;
      await f.build.reminders.sendDueReminders(
        reminderDeps(f),
        todayAt(f, Math.floor(morning / 60), morning % 60),
      );
    },
  }),
  job({
    ...JOBS,
    name: 'Evening reminders',
    kind: 'job',
    target: 'job reminders',
    prepare: (f) =>
      f.build.reminders.pruneReminders(reminderDeps(f), day(f, 1)),
    run: async (f) => {
      const { evening } = f.build.pushSchedule.DEFAULT_REMINDER_TIMES;
      await f.build.reminders.sendDueReminders(
        reminderDeps(f),
        todayAt(f, Math.floor(evening / 60), evening % 60),
      );
    },
  }),
  job({
    ...JOBS,
    name: 'Reminders, nothing due',
    kind: 'job',
    target: 'job reminders',
    run: async (f) => {
      await f.build.reminders.sendDueReminders(reminderDeps(f), todayAt(f, 3));
    },
  }),
  job({
    ...JOBS,
    name: 'Reminder claims prune',
    kind: 'job',
    target: 'job reminder_prune',
    run: (f) => f.build.reminders.pruneReminders(reminderDeps(f), day(f, -1)),
  }),
  job({
    ...JOBS,
    name: 'Week re-plan',
    kind: 'job',
    target: 'job replan',
    prepare: (f) => f.build.replan.pruneReplans(replanDeps(f), day(f, 1)),
    run: async (f) => {
      await f.build.replan.replanWeeks(
        replanDeps(f),
        todayAt(f, f.build.replan.REPLAN_HOUR + 1),
      );
    },
  }),
  job({
    ...JOBS,
    name: 'Week re-plan, already done today',
    kind: 'job',
    target: 'job replan',
    run: async (f) => {
      await f.build.replan.replanWeeks(
        replanDeps(f),
        todayAt(f, f.build.replan.REPLAN_HOUR + 1),
      );
    },
  }),
  job({
    ...JOBS,
    name: 'Re-plan claims prune',
    kind: 'job',
    target: 'job replan_prune',
    run: (f) => f.build.replan.pruneReplans(replanDeps(f), day(f, -1)),
  }),
  job({
    ...JOBS,
    name: 'Forecast refresh',
    kind: 'job',
    target: 'job weather refresh',
    run: async (f) => {
      await f.build.weather.refreshForecastsFor(
        {
          db: f.closet.db,
          weather: f.closet.weather!,
          logger: f.logger.child({ context: 'Weather' }),
        },
        [f.theo.id, f.ids.dana.id],
        new Date(),
      );
    },
  }),
  job({
    ...JOBS,
    name: 'Cutout of an uploaded photo',
    kind: 'job',
    target: 'job cutout',
    prepare: async (f) => {
      await f.send(
        {
          method: 'POST',
          url: `/wardrobe/${f.ids.otherGarmentId}/photo`,
          raw: await photoUpload(f),
        },
        303,
      );
    },
    run: (f) => f.withCutouts(() => f.closet.cutouts.whenIdle()),
  }),
  job({
    ...JOBS,
    name: 'Cutout retry (nightly)',
    kind: 'job',
    target: 'job cutout_retry',
    run: async (f) => {
      await f.build.cutoutQueue.retryFailedCutouts(
        f.closet.db,
        f.logger.child({ context: 'Cutout' }),
      );
    },
  }),
  job({
    ...JOBS,
    name: 'Storage reconciliation (nightly)',
    kind: 'job',
    target: 'job reconciliation',
    runs: 5,
    warmup: 1,
    run: async (f) => {
      await f.build.reconcile.reconcileStorage({
        db: f.closet.db,
        photos: f.closet.photos,
        logger: f.logger.child({ context: 'Reconciliation' }),
      });
    },
  }),
  job({
    ...JOBS,
    name: 'Order mail poll (one new order email)',
    kind: 'job',
    target: 'job order_mail',
    // The last run's products gone and a new email in the stand-in inbox,
    // so every run reads one email and lists its two products.
    prepare: async (f) => {
      const s = f.build.schema;
      await f.closet.db
        .delete(s.orderItem)
        .where(
          and(
            eq(s.orderItem.ownerId, f.theo.id),
            ne(s.orderItem.orderEmailId, f.orders.emailId),
          ),
        );
      f.orders.deliver();
    },
    run: async (f) => {
      const { orderMail } = f.closet;
      if (!orderMail) throw new Error('The order mail is off');
      await f.build.orderPoll.pollOrderMail(orderMail);
    },
  }),
  job({
    ...JOBS,
    name: 'Order mail poll, nothing new',
    kind: 'job',
    target: 'job order_mail',
    run: async (f) => {
      const { orderMail } = f.closet;
      if (!orderMail) throw new Error('The order mail is off');
      await f.build.orderPoll.pollOrderMail(orderMail);
    },
  }),
];

// --- helpers used by the steps above --------------------------------------

let names = 0;
/** A name no earlier run used (capsule and plan names are unique per owner). */
function unique(): number {
  names += 1;
  return names;
}

let clients = 0;
/** A fresh X-Forwarded-For (sign-in and registration are limited per address). */
function nextClient(): string {
  clients += 1;
  return `198.19.${Math.floor(clients / 250)}.${(clients % 250) + 1}`;
}

let subscriptions = 0;
function newSubscription() {
  subscriptions += 1;
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/page-audit-${subscriptions}`,
    keys: {
      p256dh: `B${'A'.repeat(86)}`,
      auth: 'A'.repeat(22),
    },
  };
}

let orderItems = 0;
/** A pending item on "From your orders", as the poll writes one; its id. */
async function newOrderItem(f: Fixture): Promise<number> {
  orderItems += 1;
  const s = f.build.schema;
  const [row] = await f.closet.db
    .insert(s.orderItem)
    .values({
      ownerId: f.theo.id,
      orderEmailId: f.orders.emailId,
      productUrl: f.productUrl.replace(
        '/products/tee',
        `/products/dismissed-${orderItems}`,
      ),
      name: `Dismissed tee ${orderItems}`,
      price: '20.00',
      currency: 'USD',
      orderedOn: f.today(),
    })
    .returning({ id: s.orderItem.id });
  return row.id;
}

function newestPlanItem(f: Fixture): Promise<number> {
  const s = f.build.schema;
  return newestId(
    f.closet.db
      .select({ id: s.planItem.id })
      .from(s.planItem)
      .where(eq(s.planItem.planId, f.ids.planId))
      .orderBy(desc(s.planItem.id))
      .limit(1),
    'plan item',
  );
}

/** An MCP proposal: the one way an item is `proposed` (accept's input). */
function proposeItem(f: Fixture): AuditRequest {
  return {
    method: 'POST',
    url: '/mcp',
    as: null,
    sameOrigin: false,
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${f.mcpTokens[0]}`,
    },
    json: {
      jsonrpc: '2.0',
      id: ++mcpCall,
      method: 'tools/call',
      params: {
        name: 'propose_plan_item',
        arguments: {
          planId: f.ids.planId,
          category: 'tops',
          name: 'Proposed by the audit',
        },
      },
    },
  };
}

/**
 * The walk, in order: reads over the seed as it is (in rounds: they change
 * nothing another step reads), then the writes, the MCP tools and the jobs,
 * one step after another. The cutout job comes after every upload, so the
 * queue's first run takes their backlog in its warm-up.
 */
export const AUDIT_PHASES: readonly Phase[] = [
  { name: 'reads', interleave: true, steps: pages },
  { name: 'writes', interleave: false, steps: writes },
  { name: 'MCP tools', interleave: false, steps: tools },
  { name: 'jobs', interleave: false, steps: jobs },
];
