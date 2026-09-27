import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EmptyState, GarmentThumb } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import {
  destinationParams,
  garmentUrl,
  LINK_IMPORT_PATH,
  wardrobeUrl,
} from '../wardrobe/urls';
import { WardrobeTabs } from '../wardrobe/wardrobe-tabs';
import type { Candidacy } from '../plans/candidates';
import { CandidacyLinks } from '../plans/candidates-page';
import { SHOPPING_PATH } from '../plans/urls';
import type { WishlistItem } from './queries';

export interface WishlistModel {
  items: WishlistItem[];
  /** The shared wardrobe shown; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** Add and "Bought it": the owner and a MANAGE grantee (a VIEW grantee reads). */
  canEdit: boolean;
  /**
   * The plan items each item is a candidate for (34b), by garment id: the
   * owner's own wishlist only. Undefined on a shared one: plans are private.
   */
  candidacies: Map<number, Candidacy[]> | undefined;
}

const TO_WISHLIST = destinationParams({ to: 'wishlist' });

/**
 * GET /wardrobe/wishlist: the Wardrobe's Wishlist tab. What the household is
 * thinking of buying, newest first: each item's photo, name, price, product
 * link and the garment it would replace, and "Bought it". Cards use the
 * stretched-link pattern: the name's link covers the card, the product
 * link and "Bought it" sit above it (relative z-10). On the owner's own
 * wishlist each card also says which plan items it is a candidate for
 * (34b), with "For plan item…", and the header links the shopping list.
 */
export function WishlistPage(props: {
  ctx: ViewContext;
  model: WishlistModel;
}) {
  const { ctx, model } = props;
  const { viewOwner, canEdit } = model;
  return (
    <Layout ctx={ctx} title={t('wishlist.TITLE')}>
      <AppBar ctx={ctx} title={t('WARDROBE')} />
      <main class="p-4 pt-20 pb-24">
        <WardrobeTabs active="wishlist" viewOwner={viewOwner} />
        {/* Two labelled buttons: wider than the app bar's actions have room
            for on a phone (R3's add sheet takes them into the bar). */}
        {canEdit && model.items.length > 0 && (
          <div class="max-w-lg mx-auto mb-3 px-2 flex justify-end">
            <AddButtons viewOwner={viewOwner} />
          </div>
        )}
        {model.candidacies && (
          <div class="max-w-lg mx-auto mb-3 px-2 flex justify-end">
            <a href={SHOPPING_PATH} class="link link-primary text-sm">
              {t('shopping.TITLE')}
            </a>
          </div>
        )}
        {model.items.length === 0 ? (
          <EmptyState
            message={t(canEdit ? 'wishlist.EMPTY' : 'wishlist.EMPTY_SHARED')}
          >
            {canEdit && <AddButtons viewOwner={viewOwner} />}
          </EmptyState>
        ) : (
          <ul class="flex flex-col gap-3 max-w-lg mx-auto" id="wishlist">
            {model.items.map((item) => (
              <WishlistCard item={item} model={model} />
            ))}
          </ul>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** Add by hand, or from a product link; both land on the wishlist. */
function AddButtons({ viewOwner }: { viewOwner: number | undefined }) {
  return (
    <div class="flex gap-2">
      <a
        href={wardrobeUrl(viewOwner, TO_WISHLIST, LINK_IMPORT_PATH)}
        class="btn btn-outline btn-sm"
      >
        {t('wishlist.ADD_FROM_LINK')}
      </a>
      <a
        href={wardrobeUrl(viewOwner, TO_WISHLIST, '/wardrobe/new')}
        class="btn btn-primary btn-sm"
      >
        + {t('wishlist.ADD')}
      </a>
    </div>
  );
}

function WishlistCard(props: { item: WishlistItem; model: WishlistModel }) {
  const { item, model } = props;
  const { viewOwner } = model;
  const name = item.name ?? categoryLabel(item.category);
  return (
    <li class="card card-side bg-base-100 shadow-sm relative">
      <GarmentThumb garment={item} class="rounded-l-box shrink-0" />
      <div class="card-body p-3 gap-1 min-w-0">
        <a
          href={garmentUrl(item.id, viewOwner)}
          class="card-title text-sm after:absolute after:inset-0"
        >
          {name}
        </a>
        <p class="text-xs text-base-content/60 truncate">
          {[item.brand, categoryLabel(item.category)]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {item.replaces && (
          <p class="text-xs">
            {t('wishlist.REPLACES', {
              name: item.replaces.name ?? categoryLabel(item.replaces.category),
            })}
          </p>
        )}
        {model.candidacies && (
          <CandidacyLinks
            garmentId={item.id}
            candidacies={model.candidacies.get(item.id) ?? []}
          />
        )}
        <div class="flex flex-wrap items-center gap-2 mt-1">
          {item.price && (
            <span class="font-medium text-sm">{priceLabel(item.price)}</span>
          )}
          {item.sourceUrl && (
            // http(s) only (readSourceUrl and the column's check); a new tab,
            // as on the garment page.
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="link link-primary text-xs relative z-10"
            >
              {t('VIEW_PRODUCT')}
            </a>
          )}
          {model.canEdit && (
            <a
              href={garmentUrl(item.id, viewOwner, '/bought')}
              class="btn btn-sm btn-primary btn-outline ml-auto relative z-10"
            >
              {t('wishlist.BOUGHT_IT')}
            </a>
          )}
        </div>
      </div>
    </li>
  );
}
