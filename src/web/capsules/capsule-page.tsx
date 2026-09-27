import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, EmptyState, SavedToast, StripFlags } from '../layout/parts';
import type { ViewContext } from '../view-context';
import type { GridPage } from '../wardrobe/queries';
import { capsuleUrl, wardrobeUrl } from '../wardrobe/urls';
import { EMPTY_SEARCH, GarmentTiles } from '../wardrobe/wardrobe-page';
import { garmentCount } from './list-page';
import type { CapsuleDetail } from './queries';

export interface CapsulePageModel {
  capsule: CapsuleDetail;
  /** The first page of its members in the closet (inCloset), newest first. */
  page: GridPage;
  count: number;
  /** The shared wardrobe it is in; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** Choose garments (the picker): the owner and a MANAGE grantee. */
  canEdit: boolean;
  /** Edit, delete and Build an outfit (outfits are the owner's own): the owner only. */
  isOwner: boolean;
  /** One-shot flags: after a create, after the picker saved. */
  created: boolean;
  saved?: { added: number; removed: number };
}

/** The capsule page's one-shot flags (CapsulePageQuery). */
const CAPSULE_PAGE_FLAGS = ['created', 'added', 'removed'] as const;

/**
 * GET /capsules/:id: the capsule's garments as the wardrobe grid shows them
 * (the same tiles and keyset pages: the sentinel asks /wardrobe/tiles with
 * `capsule`), archived members left out; what the requester may do with
 * it; and where it leads: the grid filtered to it, the picker, and the
 * outfit builder cycling only its garments.
 */
export function CapsulePage(props: {
  ctx: ViewContext;
  model: CapsulePageModel;
}) {
  const { ctx, model } = props;
  const { capsule, viewOwner } = model;
  const search = { ...EMPTY_SEARCH, capsule: String(capsule.id) };
  return (
    <Layout ctx={ctx} title={capsule.name}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24">
        <div class="flex items-center gap-3 mb-2 px-2">
          <BackLink href={capsuleUrl(undefined, viewOwner)} />
          <h1 class="text-2xl font-bold flex-1">{capsule.name}</h1>
          {model.isOwner && (
            <a
              href={capsuleUrl(capsule.id, viewOwner, '/edit')}
              class="btn btn-ghost btn-sm"
            >
              {t('EDIT_CAPSULE')}
            </a>
          )}
        </div>
        {capsule.notes && (
          <p class="text-sm whitespace-pre-line text-base-content/70 mb-2 px-2">
            {capsule.notes}
          </p>
        )}
        <p class="text-sm text-base-content/60 mb-4 px-2">
          {garmentCount(model.count)}
        </p>
        <CapsuleActions model={model} />
        {model.page.tiles.length === 0 ? (
          <EmptyState message={t('CAPSULE_EMPTY')}>
            {model.canEdit && (
              <a href={pickerUrl(model)} class="btn btn-primary btn-sm">
                {t('CHOOSE_GARMENTS')}
              </a>
            )}
          </EmptyState>
        ) : (
          <div id="capsule-grid" class="flex flex-wrap gap-4 justify-center">
            <GarmentTiles
              page={model.page}
              search={search}
              viewOwner={viewOwner}
              selecting={false}
              firstPage
            />
          </div>
        )}
      </main>
      {model.created && (
        <SavedToast id="capsule-created-toast" text={t('CAPSULE_CREATED')} />
      )}
      {model.saved && (
        <SavedToast
          id="capsule-saved-toast"
          text={t('CAPSULE_MEMBERS_SAVED', model.saved)}
        />
      )}
      <StripFlags names={CAPSULE_PAGE_FLAGS} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

function pickerUrl({ capsule, viewOwner }: CapsulePageModel): string {
  return wardrobeUrl(viewOwner, { pick: capsule.id });
}

/**
 * Where the capsule leads, for whoever may go there: the picker (owner and
 * MANAGE), the grid filtered to it, and the outfit builder (the owner's
 * own outfits only).
 */
function CapsuleActions({ model }: { model: CapsulePageModel }) {
  const { capsule, viewOwner } = model;
  return (
    <div class="flex flex-wrap gap-2 mb-6 px-2">
      {model.canEdit && (
        <a href={pickerUrl(model)} class="btn btn-primary btn-sm">
          {t('CHOOSE_GARMENTS')}
        </a>
      )}
      {model.count > 0 && (
        <a
          href={wardrobeUrl(viewOwner, { capsule: capsule.id })}
          class="btn btn-outline btn-sm"
        >
          {t('FILTER_WARDROBE_BY_CAPSULE')}
        </a>
      )}
      {model.isOwner && model.count > 0 && (
        <a
          href={`/outfits/new?capsule=${capsule.id}`}
          class="btn btn-outline btn-sm"
        >
          {t('BUILD_OUTFIT_FROM_CAPSULE')}
        </a>
      )}
      {/* The outfit gallery (#9) adds "Swipe outfits" here, into
          /gallery?capsule=<id>; its pool filters through inCapsule
          (src/web/capsules/queries.ts). */}
    </div>
  );
}
