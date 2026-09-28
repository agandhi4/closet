import { DEFAULT_OCCASION, OCCASIONS } from '../../wardrobe/occasions';
import { PostForm } from '../auth/form';
import type { IsoDate } from '../calendar/calendar-date';
import { dayLabel, occasionLabel } from '../calendar/labels';
import { AlreadySavedToast } from '../gallery/already-saved';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { GarmentThumb } from '../layout/parts';
import { EntrySelfie, SelfieView } from '../selfies/views';
import { ShareLinkButton } from '../share/share-button';
import { stylingUrl } from '../styling/urls';
import type { ViewContext } from '../view-context';
import { OutfitCollage } from './collage';
import type {
  OutfitDetail,
  OutfitEntries,
  OutfitSummary,
  PlannedDay,
  WornDay,
} from './queries';
import { outfitUrl } from './urls';

const PLAN_SHEET_ID = 'outfit-plan-sheet';
const OPEN_PLAN_SHEET = `document.getElementById('${PLAN_SHEET_ID}').showModal()`;

/**
 * GET /outfits/:id (redesign plan, "Outfits"; R5): the outfit as a record,
 * not an event. The collage, then its two actions, Plan (a sheet: a day and
 * an occasion, POST /calendar) and Edit in Styling (#42); then what its
 * calendar entries say, read rather than stored (plan section 1): the days
 * it is planned for, the days it was worn with their selfies (#19); then its
 * garments, each opening its page. Share and Delete are in the app bar's ⋯
 * menu. The owner's own page (outfits are private); the public share page
 * (src/web/share) shows the garments only, never the entries.
 */
