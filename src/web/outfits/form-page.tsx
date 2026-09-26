import type { IsoDate } from '../calendar/calendar-date';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import type { ViewContext } from '../view-context';
import type { BuilderRow } from './builder';
import { BackLink, EmptyState, HangerIcon } from '../layout/parts';
import { OutfitRow } from './outfit-row';

export interface OutfitFormModel {
  /** Absent for a new outfit. */
  outfit?: { id: number; name: string | null; notes: string | null };
  rows: BuilderRow[];
  /** The wardrobe's categories, offered by "Add row". */
  categories: string[];
  /** Back, Cancel and the post-save target; already passed through safeReturnTo. */
  returnTo: string;
  /** The calendar week to return to (from a calendar chip's edit link). */
  returnToWeek?: IsoDate;
  /** "Add to calendar" prefilled (from a calendar day's "+ Build outfit"). */
  scheduleDate?: IsoDate;
}

// Caps on what a person types, shared by the inputs' maxlength and the
// route's schema (a longer post is a 400). The columns are text since
// drizzle/0005; the name stays at the 255 it has always been, so no saved
// outfit fails its own edit form, and notes get room like a garment's.
export const OUTFIT_NAME_MAX = 255;
export const OUTFIT_NOTES_MAX = 4000;

// The one page that drags, so the one page that loads sortablejs (through
// the importmap in the layout). An inline module rather than a
// <script src>: a module URL runs once per document, so after a boosted
// navigation back to this page an external one would not run again, and a
// classic global could race htmx's asynchronous script insertion. A fixed
// string with nothing interpolated, so it needs no escaping (and JSX would
// otherwise escape its quotes).
const SORTABLE_INIT = `import Sortable from 'sortablejs';
Sortable.create(document.getElementById('outfit-rows-list'), {
  handle: '.drag-handle',
  animation: 150,
  ghostClass: 'opacity-40',
});`;

// Appends a row for the typed or picked category (GET /outfits/row-fragment).
const ADD_ROW = `on click
   set cat to the value of #add-row-input
   if cat is not ''
     js(cat) htmx.ajax('GET', '/outfits/row-fragment?category=' + encodeURIComponent(cat), {target: '#outfit-rows-list', swap: 'beforeend'}) end
     set the value of #add-row-input to ''
   end`;

/**
 * GET /outfits/new and /outfits/:id/edit: the builder rows (reorderable,
 * each cycling through its category), name, notes and "Add to calendar".
 * Posts to POST /outfits or /outfits/:id; the rows post in document order,
 * which is the order the outfit is saved in.
 */
export function OutfitFormPage(props: {
  ctx: ViewContext;
  model: OutfitFormModel;
}) {
  const { ctx, model } = props;
  const { outfit } = model;
  const title = outfit ? t('EDIT_OUTFIT') : t('BUILD_OUTFIT_TITLE');
  return (
    <Layout ctx={ctx} title={title}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto">
        <div class="flex items-center gap-3 mb-6">
          <BackLink href={model.returnTo} />
          <h1 class="text-2xl font-bold">{title}</h1>
        </div>
        {model.rows.length > 0 ? (
          <OutfitForm model={model} />
        ) : (
          <EmptyState message={t('NO_GARMENTS_FOR_BUILDER')}>
            <a href="/wardrobe/new" class="btn btn-primary btn-sm">
              {t('NEW_GARMENT')}
            </a>
          </EmptyState>
        )}
      </main>
      <GarmentModal />
      <Dock ctx={ctx} />
    </Layout>
  );
}

