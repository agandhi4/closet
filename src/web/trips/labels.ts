import type { TripPhase } from '../../wardrobe/packing';
import { daysBetween, type IsoDate } from '../../calendar-date';
import { shortDayLabel } from '../date-labels';
import { t } from '../i18n';

/** "Oct 5 – Oct 9 · 5 days" (one day: "Oct 5 · 1 day"). */
export function tripDates(trip: {
  startsOn: IsoDate;
  endsOn: IsoDate;
}): string {
  const days = daysBetween(trip.startsOn, trip.endsOn) + 1;
  const length = t(days === 1 ? 'trips.ONE_DAY' : 'trips.DAYS', { days });
  return trip.startsOn === trip.endsOn
    ? `${shortDayLabel(trip.startsOn)} · ${length}`
    : `${t('trips.DATE_RANGE', {
        from: shortDayLabel(trip.startsOn),
        to: shortDayLabel(trip.endsOn),
      })} · ${length}`;
}

export function phaseLabel(phase: TripPhase): string {
  return t(`trips.phase.${phase}`);
}
