import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { selectScalars } from '../../db/select-scalars';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { navigateTo, renderFragment, renderPage } from '../render';
import {
  type AuthorizedWardrobe,
  authorizeWardrobe,
  sharedWardrobesSql,
  toSharedWardrobe,
  type WardrobeNeed,
} from '../sharing/access';
import { viewContext } from '../view-context';
import {
  CLOSET_FILTERS,
  findGarment,
  gridCount,
  gridPage,
} from '../wardrobe/queries';
import { capsuleUrl } from '../wardrobe/urls';
import { GarmentParams, OwnerQuery } from '../wardrobe/validation';
import { CapsulePage } from './capsule-page';
import { CapsuleFormPage, type CapsuleFormModel } from './form-page';
import { CapsulesPage } from './list-page';
import {
  type CapsuleDetail,
  capsuleListSql,
  changeMembership,
  createCapsule,
  deleteCapsule,
  findCapsule,
  readCapsuleList,
  updateCapsule,
} from './queries';
import {
  CAPSULE_NOT_FOUND,
  CapsuleBody,
  capsuleNotFound,
  CapsulePageQuery,
  type CapsuleForm,
  CapsuleParams,
  GarmentCapsulesBody,
  MembersBody,
  nameTaken,
  readCapsuleForm,
  unchecked,
} from './validation';

/**
 * /capsules (plan section 2; owner decision on #8): capsules are part of
 * the wardrobe, so every route takes `?ownerId=` and resolves it through
 * authorizeWardrobe like the garment routes. A VIEW grantee lists and opens
 * the grantor's capsules (and filters the grid by one), a MANAGE grantee
 * also changes their membership (the picker, the garment page's toggles),
 * and only the owner creates, renames and deletes them. A capsule outside
 * the addressed wardrobe is a 404 like an unknown id; one the requester
 * can see but not change is a 403.
 */
