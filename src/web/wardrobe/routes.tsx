import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import type { FieldErrors } from '../auth/validation';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import {
  navigateTo,
  renderFragment,
  renderPage,
  wantsFragment,
} from '../render';
import {
  resolveWardrobeAccess,
  sharedWardrobesOf,
  type WardrobeAccess,
} from '../sharing/access';
import { viewContext } from '../view-context';
import {
  categoryLabel,
  categorySuggestions,
  normalizeCategory,
  normalizeSize,
  splitColors,
} from './garment';
import { type GarmentFormMode, GarmentFormPage } from './garment-form';
import { GarmentPage } from './garment-page';
import {
  filterOptions,
  findGarment,
  type GarmentDetail,
  gridCount,
  type GridFilters,
  gridPage,
  toggleArchived,
  updateGarmentFields,
} from './queries';
import { garmentUrl, wardrobeUrl } from './urls';
import {
  GarmentBody,
  type GarmentField,
  type GarmentFormValues,
  GarmentPageQuery,
  GarmentParams,
  GridQuery,
  OwnerQuery,
  readGarmentForm,
  TilesQuery,
} from './validation';
import {
  GarmentTiles,
  type GridSearch,
  WardrobeMain,
  WardrobePage,
} from './wardrobe-page';
import {
  cloneGarment,
  createGarment,
  removeGarment,
  replacePhoto,
  type WardrobeDeps,
} from './writes';

/**
 * Who may do what (WardrobeAccess, src/web/sharing/access.ts): a wardrobe
 * the requester cannot see is a 404 like an unknown id, and so is a garment
 * outside the wardrobe the request addresses; one they can see but not
 * change is a 403. Reads need a view, writes a MANAGE share (or ownership),
 * archive and delete ownership, and a clone only a view: it lands in the
 * requester's own wardrobe and only reads the source.
 */
type Need = 'view' | 'manage' | 'own';

interface Resolved {
  access: WardrobeAccess;
  /** The shared wardrobe addressed, for links; undefined for one's own. */
  viewOwner: number | undefined;
}

async function resolve(
  { db }: WebOptions,
  request: FastifyRequest,
  ownerId: number | '' | undefined,
  need: Need,
): Promise<Resolved> {
  const access = await resolveWardrobeAccess(
    db,
    sessionUserId(request),
    ownerId || undefined,
  );
  if (!access.canView) throw notFound();
  if (need === 'manage' && !access.canManage) throw new HttpError(403);
  if (need === 'own' && !access.isOwner) throw new HttpError(403);
  // `?ownerId=<self>` is the own wardrobe (nobody shares with themselves),
  // and its links must not carry the parameter.
  return { access, viewOwner: access.isOwner ? undefined : access.ownerId };
}

function notFound(): HttpError {
  return new HttpError(404, 'Garment not found');
}

async function requireGarment(
  options: WebOptions,
  id: number,
  ownerId: number,
): Promise<GarmentDetail> {
  const garment = await findGarment(options.db, id, ownerId);
  if (!garment) throw notFound();
  return garment;
}

function gridSearch(query: GridQuery): GridSearch {
  return {
    keyword: query.keyword?.trim() ?? '',
    category: query.category ? normalizeCategory(query.category) : '',
    color: query.color ?? '',
    size: (query.size && normalizeSize(query.size)) || '',
    archived: query.archived === 'true' ? 'true' : '',
  };
}

function gridFilters(search: GridSearch): GridFilters {
  return {
    keyword: search.keyword || undefined,
    category: search.category || undefined,
    color: search.color || undefined,
    size: search.size || undefined,
    archived: search.archived === 'true',
  };
}

function storedValues(garment: GarmentDetail): GarmentFormValues {
  return {
    name: garment.name ?? '',
    category: garment.category,
    brand: garment.brand ?? '',
    colors: splitColors(garment.color),
    size: garment.size ?? '',
    washingDetails: garment.washingDetails ?? '',
    dateAquired: garment.acquiredOn ?? '',
    notes: garment.notes ?? '',
  };
}

/**
 * /wardrobe: the grid (with its fragment and its "load more" pages), the
 * garment page, the new/edit/clone forms and their posts, the photo and
 * cutout uploads, archive and delete. Every route takes `?ownerId=` for a
 * shared wardrobe (see resolve above).
 */
