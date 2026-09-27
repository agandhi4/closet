import type { GarmentRole } from '../../wardrobe/properties';
import {
  DEFAULT_OCCASION,
  type Occasion,
  OCCASIONS,
} from '../../wardrobe/occasions';
import { PostForm } from '../auth/form';
import { dayOfWeek, type IsoDate } from '../calendar/calendar-date';
import { DAY_NAMES, dayLabel, occasionLabel } from '../calendar/labels';
import type { CapsuleRef } from '../capsules/queries';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { BackLink, EmptyState } from '../layout/parts';
import {
  destinationQuery,
  destinationTarget,
  type OutfitDestination,
} from '../outfits/destination';
import { OUTFIT_NAME_MAX } from '../outfits/queries';
import { tripUrl } from '../trips/urls';
import type { ViewContext } from '../view-context';
import type { StylingRow } from './rows';
import { type RowContext, roleLabel, StylingRowView } from './styling-row';
import {
  STYLING_PATH,
  STYLING_ROW_PATH,
  STYLING_SHUFFLE_PATH,
  type StylingState,
  stylingUrl,
} from './urls';

/**
 * GET /styling (#42; docs/plans/2026-09-26-redesign.md, "Styling"): the
 * outfit composer. A row per role top to toe, each a strip to swipe; Lock
 * and Shuffle (the generator fills the unlocked rows); Save opens a sheet
 * (the name, and where the outfit goes: `?for=`'s day or trip, or an
 * optional day). One form, `#styling-form`, holds every row's state and the
 * page's; the sheet's fields join it through their `form` attribute (a
 * dialog's backdrop is a form of its own, and forms do not nest). Over a
 * shared wardrobe (`?ownerId=`) it browses and shuffles but never saves:
 * outfits are private, and an outfit only ever holds its owner's garments.
 */

export interface StylingModel {
  state: StylingState;
  /** The page's destination, resolved (a trip's stray day dropped). */
  destination: OutfitDestination;
  rows: StylingRow[];
  /** The roles the wardrobe (or capsule) has garments of: "Add row"'s choices. */
  roles: GarmentRole[];
  /** Shuffle's next seed; absent until something shuffled (the bare page stays byte-stable). */
  seed?: number;
  capsule?: CapsuleRef;
  /** The addressed wardrobe's capsules, for the scope menu. */
  capsules: CapsuleRef[];
  /** `?outfit=`: the saved outfit being changed. */
  outfit?: { id: number; name: string | null };
  /** `for=trip:ID`: the trip's name. */
  trip?: { id: number; name: string };
  /** A wardrobe shared with the requester: whose, and that nothing saves. */
  shared?: { ownerId: number; name: string };
  /** What the last Shuffle found: nothing that fits the locks. */
  notice?: 'no-idea';
}

// The page's own script (public/js/styling.js, through the importmap): an
// inline module, so it runs again after a boosted navigation brings a new
// page (a <script src> module runs once per document). A fixed string with
// nothing interpolated.
const STYLING_INIT = `import { initStyling } from 'styling';
initStyling(document.getElementById('styling-rows'));`;

