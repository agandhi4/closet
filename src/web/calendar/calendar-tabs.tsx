import { t } from '../i18n';
import { TRIPS_PATH } from '../trips/urls';

export type CalendarTab = 'week' | 'trips';

/**
 * The Calendar's views: the week (`/calendar`) and Trips (`/trips`, #10),
 * plain boosted links like the Outfits and Wardrobe tabs (the redesign's
 * "Calendar › Trips", docs/plans/2026-09-26-redesign.md). Static on
 * purpose: `/calendar` is a stale-while-revalidate tab root and must render
 * the same bytes while nothing changes.
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
      {tab('week', '/calendar', t('trips.TAB_WEEK'))}
      {tab('trips', TRIPS_PATH, t('trips.TAB_TRIPS'))}
    </div>
  );
}
