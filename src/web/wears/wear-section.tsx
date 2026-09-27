import {
  AWAY_REASONS,
  dirtyCopies,
  washLimit,
} from '../../wardrobe/availability';
import { AutosaveForm } from '../autosave';
import { daysBetween, type IsoDate } from '../calendar/calendar-date';
import { t } from '../i18n';
import type { GarmentDetail } from '../wardrobe/queries';
import { garmentUrl } from '../wardrobe/urls';
import { CARE_NOTE_MAX } from '../wardrobe/validation';
import type { WearSummary } from './queries';

export const WEAR_SECTION_ID = 'garment-wear';
/** What Wore today and Washed answer: the section without "where it is". */
const WEAR_STATUS_ID = 'garment-wear-status';

/** What the section shows: the garment's wash state and away, and its wears. */
export interface WearPanel {
  summary: WearSummary;
  /** The household's date (APP_TIMEZONE): "last worn yesterday", "Wore today". */
  today: IsoDate;
}

type WearGarment = Pick<
  GarmentDetail,
  | 'id'
  | 'category'
  | 'quantity'
  | 'washAfterWears'
  | 'lastWashedOn'
  | 'away'
  | 'awayNote'
>;

// Wore today and Washed answer the wear status (htmx) or, posted without
// script, the garment page (303); never the section, which holds the
// autosaved "where it is" (a save queued there would die with it). Disabled
// while offline (data-needs-network): the connectivity banner says why.
const SWAP = {
  'hx-target': `#${WEAR_STATUS_ID}`,
  'hx-swap': 'outerHTML',
  'data-needs-network': '',
} as const;

/**
 * The garment page's "Wear and wash" (the owner's alone: wears, washes and
 * away are their own records, like the calendar). "Worn 12 times · 2 since
 * washed · last worn yesterday", the wash state ("2 of 3 need a wash"),
 * Wore today (or its undo, the same day), Washed, and where it is (in the
 * closet, lent, at the repair shop) with a note. POST /wardrobe/:id/wear
 * and /washed answer `WearStatus`, /away its form's status line
 * (src/web/wears/routes.tsx).
 */
export function WearSection(props: { garment: WearGarment; panel: WearPanel }) {
  return (
    <section
      id={WEAR_SECTION_ID}
      class="card bg-base-100 shadow-sm mb-4"
      aria-labelledby="garment-wear-title"
    >
      <div class="card-body gap-3">
        <h2 id="garment-wear-title" class="text-sm text-muted">
          {t('wear.SECTION')}
        </h2>
        <WearStatus garment={props.garment} panel={props.panel} />
        <AwayForm garment={props.garment} />
      </div>
    </section>
  );
}

