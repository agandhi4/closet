import type { Child } from 'hono/jsx';
import {
  CONDITIONS,
  FITS,
  FORMALITIES,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  SLEEVES,
  typesOf,
  WARMTHS,
} from '../../wardrobe/properties';
import { PostForm } from '../auth/form';
import { imageUrl } from '../files/image-url';
import { type StringKey, t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import {
  EmptyState,
  HangerIcon,
  SavedToast,
  StripFlags,
} from '../layout/parts';
import type { CapsuleRef } from '../capsules/queries';
import type { SharedWardrobe } from '../sharing/access';
import type { ViewContext } from '../view-context';
import { WeatherSlot } from '../weather/views';
import { categoryLabel, GARMENT_COLORS } from './garment';
import type { FilterOptions, GarmentTile, GridPage } from './queries';
import { type LabelledProperty, valueLabel } from './labels';
import { capsuleUrl, garmentUrl, wardrobeUrl } from './urls';
import { BULK_PROPERTIES, type BulkProperty } from './validation';
import { WardrobeTabs } from './wardrobe-tabs';

/**
 * The grid's filters as the page echoes them into its links and forms. The
 * keys are the query parameters' names ('' for not set).
 */
export interface GridSearch {
  keyword: string;
  category: string;
  color: string;
  size: string;
  /** A type of `category`; '' without one. */
  type: string;
  warmth: string;
  formality: string;
  material: string;
  /** 'true' when archived garments are shown too; '' otherwise. */
  archived: string;
  /** A capsule's id: its members only. */
  capsule: string;
  /** 'true': a copy needs a wash (the owner's own wardrobe only). */
  needsWash: string;
  /** 'true': condition not good. */
  attention: string;
}

/** No filter at all: the whole closet (the capsule page spreads it with its id). */
export const EMPTY_SEARCH: GridSearch = {
  keyword: '',
  category: '',
  color: '',
  size: '',
  type: '',
  warmth: '',
  formality: '',
  material: '',
  archived: '',
  capsule: '',
  needsWash: '',
  attention: '',
};

/**
 * The capsule picker (`?pick=`): select mode whose checkboxes are the
 * capsule's membership. Members start checked, and every tile says it was
 * shown (a hidden `shown`), so the post changes only what the picker
 * showed (POST /capsules/:id/garments).
 */
export interface Picking {
  capsuleId: number;
  members: ReadonlySet<number>;
}

export interface WardrobeModel {
  search: GridSearch;
  page: GridPage;
  /** Garments matching the filters, all pages together. */
  count: number;
  options: FilterOptions;
  sharedWardrobes: SharedWardrobe[];
  /** The shared wardrobe shown; undefined for the requester's own. */
  viewOwner: number | undefined;
  canEdit: boolean;
  /** The requester's own wardrobe: wash state and away show (never a share's). */
  ownerView: boolean;
  /** Garments still needing their type, warmth or formality (0 for a viewer). */
  toTag: number;
  /** Garments with a copy that needs a wash (0 on a shared wardrobe). */
  toWash: number;
  /** Select mode (?select=1, or the picker): tiles are checkboxes. */
  selecting: boolean;
  /** Select mode as the capsule picker; the capsule's name for the heading. */
  picking?: Picking & { name: string };
  /** The wardrobe's capsules: the filter's choices and its pill's name. */
  capsules: CapsuleRef[];
  /** After POST /wardrobe/bulk: its toast. */
  bulkResult?: { updated: number; skipped: number };
}

/** The one-shot flags the bulk edit's redirect carries (GridQuery). */
const BULK_FLAGS = ['bulkUpdated', 'bulkSkipped'] as const;

/** Tiles above the fold on a phone load eagerly; the rest when scrolled near. */
const EAGER_TILES = 8;

// Filter links and the search form replace #wardrobe-main and push the URL;
// their href/action keep them working without JavaScript.
const SWAP_MAIN = {
  'hx-target': '#wardrobe-main',
  'hx-swap': 'outerHTML',
  'hx-push-url': 'true',
} as const;

/**
 * The filters as query parameters (empty ones are left out of URLs). It
 * also renders hidden inputs in the search form, so a key added to
 * GridSearch lands in the page: only filters belong there.
 */
export function searchParams(search: GridSearch): Record<string, string> {
  return { ...search };
}

/**
 * GET /wardrobe: the shell around the swappable main, and above it today's
 * weather (#14), outside #wardrobe-main so filtering never reloads it. Not
 * in select mode or the capsule picker, which are tasks, not the closet.
 */
export function WardrobePage(props: {
  ctx: ViewContext;
  model: WardrobeModel;
}) {
  const { model } = props;
  return (
    <Layout ctx={props.ctx} title={t('WARDROBE')}>
      <Navbar ctx={props.ctx} />
      <header class="px-4 pt-20">
        {!model.selecting && !model.picking && <WeatherSlot ctx={props.ctx} />}
      </header>
      <WardrobeMain model={model} />
      <Dock ctx={props.ctx} />
    </Layout>
  );
}

/**
 * The swappable part of the wardrobe page: heading, wardrobe switcher,
 * result count, the first page of the grid, the fixed search and filter bar
 * and the filter modal. GET /wardrobe answers htmx fragment requests with
 * this element alone, so filtering and searching never re-render navbar and
 * dock, and always start again from the first page.
 */
export function WardrobeMain({ model }: { model: WardrobeModel }) {
  const { viewOwner, selecting } = model;
  return (
    <main id="wardrobe-main" class="p-4 pt-0 pb-40">
      <Heading model={model} />
      {!selecting && (
        <>
          <WardrobeTabs active="garments" viewOwner={viewOwner} />
          {model.toTag > 0 && (
            <TagPrompt count={model.toTag} viewOwner={viewOwner} />
          )}
          {model.toWash > 0 && <LaundryPrompt count={model.toWash} />}
          {model.sharedWardrobes.length > 0 && (
            <WardrobeSwitcher model={model} />
          )}
        </>
      )}

      <p class="text-sm text-base-content/60 mb-4 px-2">
        {model.count} {t('RESULTS')}
      </p>

      <Tiles model={model} />
      <Controls model={model} />
      {model.bulkResult && <BulkToast result={model.bulkResult} />}
    </main>
  );
}

/** The first page: links, or checkboxes inside select mode's form (bulk or picker). */
function Tiles({ model }: { model: WardrobeModel }) {
  const { picking } = model;
  if (model.page.tiles.length === 0) return <NoTiles model={model} />;
  if (picking) {
    return (
      <PickForm model={model} picking={picking}>
        <Grid model={model} />
      </PickForm>
    );
  }
  if (model.selecting) {
    return (
      <BulkForm search={model.search} viewOwner={model.viewOwner}>
        <Grid model={model} />
      </BulkForm>
    );
  }
  return <Grid model={model} />;
}

/**
 * What sits under the grid: the filter bar and modal while browsing, the
 * bulk dialog in select mode (the picker needs neither).
 */
function Controls({ model }: { model: WardrobeModel }) {
  const { search, viewOwner } = model;
  if (model.picking) return null;
  if (model.selecting) return <BulkDialog />;
  return (
    <>
      <FilterBar
        search={search}
        viewOwner={viewOwner}
        capsules={model.capsules}
      />
      <FilterModal
        search={search}
        options={model.options}
        capsules={model.capsules}
        viewOwner={viewOwner}
        ownerView={model.ownerView}
      />
    </>
  );
}

/**
 * No tiles: nothing matches the filters (say so, offer to clear them), or
 * the wardrobe is empty (offer the first garment).
 */
function NoTiles({ model }: { model: WardrobeModel }) {
  const { search, viewOwner } = model;
  const filtered = Object.values(searchParams(search)).some((value) => value);
  if (filtered) {
    const clear = wardrobeUrl(viewOwner);
    return (
      <EmptyState message={t('NO_GARMENTS_MATCH')}>
        <a href={clear} hx-get={clear} {...SWAP_MAIN} class="btn btn-sm">
          {t('CLEAR_FILTERS')}
        </a>
      </EmptyState>
    );
  }
  return (
    <EmptyState message={t('NO_GARMENTS')}>
      {model.canEdit && (
        <a
          href={wardrobeUrl(viewOwner, {}, '/wardrobe/new')}
          class="btn btn-primary btn-sm"
        >
          {t('ADD_FIRST_GARMENT')}
        </a>
      )}
    </EmptyState>
  );
}

/** "12 garments need details: Tag them", into tagging mode. */
function TagPrompt(props: { count: number; viewOwner: number | undefined }) {
  return (
    <div role="status" class="alert alert-info alert-soft mb-4 mx-2 py-2">
      <span class="text-sm">{t('TAG_PROMPT', { count: props.count })}</span>
      <a
        href={wardrobeUrl(props.viewOwner, {}, '/wardrobe/tag')}
        class="btn btn-sm btn-info"
      >
        {t('TAG_PROMPT_ACTION')}
      </a>
    </div>
  );
}

/** "3 garments need a wash: Laundry", to the owner. */
function LaundryPrompt(props: { count: number }) {
  return (
    <div role="status" class="alert alert-soft mb-4 mx-2 py-2">
      <span class="text-sm">
        {t('wear.LAUNDRY_PROMPT', { count: props.count })}
      </span>
      <a href="/laundry" class="btn btn-sm">
        {t('wear.LAUNDRY')}
      </a>
    </div>
  );
}

/**
 * The title and, for someone who may edit, Select (or Cancel) and New. The
 * picker's Cancel goes back to its capsule.
 */
function Heading({ model }: { model: WardrobeModel }) {
  const { search, viewOwner, canEdit, selecting, picking } = model;
  if (picking) {
    return (
      <div class="flex items-center justify-between gap-2 mb-6 px-2">
        <h1 class="text-2xl font-bold">
          {t('PICK_GARMENTS_FOR', { name: picking.name })}
        </h1>
        <a
          href={capsuleUrl(picking.capsuleId, viewOwner)}
          class="btn btn-ghost btn-sm"
        >
          {t('CANCEL')}
        </a>
      </div>
    );
  }
  return (
    <div class="flex items-center justify-between gap-2 mb-6 px-2">
      <h1 class="text-2xl font-bold">
        {selecting ? t('SELECT_GARMENTS') : t('WARDROBE')}
      </h1>
      {canEdit && (
        <div class="flex gap-2">
          {model.page.tiles.length > 0 && (
            <SelectToggle
              search={search}
              viewOwner={viewOwner}
              selecting={selecting}
            />
          )}
          {!selecting && (
            <a
              href={wardrobeUrl(viewOwner, {}, '/wardrobe/new')}
              class="btn btn-primary btn-sm"
            >
              + {t('NEW_GARMENT')}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A grantee's wardrobe switcher: swaps this main like a filter does
 * (unfiltered, ?ownerId= the only parameter; '' is the requester's own).
 */
function WardrobeSwitcher({ model }: { model: WardrobeModel }) {
  const { viewOwner } = model;
  return (
    <div class="mb-4 px-2">
      <select
        name="ownerId"
        class="select select-bordered select-sm w-full"
        aria-label={t('MY_WARDROBE')}
        hx-get="/wardrobe"
        hx-trigger="change"
        {...SWAP_MAIN}
      >
        <option value="" selected={viewOwner === undefined}>
          {t('MY_WARDROBE')}
        </option>
        {model.sharedWardrobes.map((shared) => (
          <option
            value={shared.grantorId}
            selected={viewOwner === shared.grantorId}
          >
            {shared.grantorName} ({shared.permission})
          </option>
        ))}
      </select>
    </div>
  );
}

function Grid({ model }: { model: WardrobeModel }) {
  return (
    <div id="wardrobe-grid" class="flex flex-wrap gap-4 justify-center">
      <GarmentTiles
        page={model.page}
        search={model.search}
        viewOwner={model.viewOwner}
        selecting={model.selecting}
        picking={model.picking}
        firstPage
      />
    </div>
  );
}

/** "Select" into select mode, "Cancel" out of it; the filters stay. */
function SelectToggle(props: {
  search: GridSearch;
  viewOwner: number | undefined;
  selecting: boolean;
}) {
  const href = wardrobeUrl(props.viewOwner, {
    ...searchParams(props.search),
    select: props.selecting ? undefined : '1',
  });
  return (
    <a href={href} hx-get={href} {...SWAP_MAIN} class="btn btn-ghost btn-sm">
      {props.selecting ? t('CANCEL') : t('SELECT')}
    </a>
  );
}

/**
 * One page of tiles and, when there are more, the sentinel that fetches the
 * next: when it scrolls into view htmx requests GET /wardrobe/tiles with the
 * same filters and `before` the last tile's id, and replaces the sentinel
 * with that page (whose own sentinel continues). The tiles route answers
 * with this component alone.
 */
export function GarmentTiles(props: {
  page: GridPage;
  search: GridSearch;
  viewOwner: number | undefined;
  /** Select mode: checkbox tiles, and the next page asked for as such. */
  selecting: boolean;
  /** The capsule picker: members checked, every tile marked shown. */
  picking?: Picking;
  firstPage?: boolean;
}) {
  const { page, search, viewOwner, selecting, picking } = props;
  return (
    <>
      {page.tiles.map((tile, index) => {
        const eager = props.firstPage === true && index < EAGER_TILES;
        return selecting ? (
          <SelectTile
            tile={tile}
            eager={eager}
            checked={picking?.members.has(tile.id) ?? false}
            shown={picking !== undefined}
          />
        ) : (
          <Tile tile={tile} viewOwner={viewOwner} eager={eager} />
        );
      })}
      {page.before !== undefined && (
        <div
          class="w-full flex justify-center py-6"
          hx-get={wardrobeUrl(
            viewOwner,
            {
              ...searchParams(search),
              select: selecting && !picking ? '1' : undefined,
              pick: picking?.capsuleId,
              before: page.before,
            },
            '/wardrobe/tiles',
          )}
          hx-trigger="revealed"
          hx-swap="outerHTML"
          data-wardrobe-more=""
        >
          <span
            class="loading loading-dots loading-md text-base-content/40"
            aria-label={t('LOADING_MORE')}
          ></span>
        </div>
      )}
    </>
  );
}

const TILE_CLASS = 'card bg-base-100 w-40 sm:w-44 shadow-sm';

function Tile(props: {
  tile: GarmentTile;
  viewOwner: number | undefined;
  eager: boolean;
}) {
  const { tile } = props;
  return (
    <a
      href={garmentUrl(tile.id, props.viewOwner)}
      class={`${TILE_CLASS} hover:shadow-md transition-shadow cursor-pointer ${tile.status === 'archived' ? 'opacity-50' : ''}`}
    >
      <TileContent tile={tile} eager={props.eager} />
    </a>
  );
}

/**
 * A tile in select mode: a checkbox of the bulk form or the picker
 * (`ids`), the whole card its label, ringed while checked. No link: a tap
 * selects. In the picker a hidden `shown` says the tile was on screen.
 */
function SelectTile(props: {
  tile: GarmentTile;
  eager: boolean;
  checked: boolean;
  shown: boolean;
}) {
  const { tile } = props;
  return (
    <label
      class={`${TILE_CLASS} relative cursor-pointer has-[:checked]:ring-2 has-[:checked]:ring-primary ${tile.status === 'archived' ? 'opacity-50' : ''}`}
    >
      <input
        type="checkbox"
        name="ids"
        value={String(tile.id)}
        checked={props.checked}
        class="checkbox checkbox-primary checkbox-sm absolute top-2 left-2 z-10 not-checked:bg-base-100"
        aria-label={tile.name ?? categoryLabel(tile.category)}
      />
      {props.shown && (
        <input type="hidden" name="shown" value={String(tile.id)} />
      )}
      <TileContent tile={tile} eager={props.eager} />
    </label>
  );
}

function TileContent(props: { tile: GarmentTile; eager: boolean }) {
  const { tile } = props;
  return (
    <>
      <figure class="relative aspect-square bg-base-200">
        <TileBadges tile={tile} />
        {tile.photo ? (
          <img
            src={imageUrl(tile.photo, 'thumb')}
            alt={tile.name ?? ''}
            class="object-cover w-full h-full"
            width="400"
            height="400"
            decoding="async"
            loading={props.eager ? undefined : 'lazy'}
          />
        ) : (
          <div class="flex items-center justify-center w-full h-full text-base-content/30">
            <HangerIcon class="size-12" strokeWidth="1" />
          </div>
        )}
      </figure>
      <div class="card-body p-3">
        <h2 class="card-title text-sm">{tile.name}</h2>
        <p class="text-xs text-base-content/60 capitalize">
          {categoryLabel(tile.category)}
        </p>
      </div>
    </>
  );
}

/**
 * What a tile says over its photo: "x3" for identical copies, the
 * condition when it is not good, and to the owner alone, the wash state
 * ("Wash", "2/3" of a multiple) and whether it is away.
 */
function TileBadges({ tile }: { tile: GarmentTile }) {
  const badges: { text: string; class: string }[] = [];
  if (tile.quantity > 1) {
    badges.push({
      text: t('QUANTITY_BADGE', { quantity: tile.quantity }),
      class: 'badge-neutral',
    });
  }
  if (tile.care?.away) {
    badges.push({
      text: t(`wear.away.${tile.care.away}`),
      class: 'badge-warning',
    });
  }
  if (tile.care && tile.care.dirty > 0) {
    badges.push({
      text:
        tile.quantity > 1
          ? t('wear.BADGE_WASH_COPIES', {
              dirty: tile.care.dirty,
              quantity: tile.quantity,
            })
          : t('wear.BADGE_WASH'),
      class: 'badge-info',
    });
  }
  if (tile.condition !== 'good') {
    badges.push({
      text: valueLabel('condition', tile.condition),
      class: 'badge-warning badge-outline bg-base-100',
    });
  }
  if (badges.length === 0) return null;
  return (
    <div class="absolute top-2 right-2 flex flex-col items-end gap-1">
      {badges.map((badge) => (
        <span class={`badge badge-sm ${badge.class}`}>{badge.text}</span>
      ))}
    </div>
  );
}

/** An active filter as a pill; the link drops it and keeps the rest. */
function FilterPill(props: {
  search: GridSearch;
  viewOwner: number | undefined;
  drop: keyof GridSearch;
  class: string;
  label: string;
}) {
  const href = wardrobeUrl(props.viewOwner, {
    ...searchParams(props.search),
    [props.drop]: undefined,
  });
  return (
    <a
      href={href}
      hx-get={href}
      {...SWAP_MAIN}
      class={`badge badge-sm gap-1 cursor-pointer no-underline ${props.class}`}
    >
      {props.label} &times;
    </a>
  );
}

/** The property filters' pills (a type's pill only with its category's). */
function PropertyPills(props: {
  search: GridSearch;
  viewOwner: number | undefined;
}) {
  const { search } = props;
  const pills: { drop: keyof GridSearch; label: string }[] = [];
  if (search.type) {
    pills.push({ drop: 'type', label: valueLabel('type', search.type) });
  }
  if (search.warmth) {
    pills.push({
      drop: 'warmth',
      label: `${t('PROPERTY_WARMTH')}: ${valueLabel('warmth', search.warmth)}`,
    });
  }
  if (search.formality) {
    pills.push({
      drop: 'formality',
      label: valueLabel('formality', search.formality),
    });
  }
  if (search.material) {
    pills.push({
      drop: 'material',
      label: valueLabel('materials', search.material),
    });
  }
  return (
    <>
      {pills.map((pill) => (
        <FilterPill
          search={search}
          viewOwner={props.viewOwner}
          drop={pill.drop}
          class="badge-info"
          label={pill.label}
        />
      ))}
    </>
  );
}

// The filter modal's form and its "Clear" send the search box's keyword
// along, typed or not yet searched.
const INCLUDE_KEYWORD = "#search-form [name='keyword']";

/** The fixed bar above the dock: the filter button, active filters, search. */
function FilterBar(props: {
  search: GridSearch;
  viewOwner: number | undefined;
  capsules: CapsuleRef[];
}) {
  const { search, viewOwner } = props;
  const pill = { search, viewOwner };
  const capsule = props.capsules.find(
    (candidate) => String(candidate.id) === search.capsule,
  );
  return (
    <div class="fixed bottom-dock left-0 right-0 bg-base-100 border-t border-base-300 z-20 px-4 pt-2 pb-2">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <button
          type="button"
          onclick="document.getElementById('filter-modal').showModal()"
          class="btn btn-ghost btn-xs gap-1"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.5"
            stroke="currentColor"
            class="size-4"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z"
            />
          </svg>
          {t('FILTER_SEARCH')}
        </button>
        {capsule && (
          <FilterPill
            {...pill}
            drop="capsule"
            class="badge-neutral"
            label={capsule.name}
          />
        )}
        {search.category && (
          <FilterPill
            {...pill}
            drop="category"
            class="badge-primary capitalize"
            label={categoryLabel(search.category)}
          />
        )}
        {search.color && (
          <FilterPill
            {...pill}
            drop="color"
            class="badge-secondary capitalize"
            label={search.color}
          />
        )}
        {search.size && (
          <FilterPill
            {...pill}
            drop="size"
            class="badge-accent"
            label={search.size}
          />
        )}
        <PropertyPills {...pill} />
        {search.needsWash && (
          <FilterPill
            {...pill}
            drop="needsWash"
            class="badge-info"
            label={t('wear.FILTER_NEEDS_WASH')}
          />
        )}
        {search.attention && (
          <FilterPill
            {...pill}
            drop="attention"
            class="badge-warning"
            label={t('FILTER_ATTENTION')}
          />
        )}
        {search.archived && (
          <FilterPill
            {...pill}
            drop="archived"
            class="badge-warning"
            label={t('ARCHIVED')}
          />
        )}
      </div>
      <form
        method="get"
        action="/wardrobe"
        hx-get="/wardrobe"
        {...SWAP_MAIN}
        id="search-form"
        class="flex gap-2"
      >
        {/* Every other filter rides along with the keyword. */}
        {Object.entries(searchParams(search))
          .filter(([name, value]) => name !== 'keyword' && value !== '')
          .map(([name, value]) => (
            <input type="hidden" name={name} value={value} />
          ))}
        {viewOwner !== undefined && (
          <input type="hidden" name="ownerId" value={viewOwner} />
        )}
        <input
          type="text"
          name="keyword"
          value={search.keyword}
          maxlength={200}
          placeholder={t('SEARCH_PLACEHOLDER')}
          aria-label={t('SEARCH')}
          class="input input-bordered input-sm flex-1"
        />
        <button type="submit" class="btn btn-primary btn-sm">
          {t('SEARCH')}
        </button>
      </form>
    </div>
  );
}

/**
 * The filters as a GET form of their own: applying submits it into
 * #wardrobe-main like the search form (the swap takes the open dialog with
 * it), with the search box's keyword; "Clear" asks for the grid with only
 * the keyword. Without JavaScript it is a plain GET to /wardrobe.
 */
function FilterModal(props: {
  search: GridSearch;
  options: FilterOptions;
  capsules: CapsuleRef[];
  viewOwner: number | undefined;
  ownerView: boolean;
}) {
  const { search, options, capsules, viewOwner } = props;
  return (
    <dialog id="filter-modal" class="modal modal-bottom sm:modal-middle">
      <form
        method="get"
        action="/wardrobe"
        hx-get="/wardrobe"
        hx-include={INCLUDE_KEYWORD}
        {...SWAP_MAIN}
        class="modal-box"
      >
        <h3 class="font-bold text-lg mb-4">{t('FILTERS')}</h3>
        {viewOwner !== undefined && (
          <input type="hidden" name="ownerId" value={viewOwner} />
        )}
        {capsules.length > 0 && (
          <FilterGroup title={t('CAPSULE')}>
            {capsules.map((capsule) => (
              <Choice
                name="capsule"
                value={String(capsule.id)}
                checked={String(capsule.id) === search.capsule}
                class="peer-checked:badge-neutral"
                label={capsule.name}
              />
            ))}
          </FilterGroup>
        )}
        <FilterGroup title={t('CATEGORY')}>
          {options.categories.map((category) => (
            <Choice
              name="category"
              value={category}
              checked={category === search.category}
              class="peer-checked:badge-primary capitalize"
              label={categoryLabel(category)}
            />
          ))}
        </FilterGroup>
        <FilterGroup title={t('COLOR')}>
          {GARMENT_COLORS.map((color) => (
            <Choice
              name="color"
              value={color}
              checked={color === search.color}
              class="peer-checked:badge-secondary capitalize"
              label={color}
            />
          ))}
        </FilterGroup>
        {options.sizes.length > 0 && (
          <FilterGroup title={t('SIZE')}>
            {options.sizes.map((size) => (
              <Choice
                name="size"
                value={size}
                checked={size === search.size}
                class="peer-checked:badge-accent"
                label={size}
              />
            ))}
          </FilterGroup>
        )}
        <PropertyFilterGroups search={search} options={options} />
        <FilterGroup title={t('CARE')}>
          {/* Wears are the owner's own: a share offers no wash filter. */}
          {props.ownerView && (
            <Toggle
              name="needsWash"
              checked={search.needsWash !== ''}
              label={t('wear.FILTER_NEEDS_WASH')}
            />
          )}
          <Toggle
            name="attention"
            checked={search.attention !== ''}
            label={t('FILTER_ATTENTION')}
          />
        </FilterGroup>
        <FilterGroup title={t('ARCHIVED')}>
          <Toggle
            name="archived"
            checked={search.archived !== ''}
            label={t('SHOW_ARCHIVED')}
          />
        </FilterGroup>
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            hx-get={wardrobeUrl(viewOwner)}
            hx-include={INCLUDE_KEYWORD}
            {...SWAP_MAIN}
          >
            {t('CLEAR_FILTERS')}
          </button>
          <button type="submit" class="btn btn-primary btn-sm">
            {t('APPLY_FILTERS')}
          </button>
        </div>
      </form>
      <form method="dialog" class="modal-backdrop">
        <button>{t('CLOSE')}</button>
      </form>
    </dialog>
  );
}

/**
 * The property filters, each offering only the values the wardrobe holds
 * (FilterOptions). Types are listed for the chosen category alone, in the
 * form's order.
 */
function PropertyFilterGroups(props: {
  search: GridSearch;
  options: FilterOptions;
}) {
  const { search, options } = props;
  const types = typesOf(search.category)
    .map((type) => type.value)
    .filter((type) => options.types.includes(type));
  const groups: {
    name: keyof GridSearch;
    property: LabelledProperty;
    title: string;
    values: readonly (string | number)[];
  }[] = [
    {
      name: 'type',
      property: 'type',
      title: t('PROPERTY_TYPE'),
      values: types,
    },
    {
      name: 'warmth',
      property: 'warmth',
      title: t('PROPERTY_WARMTH'),
      values: WARMTHS.filter((w) => options.warmths.includes(w)),
    },
    {
      name: 'formality',
      property: 'formality',
      title: t('PROPERTY_FORMALITY'),
      values: FORMALITIES.filter((f) => options.formalities.includes(f)),
    },
    {
      name: 'material',
      property: 'materials',
      title: t('PROPERTY_MATERIALS'),
      values: MATERIALS.filter((m) => options.materials.includes(m)),
    },
  ];
  return (
    <>
      {groups
        .filter((group) => group.values.length > 0)
        .map((group) => (
          <FilterGroup title={group.title}>
            {group.values.map((value) => (
              <Choice
                name={group.name}
                value={String(value)}
                checked={String(value) === search[group.name]}
                class="peer-checked:badge-info"
                label={valueLabel(group.property, value)}
              />
            ))}
          </FilterGroup>
        ))}
    </>
  );
}

function FilterGroup(props: { title: string; children: Child }) {
  return (
    <div class="mb-5">
      <h4 class="font-medium text-sm text-base-content/60 uppercase tracking-wide mb-2">
        {props.title}
      </h4>
      <div class="flex flex-wrap gap-2">{props.children}</div>
    </div>
  );
}

// A yes-or-no filter: its query parameter is 'true' when checked.
function Toggle(props: {
  name: keyof GridSearch;
  checked: boolean;
  label: string;
}) {
  return (
    <label class="cursor-pointer flex items-center gap-2">
      <input
        type="checkbox"
        name={props.name}
        value="true"
        class="checkbox checkbox-sm"
        checked={props.checked}
      />
      <span class="text-sm">{props.label}</span>
    </label>
  );
}

// A radio of the filter form; its name is the query parameter.
function Choice(props: {
  name: string;
  value: string;
  checked: boolean;
  class: string;
  label: string;
}) {
  return (
    <label class="cursor-pointer">
      <input
        type="radio"
        name={props.name}
        value={props.value}
        class="hidden peer"
        checked={props.checked}
      />
      <span class={`badge badge-outline select-none ${props.class}`}>
        {props.label}
      </span>
    </label>
  );
}

const BULK_FORM_ID = 'bulk-form';

/**
 * Select mode's form: the grid's checkbox tiles (later pages arrive inside
 * it too) and the bar above the dock with the live count and the mode's
 * action. A native post carrying what the page needs back in its action's
 * query. The count is the one line of script: it re-counts the checked
 * boxes on every change.
 */
function SelectForm(props: {
  id: string;
  action: string;
  /** Boxes checked as rendered (the picker's members on this page). */
  checked: number;
  button: Child;
  children: Child;
}) {
  return (
    <PostForm id={props.id} action={props.action}>
      <div onchange="document.getElementById('selected-count').textContent = this.querySelectorAll('input[name=ids]:checked').length">
        {props.children}
        <div class="fixed bottom-dock left-0 right-0 bg-base-100 border-t border-base-300 z-20 px-4 py-3 flex items-center justify-between gap-2">
          <span class="text-sm">
            <span id="selected-count" class="font-semibold">
              {props.checked}
            </span>{' '}
            {t('SELECTED')}
          </span>
          {props.button}
        </div>
      </div>
    </PostForm>
  );
}

/**
 * Bulk edit: POST /wardrobe/bulk with the filters in its query, so the
 * redirect lands on the same grid; "Set…" opens the dialog below.
 */
function BulkForm(props: {
  search: GridSearch;
  viewOwner: number | undefined;
  children: Child;
}) {
  return (
    <SelectForm
      id={BULK_FORM_ID}
      action={wardrobeUrl(
        props.viewOwner,
        searchParams(props.search),
        '/wardrobe/bulk',
      )}
      checked={0}
      button={
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onclick="document.getElementById('bulk-dialog').showModal()"
        >
          {t('BULK_SET')}
        </button>
      }
    >
      {props.children}
    </SelectForm>
  );
}

/** The capsule picker: Save posts the membership and returns to the capsule. */
function PickForm(props: {
  model: WardrobeModel;
  picking: Picking;
  children: Child;
}) {
  const { model, picking } = props;
  return (
    <SelectForm
      id="pick-form"
      action={capsuleUrl(picking.capsuleId, model.viewOwner, '/garments')}
      checked={
        model.page.tiles.filter((tile) => picking.members.has(tile.id)).length
      }
      button={
        <button type="submit" class="btn btn-primary btn-sm">
          {t('SAVE')}
        </button>
      }
    >
      {props.children}
    </SelectForm>
  );
}

// Each bulk property's choices: the value field the garment form uses and
// its values ('' clears; materials add one; water resistance is yes or no).
const BULK_CHOICES: Record<
  BulkProperty,
  {
    field: string;
    label: StringKey;
    values: readonly (string | number)[];
    labelOf: (value: string | number) => string;
    clearable: boolean;
  }
> = {
  warmth: labelled('warmth', 'warmth', 'PROPERTY_WARMTH', WARMTHS),
  formality: labelled(
    'formality',
    'formality',
    'PROPERTY_FORMALITY',
    FORMALITIES,
  ),
  materials: {
    ...labelled('material', 'materials', 'PROPERTY_MATERIALS', MATERIALS),
    clearable: false,
  },
  pattern: labelled('pattern', 'pattern', 'PROPERTY_PATTERN', PATTERNS),
  fit: labelled('fit', 'fit', 'PROPERTY_FIT', FITS),
  sleeve: labelled('sleeve', 'sleeve', 'PROPERTY_SLEEVE', SLEEVES),
  length: labelled('length', 'length', 'PROPERTY_LENGTH', LENGTHS),
  waterResistant: {
    field: 'waterResistant',
    label: 'PROPERTY_WATER_RESISTANT',
    values: ['true', 'false'],
    labelOf: (value) =>
      t(value === 'true' ? 'WATER_RESISTANT_YES' : 'WATER_RESISTANT_NO'),
    clearable: false,
  },
  // Good is the reset, so no "Not set" chip.
  condition: {
    ...labelled('condition', 'condition', 'CONDITION', CONDITIONS),
    clearable: false,
  },
};

function labelled(
  field: string,
  property: LabelledProperty,
  label: StringKey,
  values: readonly (string | number)[],
) {
  return {
    field,
    label,
    values,
    labelOf: (value: string | number) => valueLabel(property, value),
    clearable: true,
  };
}

/**
 * "Set…": one property for every selected garment. The tabs are the
 * `property` radio (daisyUI radio tabs: the checked tab shows its values,
 * no script); each tab's chips are that property's field. Outside the form
 * (forms cannot nest, and the backdrop is a dialog form of its own), its
 * inputs join the bulk form through their `form` attribute.
 */
function BulkDialog() {
  return (
    <dialog id="bulk-dialog" class="modal modal-bottom sm:modal-middle">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-2">{t('BULK_TITLE')}</h3>
        <p class="text-sm text-base-content/60 mb-4">{t('BULK_HINT')}</p>
        <div role="tablist" class="tabs tabs-box tabs-sm flex-wrap">
          {BULK_PROPERTIES.map((property, index) => {
            const choice = BULK_CHOICES[property];
            return (
              <>
                <input
                  type="radio"
                  name="property"
                  value={property}
                  form={BULK_FORM_ID}
                  role="tab"
                  class="tab"
                  aria-label={t(choice.label)}
                  checked={index === 0}
                />
                <div class="tab-content pt-4">
                  {property === 'materials' && (
                    <p class="text-xs text-base-content/60 mb-2">
                      {t('BULK_MATERIALS_ADD')}
                    </p>
                  )}
                  <div class="flex flex-wrap gap-2">
                    {choice.clearable && (
                      <input
                        type="radio"
                        name={choice.field}
                        value=""
                        form={BULK_FORM_ID}
                        class="btn btn-sm btn-ghost rounded-full"
                        aria-label={t('NOT_SET')}
                      />
                    )}
                    {choice.values.map((value) => (
                      <input
                        type="radio"
                        name={choice.field}
                        value={String(value)}
                        form={BULK_FORM_ID}
                        class="btn btn-sm rounded-full"
                        aria-label={choice.labelOf(value)}
                      />
                    ))}
                  </div>
                </div>
              </>
            );
          })}
        </div>
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onclick="this.closest('dialog').close()"
          >
            {t('CANCEL')}
          </button>
          <button
            type="submit"
            form={BULK_FORM_ID}
            class="btn btn-primary btn-sm"
          >
            {t('APPLY')}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>{t('CLOSE')}</button>
      </form>
    </dialog>
  );
}

/** What the bulk edit did, once (StripFlags drops its flags from the URL). */
function BulkToast(props: { result: { updated: number; skipped: number } }) {
  const { updated, skipped } = props.result;
  const text =
    skipped > 0
      ? t('BULK_RESULT_SKIPPED', { updated, skipped })
      : t('BULK_RESULT', { updated });
  return (
    <>
      <SavedToast id="bulk-toast" text={text} />
      <StripFlags names={BULK_FLAGS} />
    </>
  );
}