function OutfitForm({ model }: { model: OutfitFormModel }) {
  const { outfit } = model;
  return (
    // A native post (hx-boost="false"): the layout boosts every form, and htmx
    // drops a boosted 4xx, so a refused save (bad schedule date, mismatched
    // rows) would do nothing on screen. See CLAUDE.md, native posts.
    <form
      method="post"
      action={outfit ? `/outfits/${outfit.id}` : '/outfits'}
      hx-boost="false"
      class="flex flex-col gap-4"
    >
      <input type="hidden" name="returnTo" value={model.returnTo} />
      {model.returnToWeek && (
        <input type="hidden" name="returnToWeek" value={model.returnToWeek} />
      )}
      <div class="card bg-base-100 shadow-sm mb-4">
        <div
          id="outfit-rows-list"
          class="card-body p-3 divide-y divide-base-300"
        >
          {model.rows.map((row) => (
            <OutfitRow row={row} />
          ))}
        </div>
        <script
          type="module"
          dangerouslySetInnerHTML={{ __html: SORTABLE_INIT }}
        />
        <div class="flex gap-2 p-3 pt-0">
          <input
            type="text"
            id="add-row-input"
            list="add-row-suggestions"
            class="input input-bordered input-sm flex-1"
            placeholder={t('TYPE_OR_SELECT_CATEGORY')}
            autocomplete="off"
          />
          <datalist id="add-row-suggestions">
            {model.categories.map((category) => (
              <option value={category}></option>
            ))}
          </datalist>
          <button type="button" class="btn btn-sm btn-outline" _={ADD_ROW}>
            {t('ADD_ROW')}
          </button>
        </div>
      </div>

      <div class="form-control">
        <label class="label" for="outfit-name">
          <span class="label-text">{t('NAME')}</span>
        </label>
        <input
          type="text"
          id="outfit-name"
          name="name"
          class="input input-bordered w-full"
          value={outfit?.name ?? ''}
          maxlength={OUTFIT_NAME_MAX}
          placeholder={t('OUTFIT_NAME_PLACEHOLDER')}
        />
      </div>

      <div class="form-control">
        <label class="label" for="outfit-notes">
          <span class="label-text">{t('NOTES')}</span>
        </label>
        <textarea
          id="outfit-notes"
          name="notes"
          class="textarea textarea-bordered w-full"
          rows={2}
          maxlength={OUTFIT_NOTES_MAX}
          placeholder={t('OUTFIT_NOTES_PLACEHOLDER')}
        >
          {outfit?.notes ?? ''}
        </textarea>
      </div>

      <div class="form-control">
        <label class="label" for="outfit-schedule-date">
          <span class="label-text">{t('ADD_TO_CALENDAR')}</span>
        </label>
        <input
          type="date"
          id="outfit-schedule-date"
          name="scheduleDate"
          class="input input-bordered w-full"
          value={model.scheduleDate}
        />
      </div>

      <div class="flex gap-2 mt-2">
        <button type="submit" class="btn btn-primary flex-1">
          {t('SAVE')}
        </button>
        {!outfit && (
          <a href="/outfits/new" class="btn btn-ghost">
            {t('START_OVER')}
          </a>
        )}
        <a href={model.returnTo} class="btn btn-ghost">
          {t('CANCEL')}
        </a>
      </div>
    </form>
  );
}

/** A row's garment in detail, filled and opened by the row's button (outfit-row.tsx). */
function GarmentModal() {
  return (
    <dialog id="garment-modal" class="modal">
      <div class="modal-box p-0 overflow-hidden max-w-sm">
        <form method="dialog">
          <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2 z-10">
            ✕
          </button>
        </form>
        <a id="modal-garment-link" href="#" class="block">
          <div class="aspect-square w-full bg-base-200">
            <img
              id="modal-photo-img"
              src=""
              alt=""
              class="w-full h-full object-cover hidden"
            />
            <div
              id="modal-photo-placeholder"
              class="w-full h-full flex items-center justify-center text-base-content/30"
            >
              <HangerIcon class="size-20" strokeWidth="1" />
            </div>
          </div>
          <div class="p-4 flex flex-col gap-2">
            <h3 id="modal-garment-name" class="font-bold text-lg"></h3>
            <p
              id="modal-brand"
              class="text-sm text-base-content/60 capitalize hidden"
            ></p>
            <p
              id="modal-color"
              class="text-sm text-base-content/60 capitalize hidden"
            ></p>
            <p id="modal-size" class="text-sm text-base-content/60 hidden"></p>
            <p id="modal-notes" class="text-sm mt-1 hidden"></p>
          </div>
        </a>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}