export const capsuleRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;

  function resolve(
    request: FastifyRequest,
    ownerId: number | '' | undefined,
    need: WardrobeNeed,
  ): Promise<AuthorizedWardrobe> {
    return authorizeWardrobe(db, request, ownerId, need, CAPSULE_NOT_FOUND);
  }

  async function requireCapsule(
    id: number,
    ownerId: number,
  ): Promise<CapsuleDetail> {
    const capsule = await findCapsule(db, id, ownerId);
    if (!capsule) throw capsuleNotFound();
    return capsule;
  }

  function renderForm(
    reply: FastifyReply,
    model: CapsuleFormModel,
    status = 200,
  ): Promise<FastifyReply> {
    return renderPage(
      reply,
      <CapsuleFormPage ctx={viewContext(reply)} model={model} />,
      { status },
    );
  }

  /**
   * The form again with what is wrong (a blank name, one the owner already
   * uses): a 400 re-render, which is why the form is a native post.
   */
  function refuseForm(
    reply: FastifyReply,
    refused: CapsuleForm & { ok: false },
    capsuleId?: number,
  ): Promise<FastifyReply> {
    logger.warn(
      `Capsule form refused (${capsuleId === undefined ? 'new' : `capsule ${capsuleId}`}): ${refused.errors.name?.join(' ')}`,
    );
    return renderForm(
      reply,
      {
        capsuleId,
        values: {
          name: refused.values.name,
          notes: refused.values.notes ?? '',
        },
        errors: refused.errors,
      },
      400,
    );
  }

  app.get(
    '/capsules',
    { schema: { querystring: OwnerQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        request,
        request.query.ownerId,
        'view',
      );
      // The cards and the switcher: one statement (#170; it was four).
      const row = await selectScalars(db, {
        ...capsuleListSql(access.ownerId),
        sharedWardrobes: sharedWardrobesSql(sessionUserId(request)),
      });
      return renderPage(
        reply,
        <CapsulesPage
          ctx={viewContext(reply)}
          model={{
            ...readCapsuleList(row),
            viewOwner,
            sharedWardrobes: row.sharedWardrobes.map(toSharedWardrobe),
            canEdit: access.canManage,
            isOwner: access.isOwner,
          }}
        />,
      );
    },
  );

  app.get(
    '/capsules/new',
    { schema: { querystring: OwnerQuery } },
    async (request, reply) => {
      await resolve(request, request.query.ownerId, 'own');
      return renderForm(reply, { values: { name: '', notes: '' } });
    },
  );

  app.post(
    '/capsules',
    { schema: { querystring: OwnerQuery, body: CapsuleBody } },
    async (request, reply) => {
      const { access } = await resolve(request, request.query.ownerId, 'own');
      const form = readCapsuleForm(request.body);
      if (!form.ok) return refuseForm(reply, form);
      const id = await createCapsule(db, access.ownerId, form.fields);
      if (id === 'name-taken') {
        return refuseForm(reply, nameTaken(request.body));
      }
      logger.info(`Capsule ${id} created by user ${access.ownerId}`);
      return reply.redirect(capsuleUrl(id, undefined, '', { created: 1 }), 303);
    },
  );

  app.get(
    '/capsules/:id',
    { schema: { params: CapsuleParams, querystring: CapsulePageQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        request,
        request.query.ownerId,
        'view',
      );
      // All three at once (one round trip, not two): the members' reads
      // need no lookup first, since inCapsule matches nothing outside the
      // capsule's own wardrobe, and a capsule not found is a 404 whatever
      // they read.
      const filters = { ...CLOSET_FILTERS, capsule: request.params.id };
      const [capsule, page, count] = await Promise.all([
        requireCapsule(request.params.id, access.ownerId),
        gridPage(db, access.ownerId, filters, { ownerView: access.isOwner }),
        gridCount(db, access.ownerId, filters),
      ]);
      const { created, added, removed } = request.query;
      return renderPage(
        reply,
        <CapsulePage
          ctx={viewContext(reply)}
          model={{
            capsule,
            page,
            count,
            viewOwner,
            canEdit: access.canManage,
            isOwner: access.isOwner,
            created: created === '1',
            saved:
              added === undefined && removed === undefined
                ? undefined
                : { added: added ?? 0, removed: removed ?? 0 },
          }}
        />,
      );
    },
  );

  app.get(
    '/capsules/:id/edit',
    { schema: { params: CapsuleParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access } = await resolve(request, request.query.ownerId, 'own');
      const capsule = await requireCapsule(request.params.id, access.ownerId);
      return renderForm(reply, {
        capsuleId: capsule.id,
        values: { name: capsule.name, notes: capsule.notes ?? '' },
      });
    },
  );

  // Rename (and notes). A refused form writes nothing and re-renders (400).
  app.post(
    '/capsules/:id',
    {
      schema: {
        params: CapsuleParams,
        querystring: OwnerQuery,
        body: CapsuleBody,
      },
    },
    async (request, reply) => {
      const { access } = await resolve(request, request.query.ownerId, 'own');
      const { id } = request.params;
      await requireCapsule(id, access.ownerId);
      const form = readCapsuleForm(request.body);
      if (!form.ok) return refuseForm(reply, form, id);
      const saved = await updateCapsule(db, id, access.ownerId, form.fields);
      if (saved === 'not-found') throw capsuleNotFound();
      if (saved === 'name-taken') {
        return refuseForm(reply, nameTaken(request.body), id);
      }
      logger.info(`Capsule ${id} updated by user ${access.ownerId}`);
      return reply.redirect(capsuleUrl(id, undefined), 303);
    },
  );

  // htmx (hx-delete, hx-confirm): owner only. The garments stay.
  app.delete(
    '/capsules/:id',
    { schema: { params: CapsuleParams, querystring: OwnerQuery } },
    async (request, reply) => {
      const { access } = await resolve(request, request.query.ownerId, 'own');
      const { id } = request.params;
      if (!(await deleteCapsule(db, id, access.ownerId))) {
        throw capsuleNotFound();
      }
      logger.info(`Capsule ${id} deleted by user ${access.ownerId}`);
      return navigateTo(reply, '/capsules');
    },
  );

  // The picker's Save (a native post from the grid in `?pick=` mode): the
  // tiles it showed become members exactly when checked; members it never
  // showed are left alone. Ids outside the wardrobe are dropped. Back to
  // the capsule with a toast saying what changed.
  app.post(
    '/capsules/:id/garments',
    {
      schema: {
        params: CapsuleParams,
        querystring: OwnerQuery,
        body: MembersBody,
      },
    },
    async (request, reply) => {
      const { access, viewOwner } = await resolve(
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      await requireCapsule(id, access.ownerId);
      const { ids, shown } = request.body ?? {};
      const result = await changeMembership(db, access.ownerId, {
        add: { capsuleIds: [id], garmentIds: ids ?? [] },
        remove: { capsuleIds: [id], garmentIds: unchecked(shown, ids) },
      });
      logger.info(
        `Capsule ${id} garments chosen by user ${sessionUserId(request)} in wardrobe ${access.ownerId}: ${result.added} added, ${result.removed} removed, ${shown?.length ?? 0} shown`,
      );
      return reply.redirect(capsuleUrl(id, viewOwner, '', result), 303);
    },
  );

  // The garment page's capsules row toggles (an AutosaveForm, on every
  // change): the capsules the section listed hold the garment exactly when
  // checked. The answer is the form's status line, never the toggles (see
  // src/web/autosave.tsx).
  app.post(
    '/wardrobe/:id/capsules',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: GarmentCapsulesBody,
      },
    },
    async (request, reply) => {
      const { access } = await resolve(
        request,
        request.query.ownerId,
        'manage',
      );
      const { id } = request.params;
      if (!(await findGarment(db, id, access.ownerId))) {
        throw new HttpError(404, 'Garment not found');
      }
      const { capsuleIds, shown } = request.body ?? {};
      const result = await changeMembership(db, access.ownerId, {
        add: { capsuleIds: capsuleIds ?? [], garmentIds: [id] },
        remove: { capsuleIds: unchecked(shown, capsuleIds), garmentIds: [id] },
      });
      logger.info(
        `Garment ${id} capsules set by user ${sessionUserId(request)} in wardrobe ${access.ownerId}: ${result.added} added, ${result.removed} removed`,
      );
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  done();
};
