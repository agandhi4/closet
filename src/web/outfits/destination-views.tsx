import { dayOfWeek } from '../../calendar-date';
import { DAY_NAMES, dayLabel, occasionLabel } from '../date-labels';
import { t } from '../i18n';
import { BackLink } from '../layout/parts';
import {
  type DayDestination,
  destinationQuery,
  type OutfitDestination,
} from './destination';

/**
 * What the pages say of a destination (destination.tsx parses and writes
 * it): the line naming where a pick goes, and the pick's own label.
 */

/**
 * What the Outfits page is choosing for when it came from a calendar day
 * (`?for=day:D&occasion=O`): "For Tuesday, Sep 29 · Evening" ("Changing
 * …" with `&replace=`, #69), with the way back to that day's plan page.
 * The Ideas and Saved tabs both show it, so either says where a pick goes.
 */
export function DayDestinationLine(props: { destination: DayDestination }) {
  const { destination } = props;
  const day = dayLabel(destination.day);
  return (
    <div class="flex items-center gap-2" data-destination-day={destination.day}>
      <BackLink href={`/calendar/plan?${destinationQuery(destination)}`} />
      <p class="text-sm">
        <span class="font-medium">
          {destination.replace === undefined
            ? t('gallery.FOR_DAY', { day })
            : t('changeEntry.FOR_DAY', { day })}
        </span>{' '}
        · {occasionLabel(destination.occasion)}
      </p>
    </div>
  );
}

/**
 * What the primary action does with the outfit, by where it goes: "Add to
 * the trip", "Plan for Tuesday" or, with `replace`, the change's own word.
 * The caller names the `none` case (the gallery saves, Styling saves an
 * outfit). Not in destination.tsx: this is the one piece that needs `t`.
 */
export function destinationPickLabel(
  destination: Exclude<OutfitDestination, { kind: 'none' }>,
): string {
  if (destination.kind === 'trip') return t('gallery.PICK_TRIP');
  return destination.replace === undefined
    ? t('gallery.PICK_DAY', {
        weekday: t(DAY_NAMES[dayOfWeek(destination.day)]),
      })
    : t('changeEntry.PICK');
}
