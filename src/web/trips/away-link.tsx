import { t } from '../i18n';
import type { AwayTrip } from './away';
import { tripUrl } from './urls';

/**
 * A day of a trip (#684): where the owner is, linking to the trip, whose
 * page plans that day's outfits. The calendar's week shows it under each
 * trip day's date, Today under the weather line. `data-away` is the trip's
 * id, for the specs.
 */
export function AwayLink(props: { trip: AwayTrip; class?: string }) {
  const { trip } = props;
  return (
    <a
      href={tripUrl(trip.id)}
      class={`link link-hover text-sm text-muted ${props.class ?? ''}`}
      data-away={String(trip.id)}
      title={trip.name}
    >
      {t('calendar.AWAY', { place: trip.destination ?? trip.name })}
    </a>
  );
}
