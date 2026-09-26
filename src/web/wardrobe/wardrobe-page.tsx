import type { Child } from 'hono/jsx';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { EmptyState, HangerIcon } from '../layout/parts';
import type { SharedWardrobe } from '../sharing/access';
import type { ViewContext } from '../view-context';
import { categoryLabel, GARMENT_COLORS } from './garment';
import type { FilterOptions, GarmentTile, GridPage } from './queries';
import { garmentUrl, wardrobeUrl } from './urls';

/** The grid's filters as the page echoes them into its links and forms. */
export interface GridSearch {
  keyword: string;
  category: string;
  color: string;
  size: string;
  /** 'true' when archived garments are shown too; '' otherwise. */
  archived: string;
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
}

/** Tiles above the fold on a phone load eagerly; the rest when scrolled near. */
const EAGER_TILES = 8;

// Filter links and the search form replace #wardrobe-main and push the URL;
// their href/action keep them working without JavaScript.
const SWAP_MAIN = {
  'hx-target': '#wardrobe-main',
  'hx-swap': 'outerHTML',
  'hx-push-url': 'true',
} as const;

function searchParams(search: GridSearch) {
  return {
    keyword: search.keyword,
    category: search.category,
    color: search.color,
    size: search.size,
    archived: search.archived,
  };
}

/** GET /wardrobe: the shell around the swappable main. */
export function WardrobePage(props: {
  ctx: ViewContext;
  model: WardrobeModel;
}) {
  return (
    <Layout ctx={props.ctx} title={t('WARDROBE')}>
      <Navbar ctx={props.ctx} />
      <WardrobeMain model={props.model} />
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
  const { search, viewOwner, canEdit } = model;
  const newUrl = wardrobeUrl(viewOwner, {}, '/wardrobe/new');
  return (
    <main id="wardrobe-main" class="p-4 pt-20 pb-40">
      <div class="flex items-center justify-between mb-6 px-2">
        <h1 class="text-2xl font-bold">{t('WARDROBE')}</h1>
        {canEdit && (
          <a href={newUrl} class="btn btn-primary btn-sm">
            + {t('NEW_GARMENT')}
          </a>
        )}
      </div>

      {/* Switching wardrobe swaps this main like a filter does (unfiltered,
          ?ownerId= the only parameter; '' is the requester's own). */}
      {model.sharedWardrobes.length > 0 && (
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
      )}

      <p class="text-sm text-base-content/60 mb-4 px-2">
        {model.count} {t('RESULTS')}
      </p>

      {model.page.tiles.length > 0 ? (
        <div id="wardrobe-grid" class="flex flex-wrap gap-4 justify-center">
          <GarmentTiles
            page={model.page}
            search={search}
            viewOwner={viewOwner}
            firstPage
          />
        </div>
      ) : (
        <EmptyState message={t('NO_GARMENTS')}>
          {canEdit && (
            <a href={newUrl} class="btn btn-primary btn-sm">
              {t('ADD_FIRST_GARMENT')}
            </a>
          )}
        </EmptyState>
      )}

      <FilterBar search={search} viewOwner={viewOwner} />
      <FilterModal search={search} options={model.options} />
    </main>
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
  firstPage?: boolean;
}) {
  const { page, search, viewOwner } = props;
  return (
    <>
      {page.tiles.map((tile, index) => (
        <Tile
          tile={tile}
          viewOwner={viewOwner}
          eager={props.firstPage === true && index < EAGER_TILES}
        />
      ))}
      {page.before !== undefined && (
        <div
          class="w-full flex justify-center py-6"
          hx-get={wardrobeUrl(
            viewOwner,
            { ...searchParams(search), before: page.before },
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

function Tile(props: {
  tile: GarmentTile;
  viewOwner: number | undefined;
  eager: boolean;
}) {
  const { tile } = props;
  return (
    <a
      href={garmentUrl(tile.id, props.viewOwner)}
      class={`card bg-base-100 w-40 sm:w-44 shadow-sm hover:shadow-md transition-shadow cursor-pointer ${tile.archived ? 'opacity-50' : ''}`}
    >
      <figure class="aspect-square bg-base-200">
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
    </a>
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

// The modal's buttons fill the search form's hidden fields and submit it
// through requestSubmit(), so htmx sees the submit event (form.submit()
// would bypass it and reload the whole page).
const CLEAR_FILTERS = `on click
   for el in <#filter-modal input/>
     set el.checked to false
   end
   set #active-category.value to ''
   set #active-color.value to ''
   set #active-size.value to ''
   set #active-archived.value to ''
   call #filter-modal.close()
   call #search-form.requestSubmit()`;

const APPLY_FILTERS = `on click
   set category to ''
   get the first <input[name='modal-category']:checked/>
   if it then set category to it.value end
   set color to ''
   get the first <input[name='modal-color']:checked/>
   if it then set color to it.value end
   set size to ''
   get the first <input[name='modal-size']:checked/>
   if it then set size to it.value end
   set archived to ''
   get the first <input[name='modal-archived']:checked/>
   if it then set archived to 'true' end
   set #active-category.value to category
   set #active-color.value to color
   set #active-size.value to size
   set #active-archived.value to archived
   call #filter-modal.close()
   call #search-form.requestSubmit()`;

/** The fixed bar above the dock: the filter button, active filters, search. */
function FilterBar(props: {
  search: GridSearch;
  viewOwner: number | undefined;
}) {
  const { search, viewOwner } = props;
  const pill = { search, viewOwner };
  return (
    <div class="fixed bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] left-0 right-0 bg-base-100 border-t border-base-300 z-20 px-4 pt-2 pb-2">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <button
          type="button"
          _="on click call #filter-modal.showModal()"
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
        <input
          type="hidden"
          name="category"
          id="active-category"
          value={search.category}
        />
        <input
          type="hidden"
          name="color"
          id="active-color"
          value={search.color}
        />
        <input type="hidden" name="size" id="active-size" value={search.size} />
        <input
          type="hidden"
          name="archived"
          id="active-archived"
          value={search.archived}
        />
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

function FilterModal(props: { search: GridSearch; options: FilterOptions }) {
  const { search, options } = props;
  return (
    <dialog id="filter-modal" class="modal modal-bottom sm:modal-middle">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-4">{t('FILTERS')}</h3>
        <FilterGroup title={t('GARMENT_TYPE')}>
          {options.categories.map((category) => (
            <Choice
              name="modal-category"
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
              name="modal-color"
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
                name="modal-size"
                value={size}
                checked={size === search.size}
                class="peer-checked:badge-accent"
                label={size}
              />
            ))}
          </FilterGroup>
        )}
        <FilterGroup title={t('ARCHIVED')}>
          <label class="cursor-pointer flex items-center gap-2">
            <input
              type="checkbox"
              name="modal-archived"
              value="true"
              class="checkbox checkbox-sm"
              checked={search.archived !== ''}
            />
            <span class="text-sm">{t('SHOW_ARCHIVED')}</span>
          </label>
        </FilterGroup>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" _={CLEAR_FILTERS}>
            {t('CLEAR_FILTERS')}
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            _={APPLY_FILTERS}
          >
            {t('APPLY_FILTERS')}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>{t('CLOSE')}</button>
      </form>
    </dialog>
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

// Radios named modal-*: outside the search form on purpose, so only the
// apply button (above) moves their values into it.
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
