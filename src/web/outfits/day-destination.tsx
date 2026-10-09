import { dayLabel, occasionLabel } from '../date-labels';
import { t } from '../i18n';
import { BackLink } from '../layout/parts';
import { type DayDestination, destinationQuery } from './destination';

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
