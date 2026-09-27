import { t } from '../i18n';
import { TRIPS_PATH } from '../trips/urls';
import { CALENDAR_MONTH_PATH, CALENDAR_PATH } from './urls';

export type CalendarTab = 'week' | 'month' | 'trips';

/**
 * The Calendar's views: the week agenda (`/calendar`), the month of
 * collages (`/calendar/month`, R6) and Trips (`/trips`, #10), plain
 * boosted links like the Outfits and Wardrobe tabs (the redesign's
 * "Calendar", docs/plans/2026-09-26-redesign.md). Static on purpose:
 * `/calendar` is a stale-while-revalidate tab root and must render the
 * same bytes while nothing changes.
 */
export function CalendarTabs({ active }: { active: CalendarTab }) {
  const tab = (name: CalendarTab, href: string, label: string) => (
    <a
      role="tab"
      href={href}
      class={active === name ? 'tab tab-active' : 'tab'}
      aria-selected={active === name ? 'true' : 'false'}
    >
      {label}
    </a>
  );
  return (
    <div role="tablist" class="tabs tabs-box tabs-sm mb-4">
      {tab('week', CALENDAR_PATH, t('calendar.TAB_WEEK'))}
      {tab('month', CALENDAR_MONTH_PATH, t('calendar.TAB_MONTH'))}
      {tab('trips', TRIPS_PATH, t('calendar.TAB_TRIPS'))}
    </div>
  );
}