export const wardrobeRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;
  const deps: WardrobeDeps = { db, photos: options.photos, logger };

  /** The form again, with the posted values and what is wrong with them. */
  async function refuseForm(
    reply: FastifyReply,
    mode: GarmentFormMode,
    suggestionsFrom: number,
    viewOwner: number | undefined,
    values: GarmentFormValues,
    errors: FieldErrors<GarmentField>,
  ): Promise<FastifyReply> {
    logger.warn(
      `Garment form refused (${mode.kind}): ${Object.keys(errors).join(', ')}`,
    );
    return renderForm(reply, mode, suggestionsFrom, viewOwner, values, {
      errors,
      status: 400,
    });
  }

  async function renderForm(
    reply: FastifyReply,
    mode: GarmentFormMode,
    suggestionsFrom: number,
    viewOwner: number | undefined,
    values: GarmentFormValues,
    refusal: { errors: FieldErrors<GarmentField>; status: number } = {
      errors: {},
      status: 200,
    },
  ): Promise<FastifyReply> {
    const { categories } = await filterOptions(db, suggestionsFrom);
    return renderPage(
      reply,
      <GarmentFormPage
        ctx={viewContext(reply)}
        model={{
          mode,
          values,
          viewOwner,
          errors: refusal.errors,
          categories: categorySuggestions(categories).map((value) => ({
            value,
            label: categoryLabel(value),
          })),
        }}
      />,
      { status: refusal.status },
    );
  }

  // Filtering and searching are navigation state: malformed values fall
  // back or are dropped, except a colour outside the built-in set (400,
  // GridQuery). An htmx fragment request (the filter bar, the search form)
  // gets #wardrobe-main alone; the first page only, always.
  app.get(
    '/wardrobe',
    { schema: { querystring: GridQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const search = gridSearch(request.query);
      const filters = gridFilters(search);
      const [page, count, filterValues, sharedWardrobes] = await Promise.all([
        gridPage(db, access.ownerId, filters),
        gridCount(db, access.ownerId, filters),
        filterOptions(db, access.ownerId),
        sharedWardrobesOf(db, userId),
      ]);
      const model = {
        search,
        page,
        count,
        options: filterValues,
        sharedWardrobes,
        viewOwner,
        canEdit: access.canManage,
      };
      if (wantsFragment(request, reply)) {
        return renderFragment(reply, <WardrobeMain model={model} />);
      }
      return renderPage(
        reply,
        <WardrobePage ctx={viewContext(reply)} model={model} />,
      );
    },
  );

  // The grid's "load more" sentinel (hx-trigger="revealed"): the page after
  // `before`, with the same filters, and the next sentinel. Always a fragment.
  app.get(
    '/wardrobe/tiles',
    { schema: { querystring: TilesQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const search = gridSearch(request.query);
      const page = await gridPage(
        db,
        access.ownerId,
        gridFilters(search),
        request.query.before,
      );
      return renderFragment(
        reply,
        <GarmentTiles page={page} search={search} viewOwner={viewOwner} />,
      );
    },
  );

  app.get(
    '/wardrobe/new',
    { schema: { querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      return renderForm(reply, { kind: 'new' }, access.ownerId, viewOwner, {
        name: '',
        category: '',
        brand: '',
        colors: [],
        size: '',
        washingDetails: '',
        dateAquired: '',
        notes: '',
      });
    },
  );

  app.post(
    '/wardrobe',
    { schema: { querystring: OwnerQuery, body: GarmentBody } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const form = readGarmentForm(request.body);
      if (!form.ok) {
        return refuseForm(
          reply,
          { kind: 'new' },
          access.ownerId,
          viewOwner,
          form.values,
          form.errors,
        );
      }
      const id = await createGarment(deps, access.ownerId, form.fields);
      logger.info(
        `Garment ${id} created by user ${sessionUserId(request)} in wardrobe ${access.ownerId}`,
      );
      return reply.redirect(garmentUrl(id, viewOwner, '', { created: 1 }), 302);
    },
  );

  app.get(
    '/wardrobe/:id',
    { schema: { params: GarmentParams, querystring: GarmentPageQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const garment = await requireGarment(
        options,
        request.params.id,
        access.ownerId,
      );
      return renderPage(
        reply,
        <GarmentPage
          ctx={viewContext(reply)}
          model={{
            garment,
            viewOwner,
            canEdit: access.canManage,
            canDelete: access.isOwner,
            justCreated: request.query.created === '1',
            justSavedPhoto: request.query.photoSaved === '1',
          }}
        />,
      );
    },
  );

  app.get(
    '/wardrobe/:id/edit',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const garment = await requireGarment(
        options,
        request.params.id,
        access.ownerId,
      );
      return renderForm(
        reply,
        { kind: 'edit', garmentId: garment.id },
        access.ownerId,
        viewOwner,
        storedValues(garment),
      );
    },
  );

  // Every field is posted: the stored garment becomes what the form says
  // (a cleared field is null). A malformed or refused form writes nothing.
  app.post(
    '/wardrobe/:id',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: GarmentBody,
      },
    },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      await requireGarment(options, id, access.ownerId);
      const form = readGarmentForm(request.body);
      if (!form.ok) {
        return refuseForm(
          reply,
          { kind: 'edit', garmentId: id },
          access.ownerId,
          viewOwner,
          form.values,
          form.errors,
        );
      }
      if (!(await updateGarmentFields(db, id, access.ownerId, form.fields))) {
        throw notFound();
      }
      logger.info(`Garment ${id} updated by user ${sessionUserId(request)}`);
      return reply.redirect(garmentUrl(id, viewOwner), 302);
    },
  );

  // The clone form, prefilled from the source; it posts to the route below.
  // Suggestions come from the requester's own wardrobe, where it will land.
  app.get(
    '/wardrobe/:id/clone',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const source = await requireGarment(
        options,
        request.params.id,
        access.ownerId,
      );
      const values = storedValues(source);
      return renderForm(
        reply,
        { kind: 'clone', garmentId: source.id },
        sessionUserId(request),
        viewOwner,
        {
          ...values,
          name: source.name ? t('CLONE_NAME', { name: source.name }) : '',
        },
      );
    },
  );

  app.post(
    '/wardrobe/:id/clone',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: GarmentBody,
      },
    },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'view',
      );
      const source = await requireGarment(
        options,
        request.params.id,
        access.ownerId,
      );
      const form = readGarmentForm(request.body);
      if (!form.ok) {
        return refuseForm(
          reply,
          { kind: 'clone', garmentId: source.id },
          userId,
          viewOwner,
          form.values,
          form.errors,
        );
      }
      const id = await cloneGarment(deps, source, userId, form.fields);
      logger.info(`Garment ${id} cloned from ${source.id} by user ${userId}`);
      return reply.redirect(garmentUrl(id, undefined), 302);
    },
  );

  // htmx (hx-post, multipart): the photo and, when the browser made one, its
  // cutout. The garment is checked before the body is read, so a refused
  // upload stores nothing.
  app.post(
    '/wardrobe/:id/photo',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      await requireGarment(options, id, access.ownerId);
      await replacePhoto(
        deps,
        id,
        access.ownerId,
        request.files({ limits: { files: 2 } }),
      );
      return reply
        .header('HX-Redirect', garmentUrl(id, viewOwner, '', { photoSaved: 1 }))
        .status(200)
        .send();
    },
  );

  // The mask editor's fetch (public/js/background-removal.js): the edited
  // cutout replaces the stored one; the answer is the photo's new version,
  // so the page can point at the new immutable URL.
  app.post(
    '/wardrobe/:id/nobg',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access } = await resolve(
        options,
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      const garment = await requireGarment(options, id, access.ownerId);
      if (!garment.photo) throw new HttpError(400, 'Garment has no photo');
      const part = await request.file();
      if (!part) throw new HttpError(400, 'No file uploaded');
      const version = await options.photos.storeCutout(
        part.file,
        garment.photo.fileName,
        { newUpload: false },
      );
      logger.info(`Garment ${id} cutout replaced, photo version ${version}`);
      return reply.send({ version });
    },
  );

  // htmx (hx-post): owner only, even for a MANAGE grantee.
  app.post(
    '/wardrobe/:id/archive',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        options,
        request,
        request.query.ownerId,
        'own',
      );
      const { id } = request.params;
      const archived = await toggleArchived(db, id, access.ownerId);
      if (archived === undefined) throw notFound();
      logger.info(
        `Garment ${id} ${archived ? 'archived' : 'unarchived'} by user ${access.ownerId}`,
      );
      return navigateTo(reply, wardrobeUrl(viewOwner));
    },
  );

  // htmx (hx-delete): owner only. The photo's bytes go after the rows commit.
  app.delete(
    '/wardrobe/:id',
    { schema: { params: GarmentParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access } = await resolve(
        options,
        request,
        request.query.ownerId,
        'own',
      );
      const { id } = request.params;
      if (!(await removeGarment(deps, id, access.ownerId))) throw notFound();
      logger.info(`Garment ${id} deleted by user ${access.ownerId}`);
      return navigateTo(reply, '/wardrobe');
    },
  );

  done();
};