export function StylingPage(props: { ctx: ViewContext; model: StylingModel }) {
  const { ctx, model } = props;
  const viewOwner = model.shared?.ownerId;
  const context: RowContext = { state: model.state, viewOwner };
  return (
    <Layout ctx={ctx} title={t('styling.TITLE')}>
      <AppBar
        ctx={ctx}
        title={t('styling.TITLE')}
        back={model.state.returnTo}
        // Save posts natively and lands elsewhere (the outfit, a week); on a
        // shared wardrobe nothing saves.
        formPage={!model.shared}
        scope={<ScopeMenu model={model} />}
      />
      <main class="pt-20 pb-40 w-full sm:max-w-lg sm:mx-auto flex flex-col gap-3">
        <Header model={model} />
        {model.rows.length > 0 ? (
          <>
            <PostForm id="styling-form" action={STYLING_PATH}>
              <StateFields model={model} />
              <StylingRows model={model} context={context} />
            </PostForm>
            <AddRow model={model} />
            <script
              type="module"
              dangerouslySetInnerHTML={{ __html: STYLING_INIT }}
            />
          </>
        ) : (
          <Empty model={model} />
        )}
      </main>
      {model.rows.length > 0 && (
        <>
          <ActionBar model={model} />
          {!model.shared && <SaveSheet model={model} />}
        </>
      )}
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The rows, and what Shuffle carries on: the page renders it inside the
 * form, and Shuffle and "Add row" answer it alone (outerHTML), so the seed
 * and the notice change with the rows.
 */
export function StylingRows(props: {
  model: Pick<StylingModel, 'rows' | 'seed' | 'notice'>;
  context: RowContext;
}) {
  const { model, context } = props;
  return (
    <div id="styling-rows" class="flex flex-col gap-4">
      {model.notice === 'no-idea' && (
        <p class="alert alert-info alert-soft mx-4 py-2 text-sm" role="status">
          {t('styling.NO_IDEA')}
        </p>
      )}
      {model.rows.map((row) => (
        <StylingRowView row={row} context={context} />
      ))}
      {model.seed !== undefined && (
        <input type="hidden" name="seed" value={String(model.seed)} />
      )}
    </div>
  );
}

/** The page's state as form fields: Save and Shuffle post it back. */
function StateFields({ model }: { model: StylingModel }) {
  const { state, destination } = model;
  return (
    <>
      {destination.kind !== 'none' && (
        <input
          type="hidden"
          name="for"
          value={destinationTarget(destination)}
        />
      )}
      {destination.kind !== 'none' && destination.occasion && (
        <input type="hidden" name="occasion" value={destination.occasion} />
      )}
      {destination.kind === 'day' && destination.replace !== undefined && (
        <input
          type="hidden"
          name="replace"
          value={String(destination.replace)}
        />
      )}
      {state.capsuleId !== undefined && (
        <input type="hidden" name="capsule" value={String(state.capsuleId)} />
      )}
      {state.ownerId !== undefined && (
        <input type="hidden" name="ownerId" value={String(state.ownerId)} />
      )}
      {state.outfitId !== undefined && (
        <input type="hidden" name="outfit" value={String(state.outfitId)} />
      )}
      {state.returnTo !== undefined && (
        <input type="hidden" name="returnTo" value={state.returnTo} />
      )}
    </>
  );
}

/**
 * Under the app bar (which carries the title, the way back and the capsule
 * scope): the outfit being edited, the destination, and the notes.
 */
function Header({ model }: { model: StylingModel }) {
  return (
    <div class="flex flex-col gap-2 px-4">
      {model.outfit && (
        <p class="text-sm" data-styling-outfit={model.outfit.id}>
          {t('styling.EDITING', {
            name: model.outfit.name ?? t('UNTITLED_OUTFIT'),
          })}
        </p>
      )}
      <DestinationLine model={model} />
      {model.shared && (
        <p
          class="alert alert-info alert-soft py-2 text-sm"
          role="note"
          data-styling-shared=""
        >
          {t('styling.SHARED', { name: model.shared.name })}
        </p>
      )}
      <p
        data-offline-note=""
        class="alert alert-warning alert-soft py-2 text-sm"
        role="note"
      >
        {t('styling.OFFLINE')}
      </p>
    </div>
  );
}

/** Where Save plans the outfit (`?for=`), with the way back to where it came from. */
function DestinationLine({ model }: { model: StylingModel }) {
  const { destination } = model;
  if (destination.kind === 'day') {
    return (
      <div class="flex items-center gap-2" data-styling-for="day">
        <BackLink href={`/calendar/plan?${destinationQuery(destination)}`} />
        <p class="text-sm">{destinationSummary(model, destination)}</p>
      </div>
    );
  }
  if (destination.kind === 'trip' && model.trip) {
    return (
      <div class="flex items-center gap-2" data-styling-for="trip">
        <BackLink href={tripUrl(model.trip.id)} />
        <p class="text-sm min-w-0">{destinationSummary(model, destination)}</p>
      </div>
    );
  }
  return null;
}

/** The capsule scope: every row, and Shuffle's pool, only its garments. */
function ScopeMenu({ model }: { model: StylingModel }) {
  const { capsule, capsules, state } = model;
  if (capsules.length === 0) return null;
  return (
    <details class="dropdown dropdown-end">
      <summary class="btn btn-sm btn-outline rounded-full max-w-36">
        <span class="truncate">
          {capsule ? capsule.name : t('gallery.ALL_GARMENTS')}
        </span>{' '}
        ▾
      </summary>
      <ul class="dropdown-content menu bg-base-100 rounded-box shadow-md z-20 w-56 mt-1">
        <li>
          <a href={stylingUrl({ ...state, capsuleId: undefined })}>
            {t('gallery.ALL_GARMENTS')}
          </a>
        </li>
        {capsules.map((option) => (
          <li>
            <a
              href={stylingUrl({ ...state, capsuleId: option.id })}
              aria-current={option.id === capsule?.id ? 'true' : undefined}
            >
              {option.name}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Another row of a role (two accessories, a shirt over a tee): the rows
 * come back in order with the new one empty. Posts the form's state like
 * Shuffle, so nothing chosen is lost.
 */
function AddRow({ model }: { model: StylingModel }) {
  return (
    <details class="dropdown px-4">
      <summary class="btn btn-ghost btn-sm">+ {t('styling.ADD_ROW')}</summary>
      <ul class="dropdown-content menu bg-base-100 rounded-box shadow-md z-20 w-56 mt-1">
        {model.roles.map((role) => (
          <li>
            <button
              type="button"
              hx-get={`${STYLING_ROW_PATH}?add=${role}`}
              hx-include="#styling-form"
              hx-target="#styling-rows"
              hx-swap="outerHTML"
              onclick="this.closest('details').open = false"
            >
              {roleLabel(role)}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The bar above the dock (`bottom-dock`, z-20: under the dock and the
 * navbar, CLAUDE.md Gotchas): Shuffle, and Save (the sheet), or over a
 * shared wardrobe the reason there is no Save.
 */
function ActionBar({ model }: { model: StylingModel }) {
  return (
    <div class="fixed inset-x-0 bottom-dock z-20 bg-base-100 border-t border-base-300">
      <div class="flex items-center gap-2 px-4 py-2 sm:max-w-lg sm:mx-auto">
        <button
          type="button"
          class="btn btn-outline"
          hx-get={STYLING_SHUFFLE_PATH}
          hx-include="#styling-form"
          hx-target="#styling-rows"
          hx-swap="outerHTML"
          data-needs-network=""
          data-styling-shuffle=""
        >
          ⤮ {t('gallery.SHUFFLE')}
        </button>
        {model.shared ? (
          <p class="text-xs text-muted flex-1">{t('styling.SHARED_NO_SAVE')}</p>
        ) : (
          <button
            type="button"
            class="btn btn-primary flex-1"
            onclick="document.getElementById('styling-save').showModal()"
          >
            {t(model.outfit ? 'styling.SAVE_CHANGES' : 'SAVE')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Save's primary action, by where the outfit goes. */
function saveLabel(model: StylingModel): string {
  const { destination } = model;
  if (model.outfit) return t('styling.SAVE_CHANGES');
  switch (destination.kind) {
    case 'none':
      return t('styling.SAVE_OUTFIT');
    case 'trip':
      return t('gallery.PICK_TRIP');
    case 'day':
      return destination.replace === undefined
        ? t('gallery.PICK_DAY', {
            weekday: t(DAY_NAMES[dayOfWeek(destination.day)]),
          })
        : t('changeEntry.PICK');
  }
}

/**
 * The Save sheet: the name (the outfit's own when changing one; blank names
 * it for its garments), then where it goes. With `?for=` that is decided
 * (the day and occasion, the entry it replaces, the trip); without, an
 * optional day and occasion, as the builder's "Add to calendar" was.
 */
function SaveSheet({ model }: { model: StylingModel }) {
  const { destination } = model;
  return (
    <dialog
      id="styling-save"
      class="modal modal-bottom sm:modal-middle"
      aria-labelledby="styling-save-title"
    >
      <div class="modal-box flex flex-col gap-3 pb-8">
        <h2 id="styling-save-title" class="font-bold text-lg">
          {t(model.outfit ? 'styling.SAVE_CHANGES' : 'styling.SAVE_TITLE')}
        </h2>
        <label class="flex flex-col gap-1">
          <span class="label-text">{t('NAME')}</span>
          <input
            type="text"
            name="name"
            form="styling-form"
            class="input input-bordered w-full"
            value={model.outfit?.name ?? ''}
            maxlength={OUTFIT_NAME_MAX}
            placeholder={t('styling.NAME_PLACEHOLDER')}
          />
        </label>
        {destination.kind === 'none' ? (
          <ScheduleFields />
        ) : (
          <p class="text-sm" data-styling-save-for="">
            {destinationSummary(model, destination)}
          </p>
        )}
        <div class="modal-action mt-2">
          <button
            type="button"
            class="btn btn-ghost"
            onclick="this.closest('dialog').close()"
          >
            {t('CANCEL')}
          </button>
          <button
            type="submit"
            form="styling-form"
            class="btn btn-primary"
            data-needs-network=""
            data-styling-save=""
          >
            {saveLabel(model)}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>{t('CANCEL')}</button>
      </form>
    </dialog>
  );
}

function destinationSummary(
  model: StylingModel,
  destination: Exclude<OutfitDestination, { kind: 'none' }>,
): string {
  if (destination.kind === 'trip') {
    const parts = [
      t('gallery.FOR_TRIP', { name: model.trip?.name ?? '' }),
      destination.day && dayLabel(destination.day),
      destination.occasion && occasionLabel(destination.occasion),
    ].filter(Boolean);
    return parts.join(' · ');
  }
  return `${
    destination.replace === undefined
      ? t('gallery.FOR_DAY', { day: dayLabel(destination.day) })
      : t('changeEntry.FOR_DAY', { day: dayLabel(destination.day) })
  } · ${occasionLabel(destination.occasion)}`;
}

/**
 * "Add to calendar" without a destination: a day (empty: not planned) and
 * the occasion it is for. An outfit already on that day keeps its entry
 * and occasion (insertEntry).
 */
function ScheduleFields(props: { day?: IsoDate; occasion?: Occasion }) {
  const occasion = props.occasion ?? DEFAULT_OCCASION;
  return (
    <div class="grid grid-cols-2 gap-3">
      <label class="flex flex-col gap-1">
        <span class="label-text">{t('ADD_TO_CALENDAR')}</span>
        <input
          type="date"
          name="scheduleDate"
          form="styling-form"
          class="input input-bordered w-full"
          value={props.day}
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="label-text">{t('OCCASION')}</span>
        <select
          name="scheduleOccasion"
          form="styling-form"
          class="select select-bordered w-full"
        >
          {OCCASIONS.map((value) => (
            <option value={value} selected={value === occasion}>
              {occasionLabel(value)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Empty({ model }: { model: StylingModel }) {
  if (model.capsule) {
    return (
      <EmptyState message={t('styling.EMPTY_CAPSULE')}>
        <a
          href={stylingUrl({ ...model.state, capsuleId: undefined })}
          class="btn btn-primary btn-sm"
        >
          {t('gallery.ALL_GARMENTS')}
        </a>
      </EmptyState>
    );
  }
  return (
    <EmptyState message={t('styling.EMPTY')}>
      {!model.shared && (
        <a href="/wardrobe/new" class="btn btn-primary btn-sm">
          {t('NEW_GARMENT')}
        </a>
      )}
    </EmptyState>
  );
}
