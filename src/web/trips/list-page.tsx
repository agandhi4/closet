import { tripPhase } from '../../wardrobe/packing';
import { CalendarTabs } from '../calendar/calendar-tabs';
import type { IsoDate } from '../calendar/calendar-date';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { EmptyState } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { phaseLabel, tripDates } from './labels';
import type { TripSummary } from './queries';
import { TRIPS_PATH, tripUrl } from './urls';

const PHASE_BADGE = {
  current: 'badge-primary',
  upcoming: 'badge-soft badge-primary',
  past: 'badge-ghost',
} as const;

/**
 * GET /trips: the Calendar's Trips tab (#10). The owner's trips, those ahead
 * or under way first (soonest first), then the past ones, each a card with
 * its dates, destination and how many outfits and extras it holds.
 */
export function TripsPage(props: {
  ctx: ViewContext;
  trips: TripSummary[];
  today: IsoDate;
}) {
  const { ctx, trips, today } = props;
  return (
    <Layout ctx={ctx} title={t('trips.TITLE')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto flex flex-col gap-3">
        <CalendarTabs active="trips" />
        <div class="flex items-center justify-between gap-2">
          <h1 class="text-2xl font-bold">{t('trips.TITLE')}</h1>
          <a href={`${TRIPS_PATH}/new`} class="btn btn-primary btn-sm">
            + {t('trips.NEW')}
          </a>
        </div>
        {trips.length === 0 ? (
          <EmptyState message={t('trips.EMPTY')}>
            <a href={`${TRIPS_PATH}/new`} class="btn btn-primary btn-sm">
              {t('trips.NEW')}
            </a>
          </EmptyState>
        ) : (
          <ul class="flex flex-col gap-2" data-trips="">
            {trips.map((trip) => {
              const phase = tripPhase(trip, today);
              return (
                <li>
                  <a
                    href={tripUrl(trip.id)}
                    class="card bg-base-200 hover:bg-base-300 transition-colors"
                    data-trip={trip.id}
                  >
                    <div class="card-body p-4 gap-1">
                      <div class="flex items-start justify-between gap-2">
                        <h2 class="font-semibold truncate">{trip.name}</h2>
                        <span class={`badge badge-sm ${PHASE_BADGE[phase]}`}>
                          {phaseLabel(phase)}
                        </span>
                      </div>
                      <p class="text-sm text-base-content/70">
                        {tripDates(trip)}
                      </p>
                      {trip.destination && (
                        <p class="text-sm text-base-content/60 truncate">
                          {trip.destination}
                        </p>
                      )}
                      <p class="text-xs text-base-content/50">
                        {t('trips.COUNTS', {
                          outfits: trip.outfits,
                          extras: trip.extras,
                        })}
                      </p>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