/** The wears, the wash state and their buttons. */
export function WearStatus(props: { garment: WearGarment; panel: WearPanel }) {
  const { garment, panel } = props;
  const { summary } = panel;
  const limit = washLimit(garment.category, garment.washAfterWears);
  const dirty = dirtyCopies({
    quantity: garment.quantity,
    limit,
    wearsSinceWash: summary.sinceWash,
  });
  return (
    <div id={WEAR_STATUS_ID} class="flex flex-col gap-3">
      <p class="font-medium">{wornLine(summary, panel.today)}</p>
      <WashState dirty={dirty} quantity={garment.quantity} limit={limit} />
      {garment.lastWashedOn && (
        <p class="text-xs text-muted">
          {t('wear.LAST_WASHED', {
            when: relativeDay(garment.lastWashedOn, panel.today),
          })}
        </p>
      )}
      <div class="flex flex-wrap gap-2">
        <WoreToday garment={garment} today={summary.today} />
        {summary.sinceWash > 0 && limit !== null && (
          <form
            method="post"
            action={garmentUrl(garment.id, undefined, '/washed')}
            hx-post={garmentUrl(garment.id, undefined, '/washed')}
            {...SWAP}
          >
            <button type="submit" class="btn btn-sm btn-outline">
              {t('wear.WASHED')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** "Worn 12 times · 2 since washed · last worn yesterday"; "Not worn yet". */
function wornLine(summary: WearSummary, today: IsoDate): string {
  if (summary.worn === 0 || summary.lastWorn === null) {
    return t('wear.NOT_WORN');
  }
  return [
    summary.worn === 1
      ? t('wear.WORN_ONCE')
      : t('wear.WORN_TIMES', { count: summary.worn }),
    t('wear.SINCE_WASH', { count: summary.sinceWash }),
    t('wear.LAST_WORN', { when: relativeDay(summary.lastWorn, today) }),
  ].join(' · ');
}

/** "today", "yesterday", "3 days ago", else the date. */
export function relativeDay(day: IsoDate, today: IsoDate): string {
  const days = daysBetween(day, today);
  if (days === 0) return t('wear.TODAY');
  if (days === 1) return t('wear.YESTERDAY');
  if (days > 1 && days < 7) return t('wear.DAYS_AGO', { days });
  return day;
}

/** "Needs a wash", "2 of 3 need a wash", or nothing (clean, or never washed). */
function WashState(props: {
  dirty: number;
  quantity: number;
  limit: number | null;
}) {
  if (props.limit === null || props.dirty === 0) return null;
  return (
    <span class="badge badge-info self-start">
      {props.quantity > 1
        ? t('wear.COPIES_NEED_WASH', {
            dirty: props.dirty,
            quantity: props.quantity,
          })
        : t('wear.NEEDS_WASH')}
    </span>
  );
}

/**
 * Wore today: logs one wear of this garment alone. Once logged, the same
 * day, it offers the undo instead; a worn calendar entry today says so and
 * needs no second wear (they would count once anyway: distinct days).
 */
function WoreToday(props: {
  garment: WearGarment;
  today: WearSummary['today'];
}) {
  if (props.today === 'entry') {
    return (
      <span class="badge badge-success self-center">
        {t('wear.WORN_TODAY_CALENDAR')}
      </span>
    );
  }
  const url = garmentUrl(props.garment.id, undefined, '/wear');
  const undo = props.today === 'single';
  return (
    <form method="post" action={url} hx-post={url} {...SWAP}>
      <input type="hidden" name="worn" value={undo ? '0' : '1'} />
      <button
        type="submit"
        class={`btn btn-sm ${undo ? 'btn-ghost' : 'btn-primary'}`}
      >
        {undo ? t('wear.UNDO_WORE_TODAY') : t('wear.WORE_TODAY')}
      </button>
    </form>
  );
}

/**
 * Where it is: in the closet, lent or at the repair shop, and a note (who
 * has it, which shop), shown by CSS while a reason is checked, so it is
 * there the moment one is tapped. Saved on every change like the capsule
 * toggles (`AutosaveForm`); without script, Save.
 */
function AwayForm({ garment }: { garment: WearGarment }) {
  return (
    <AutosaveForm
      action={garmentUrl(garment.id, undefined, '/away')}
      native
      class="group flex flex-col gap-2"
    >
      <span class="text-xs text-muted">{t('wear.WHERE')}</span>
      <div class="flex flex-wrap gap-2">
        <input
          type="radio"
          name="away"
          value=""
          class="btn btn-sm rounded-full"
          aria-label={t('wear.IN_CLOSET')}
          checked={garment.away === null}
          data-no-note=""
        />
        {AWAY_REASONS.map((reason) => (
          <input
            type="radio"
            name="away"
            value={reason}
            class="btn btn-sm rounded-full checked:btn-warning"
            aria-label={t(`wear.away.${reason}`)}
            checked={garment.away === reason}
          />
        ))}
      </div>
      {/* Posted in the closet too; the server keeps a note only with a
          reason (the away route). */}
      <input
        type="text"
        name="awayNote"
        value={garment.awayNote ?? ''}
        maxlength={CARE_NOTE_MAX}
        placeholder={t('wear.AWAY_NOTE_PLACEHOLDER')}
        aria-label={t('wear.AWAY_NOTE')}
        class="input input-bordered input-sm w-full group-has-[[data-no-note]:checked]:hidden"
      />
      <noscript>
        <button type="submit" class="btn btn-sm self-start">
          {t('SAVE')}
        </button>
      </noscript>
    </AutosaveForm>
  );
}