export function OutfitPage(props: {
  ctx: ViewContext;
  outfit: OutfitDetail;
  entries: OutfitEntries;
  /** The household's today: the Plan sheet's first day. */
  today: IsoDate;
  /** The gallery's pick found this outfit already saved (?alreadySaved=1). */
  alreadySaved?: boolean;
}) {
  const { ctx, outfit, entries } = props;
  const name = outfit.name || t('UNTITLED_OUTFIT');
  return (
    <Layout ctx={ctx} title={name}>
      <AppBar
        ctx={ctx}
        title={name}
        back="/outfits"
        actions={<OutfitMenu ctx={ctx} outfit={outfit} />}
      />
      <main class="flex flex-col gap-6 px-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        {outfit.notes && <p class="text-muted text-sm px-1">{outfit.notes}</p>}
        {outfit.garments.length > 0 ? (
          <OutfitCollage garments={outfit.garments} eager />
        ) : (
          <p class="text-muted text-sm italic">{t('OUTFIT_NO_GARMENTS')}</p>
        )}
        <div class="flex gap-2">
          <button
            type="button"
            class="btn btn-primary flex-1"
            onclick={OPEN_PLAN_SHEET}
            data-outfit-plan=""
          >
            {t('outfits.PLAN')}
          </button>
          <a
            href={stylingUrl({
              outfitId: outfit.id,
              returnTo: outfitUrl(outfit.id),
            })}
            class="btn btn-outline flex-1"
          >
            {t('outfits.EDIT')}
          </a>
        </div>
        {entries.planned.length > 0 && (
          <PlannedList planned={entries.planned} />
        )}
        {entries.worn.length > 0 && (
          <WornStrip outfitId={outfit.id} worn={entries.worn} />
        )}
        {outfit.garments.length > 0 && <GarmentList outfit={outfit} />}
      </main>
      <PlanSheet outfitId={outfit.id} today={props.today} />
      <AlreadySavedToast shown={props.alreadySaved === true} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The ⋯ menu: Share (the public link) and Delete. Buttons only: a form
 * inside a daisyUI menu item loses its styling (the garment page's menu).
 */
function OutfitMenu(props: { ctx: ViewContext; outfit: OutfitDetail }) {
  const { ctx, outfit } = props;
  return (
    <details class="dropdown dropdown-end" id="outfit-menu">
      <summary
        class="btn btn-ghost btn-circle text-xl"
        aria-label={t('MORE_ACTIONS')}
      >
        ⋯
      </summary>
      <ul class="menu dropdown-content bg-base-100 rounded-box border border-base-300 z-20 w-56 p-2">
        <li>
          <ShareLinkButton
            siteUrl={ctx.siteUrl}
            type="outfit"
            shareableId={outfit.shareableId}
            variant="menu"
          />
        </li>
        <li>
          <button
            type="button"
            class="text-error"
            hx-delete={outfitUrl(outfit.id)}
            hx-confirm={t('CONFIRM_DELETE')}
          >
            {t('DELETE')}
          </button>
        </li>
      </ul>
    </details>
  );
}

/** "Planned": the entries from today on not worn yet, soonest first, each linking its week. */
function PlannedList({ planned }: { planned: PlannedDay[] }) {
  return (
    <section aria-labelledby="outfit-planned-title" data-outfit-planned="">
      <h2 id="outfit-planned-title" class="text-sm text-muted mb-2">
        {t('outfits.PLANNED_HEADING')}
      </h2>
      <ul class="flex flex-col gap-1">
        {planned.map(({ entryId, day, occasion }) => (
          <li data-planned-entry={entryId}>
            <a href={`/calendar?week=${day}`} class="link link-hover text-sm">
              {dayLabel(day)} · {occasionLabel(occasion)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "Worn": every day the outfit was worn, newest first, as the looks were
 * actually worn: its selfie, or a tile with the camera to add one (taken
 * later from the phone's library, most likely). Each day links its week.
 */
function WornStrip(props: { outfitId: number; worn: WornDay[] }) {
  const returnTo = outfitUrl(props.outfitId);
  return (
    <section data-worn-strip="">
      <h2 class="text-sm text-muted mb-2">
        {t('selfie.WORN_HEADING', { count: props.worn.length })}
      </h2>
      <div class="flex overflow-x-auto overscroll-x-contain gap-3 pb-2">
        {props.worn.map(({ entryId, day, selfie }) => (
          <div
            class="flex flex-col items-center gap-1 shrink-0 w-28"
            data-worn-day={day}
          >
            {selfie ? (
              <SelfieView
                selfie={selfie}
                day={day}
                entryId={entryId}
                returnTo={returnTo}
                size="strip"
              />
            ) : (
              <div class="h-36 aspect-[3/4] rounded-box bg-base-200 flex items-center justify-center">
                <EntrySelfie
                  entryId={entryId}
                  day={day}
                  selfie={null}
                  canTake
                  returnTo={returnTo}
                  size="strip"
                />
              </div>
            )}
            <a
              href={`/calendar?week=${day}`}
              class="text-xs text-center link link-hover leading-tight"
            >
              {dayLabel(day)}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The garments in the order the outfit was built, each opening its page. */
function GarmentList({ outfit }: { outfit: OutfitSummary }) {
  return (
    <section aria-labelledby="outfit-garments-title">
      <h2 id="outfit-garments-title" class="text-sm text-muted mb-2">
        {t('GARMENTS_IN_OUTFIT')}
      </h2>
      <div class="flex flex-wrap gap-3">
        {outfit.garments.map((garment) => (
          <a
            href={`/wardrobe/${garment.id}`}
            class="flex flex-col items-center gap-1 w-20"
          >
            <GarmentThumb garment={garment} class="rounded-box bg-base-200" />
            <span class="text-xs text-center line-clamp-2 leading-tight">
              {garment.name}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

/**
 * Plan: the outfit on a day, for an occasion, through POST /calendar (a
 * native post; 302 to that day's week, which shows it). Replaces the Saved
 * grid's per-card dropdown (R5). The day starts at today; the occasion is
 * a row of radios styled as chips, all day checked (the calendar's "+ Plan"
 * sheet's pattern, R6). Planning an outfit already on that day changes
 * nothing (an outfit is on a day once).
 */
function PlanSheet(props: { outfitId: number; today: IsoDate }) {
  return (
    <dialog
      id={PLAN_SHEET_ID}
      class="modal modal-bottom sm:modal-middle"
      aria-labelledby="outfit-plan-sheet-title"
    >
      <div class="modal-box flex flex-col gap-4 pb-8">
        <h2 id="outfit-plan-sheet-title" class="font-semibold text-lg">
          {t('outfits.PLAN_TITLE')}
        </h2>
        <PostForm action="/calendar" class="flex flex-col gap-4" needsNetwork>
          <input type="hidden" name="outfitId" value={String(props.outfitId)} />
          <label class="flex flex-col gap-1">
            <span class="text-sm text-muted">{t('outfits.PLAN_DAY')}</span>
            <input
              type="date"
              name="date"
              class="input w-full"
              value={props.today}
              required
            />
          </label>
          <fieldset>
            <legend class="text-sm text-muted mb-2">{t('OCCASION')}</legend>
            <div class="flex flex-wrap gap-2">
              {OCCASIONS.map((occasion) => (
                <input
                  type="radio"
                  name="occasion"
                  value={occasion}
                  class="btn btn-sm rounded-full checked:btn-primary"
                  aria-label={occasionLabel(occasion)}
                  checked={occasion === DEFAULT_OCCASION}
                />
              ))}
            </div>
          </fieldset>
          <div class="modal-action mt-0">
            <button
              type="button"
              class="btn btn-ghost"
              onclick="this.closest('dialog').close()"
            >
              {t('CANCEL')}
            </button>
            <button type="submit" class="btn btn-primary">
              {t('outfits.PLAN_SUBMIT')}
            </button>
          </div>
        </PostForm>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>{t('CLOSE')}</button>
      </form>
    </dialog>
  );
}
