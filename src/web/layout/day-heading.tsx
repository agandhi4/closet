import { dayOfWeek, type IsoDate } from '../../calendar-date';
import { DAY_NAMES, shortDayLabel } from '../date-labels';
import { t } from '../i18n';

/**
 * A day's heading in a list of days: "Tuesday Sep 29", the date muted, and
 * a Today badge on today. Used by the calendar's week and a trip's days, so
 * both read a day the same way; each page picks the level its outline needs.
 */
export function DayHeading(props: {
  as: 'h2' | 'h3';
  date: IsoDate;
  isToday: boolean;
  id?: string;
}) {
  const Heading = props.as;
  return (
    <Heading
      id={props.id}
      class={`text-sm font-semibold ${props.isToday ? 'text-primary' : ''}`}
    >
      {t(DAY_NAMES[dayOfWeek(props.date)])}{' '}
      <span class="ms-1 font-normal text-muted">
        {shortDayLabel(props.date)}
      </span>
      {props.isToday && (
        <span class="badge badge-sm badge-primary ms-2">
          {t('today.TITLE')}
        </span>
      )}
    </Heading>
  );
}
