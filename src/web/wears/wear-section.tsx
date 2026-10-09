import {
  AWAY_REASONS,
  dirtyCopies,
  washLimit,
} from '../../wardrobe/availability';
import { perWearCost, totalCost } from '../../wardrobe/insights';
import { AutosaveForm } from '../autosave';
import { daysBetween, type IsoDate } from '../../calendar-date';
import { t } from '../i18n';
import { StyleThisLink } from '../styling/style-this';
import { priceLabel } from '../wardrobe/garment';
import type { GarmentDetail } from '../wardrobe/queries';
import { garmentUrl } from '../wardrobe/urls';
import { CARE_NOTE_MAX } from '../wardrobe/garment-input';
import type { WearGarment, WearSummary } from './queries';

/** What Wore today and Washed answer: the wear line and the buttons. */
const WEAR_STATUS_ID = 'garment-wear-status';

/** What the section shows: the garment's wash state and away, and its wears. */
export interface WearPanel {
  summary: WearSummary;
  /** The household's date (APP_TIMEZONE): "last worn yesterday", "Wore today". */
  today: IsoDate;
}

// Wore today and Washed answer the wear status (htmx) or, posted without
// script, the garment page (303); never "where it is" (WhereaboutsSection),
// which is autosaved: a save queued there would die with a swap. Disabled
// while offline (data-needs-network): the connectivity banner says why.
const SWAP = {
  'hx-target': `#${WEAR_STATUS_ID}`,
  'hx-swap': 'outerHTML',
  'data-needs-network': '',
} as const;

/**
 * The garment page's wear line and primary actions (the owner's alone:
 * wears and washes are their own records, like the calendar): "Worn 12
 * times · 2 since washed · last worn yesterday · $4.00 a wear", the wash
 * state ("2 of 3 need a wash"), then Style this, Wore today (or its undo,
 * the same day) and Washed. POST /wardrobe/:id/wear and /washed answer
 * `WearStatus` (src/web/wears/routes.tsx). Where it is sits lower on the
 * page, with the condition (WhereaboutsSection).
 */
export function WearSection(props: { garment: WearGarment; panel: WearPanel }) {
  return (
    <section id="garment-wear" aria-label={t('wear.SECTION')}>
      <WearStatus garment={props.garment} panel={props.panel} />
    </section>
  );
}

/** The wear line, the wash state and the row of primary actions. */
export function WearStatus(props: { garment: WearGarment; panel: WearPanel }) {
  const { garment, panel } = props;
  const { summary } = panel;
  const limit = washLimit(garment.category, garment.washAfterWears);
  const dirty = dirtyCopies({
    quantity: garment.quantity,
    limit,
    wearsSinceWash: summary.sinceWash,
  });
  const needsWash = limit !== null && dirty > 0;
  return (
    <div id={WEAR_STATUS_ID} class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <p class="text-sm">{wornLine(garment, summary, panel.today)}</p>
        {(needsWash || garment.lastWashedOn) && (
          <p class="flex flex-wrap items-center gap-2 text-xs text-muted">
            {needsWash && (
              <WashState dirty={dirty} quantity={garment.quantity} />
            )}
            {garment.lastWashedOn &&
              t('wear.LAST_WASHED', {
                when: relativeDay(garment.lastWashedOn, panel.today),
              })}
          </p>
        )}
      </div>
      <div class="flex flex-wrap gap-2">
        {/* Styling takes closet garments only, never an archived one. */}
        {garment.status === 'closet' && (
          <StyleThisLink garmentId={garment.id} viewOwner={undefined} />
        )}
        <WoreToday garment={garment} today={summary.today} />
        {summary.sinceWash > 0 && limit !== null && (
          <form
            method="post"
            action={garmentUrl(garment.id, undefined, '/washed')}
            hx-post={garmentUrl(garment.id, undefined, '/washed')}
            class="flex flex-1"
            {...SWAP}
          >
            <button type="submit" class="btn btn-outline flex-1">
              {t('wear.WASHED')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * "Worn 12 times · 2 since washed · last worn yesterday · $4.00 a wear";
 * "Not worn yet". The cost is the insights' rule (totalCost, repairs
 * included, over perWearCost), shown only with a price and a wear.
 */
function wornLine(
  garment: WearGarment,
  summary: WearSummary,
  today: IsoDate,
): string {
  if (summary.worn === 0 || summary.lastWorn === null) {
    return t('wear.NOT_WORN');
  }
  const cost = totalCost({
    price: garment.price,
    quantity: garment.quantity,
    repairCost: summary.repairCost,
  });
  const perWear = cost === null ? null : perWearCost(cost, summary.worn);
  return [
    summary.worn === 1
      ? t('wear.WORN_ONCE')
      : t('wear.WORN_TIMES', { count: summary.worn }),
    t('wear.SINCE_WASH', { count: summary.sinceWash }),
    t('wear.LAST_WORN', { when: relativeDay(summary.lastWorn, today) }),
    ...(perWear === null
      ? []
      : [t('wear.PER_WEAR', { cost: priceLabel(perWear) })]),
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

/** "Needs a wash", or "2 of 3 need a wash" for multiples. */
function WashState(props: { dirty: number; quantity: number }) {
  return (
    <span class="badge badge-info">
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
    <form
      method="post"
      action={url}
      hx-post={url}
      class="flex flex-1"
      {...SWAP}
    >
      <input type="hidden" name="worn" value={undo ? '0' : '1'} />
      <button
        type="submit"
        class={`btn flex-1 whitespace-nowrap ${undo ? 'btn-ghost' : 'btn-outline'}`}
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
 * toggles (`AutosaveForm`); without script, Save. The owner's alone, like
 * the wears; POST /wardrobe/:id/away answers the form's status line.
 */
export function WhereaboutsSection(props: {
  garment: Pick<GarmentDetail, 'id' | 'away' | 'awayNote'>;
}) {
  const { garment } = props;
  return (
    <section id="garment-away" aria-labelledby="garment-away-title">
      <h2 id="garment-away-title" class="text-sm text-muted mb-2">
        {t('wear.WHERE')}
      </h2>
      <AutosaveForm
        action={garmentUrl(garment.id, undefined, '/away')}
        native
        class="group flex flex-col gap-2"
      >
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
    </section>
  );
}
