import { type Occasion, OCCASIONS } from '../../wardrobe/occasions';
import { PostForm } from '../auth/form';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink } from '../layout/parts';
import { ideasUrl } from '../gallery/urls';
import { destinationQuery } from '../outfits/destination';
import type { OutfitSummary } from '../outfits/queries';
import { SavedOutfitButton } from '../outfits/saved-outfit-button';
import type { ViewContext } from '../view-context';
import type { IsoDate } from './calendar-date';
import { dayLabel, occasionLabel } from './labels';

export interface PlanModel {
  day: IsoDate;
  occasion: Occasion;
  /** Every outfit of the owner's, newest first. */
  outfits: OutfitSummary[];
  /** The outfits already on the day, with their occasion: an outfit is on a day once. */
  planned: Map<number, Occasion>;
}

/**
 * GET /calendar/plan?for=day:D&occasion=O: plan one more outfit on a day.
 * The occasion first (links, so the choice is the URL's and every way on
 * carries it), then the three ways to an outfit: choose a generated idea
 * (the gallery's Ideas with the same `?for=`, #9), build a new one (the
 * builder with the same `?for=`) or pick a saved one (POST /calendar). The
 * redesign's "+ Plan" sheet (R6) is this page's content; its occasion rows
 * link here with their occasion.
 */
export function PlanPage(props: { ctx: ViewContext; model: PlanModel }) {
  const { ctx, model } = props;
  const week = `/calendar?week=${model.day}`;
  const destination = destinationQuery({
    kind: 'day',
    day: model.day,
    occasion: model.occasion,
  });
  const build = `/outfits/new?${destination}&returnTo=/calendar`;
  const ideas = ideasUrl({
    destination: { kind: 'day', day: model.day, occasion: model.occasion },
  });
  return (
    <Layout ctx={ctx} title={t('CALENDAR_PLAN_TITLE')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-5">
        <div class="flex items-center gap-3">
          <BackLink href={week} />
          <div>
            <h1 class="text-2xl font-bold">{t('CALENDAR_PLAN_TITLE')}</h1>
            <p class="text-sm text-base-content/60">{dayLabel(model.day)}</p>
          </div>
        </div>

        <nav aria-label={t('OCCASION')}>
          <p class="text-xs font-semibold uppercase tracking-wide text-base-content/50 mb-2">
            {t('CALENDAR_PLAN_OCCASION')}
          </p>
          <ul class="flex flex-wrap gap-2">
            {OCCASIONS.map((occasion) => {
              const chosen = occasion === model.occasion;
              return (
                <li>
                  <a
                    href={`/calendar/plan?${destinationQuery({ kind: 'day', day: model.day, occasion })}`}
                    class={`btn btn-sm rounded-full ${chosen ? 'btn-primary' : 'btn-outline'}`}
                    aria-current={chosen ? 'true' : undefined}
                  >
                    {occasionLabel(occasion)}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div class="flex flex-col gap-2">
          <a href={ideas} class="btn btn-primary w-full" data-plan-ideas="">
            {t('gallery.PLAN_IDEAS')}
          </a>
          <a href={build} class="btn btn-outline w-full">
            + {t('CALENDAR_PLAN_BUILD')}
          </a>
        </div>

        <section>
          <h2 class="text-xs font-semibold uppercase tracking-wide text-base-content/50 mb-2">
            {t('CALENDAR_PLAN_SAVED')}
          </h2>
          {model.outfits.length > 0 ? (
            <PostForm
              action="/calendar"
              class="flex flex-col gap-2"
              needsNetwork
            >
              <input type="hidden" name="date" value={model.day} />
              <input type="hidden" name="occasion" value={model.occasion} />
              <input type="hidden" name="week" value={model.day} />
              {model.outfits.map((outfit) => (
                <SavedOutfitButton
                  outfit={outfit}
                  note={plannedNote(model.planned.get(outfit.id))}
                />
              ))}
            </PostForm>
          ) : (
            <p class="text-sm text-base-content/50">
              {t('CALENDAR_PLAN_NO_OUTFITS')}
            </p>
          )}
        </section>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * An outfit already on the day is disabled, saying for which occasion: the
 * same outfit is on a day once (outfit_calendar's unique key).
 */
function plannedNote(plannedFor: Occasion | undefined): string | undefined {
  return (
    plannedFor && `${t('CALENDAR_PLAN_ON_DAY')} · ${occasionLabel(plannedFor)}`
  );
}
