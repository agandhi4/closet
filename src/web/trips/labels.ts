import type { TripPhase } from '../../wardrobe/packing';
import { dateParts, daysBetween, type IsoDate } from '../../calendar-date';
import { MONTH_NAMES } from '../calendar/labels';
import { t } from '../i18n';

/** "Oct 5". */
export function shortDate(date: IsoDate): string {
  const { month, day } = dateParts(date);
  return t('trips.SHORT_DATE', { month: t(MONTH_NAMES[month - 1]), day });
}

/** "Oct 5 – Oct 9 · 5 days" (one day: "Oct 5 · 1 day"). */
export function tripDates(trip: {
  startsOn: IsoDate;
  endsOn: IsoDate;
}): string {
  const days = daysBetween(trip.startsOn, trip.endsOn) + 1;
  const length = t(days === 1 ? 'trips.ONE_DAY' : 'trips.DAYS', { days });
  return trip.startsOn === trip.endsOn
    ? `${shortDate(trip.startsOn)} · ${length}`
    : `${t('trips.DATE_RANGE', {
        from: shortDate(trip.startsOn),
        to: shortDate(trip.endsOn),
      })} · ${length}`;
}

export function phaseLabel(phase: TripPhase): string {
  return t(`trips.phase.${phase}`);
}
