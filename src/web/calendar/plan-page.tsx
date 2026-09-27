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
  /**
   * `?replace=`: the entry of this day and occasion whose outfit a choice
   * takes the place of (#69). A worn one cannot change: the page plans
   * another outfit beside it and says why.
   */
  replacing?: { entryId: number; outfitName: string | null; worn: boolean };
}

/**
 * GET /calendar/plan?for=day:D&occasion=O: plan one more outfit on a day.
 * The occasion first (links, so the choice is the URL's and every way on
 * carries it), then the three ways to an outfit: choose a generated idea
 * (the gallery's Ideas with the same `?for=`, #9), build a new one (the
 * builder with the same `?for=`) or pick a saved one (POST /calendar). The
 * redesign's "+ Plan" sheet (R6) is this page's content; its occasion rows
 * link here with their occasion.
 *
 * Opened to change an entry (`&replace=`, the calendar row's Change, #69),
 * it is "Change outfit": the occasion is the entry's (no chips), ideas and
 * saved outfits carry `replace` so the choice takes the entry's place
 * (replaceEntryOutfit), and there is no "Build a new outfit" (the builder
 * adds; its day and occasion are the person's to edit).
 */
export function PlanPage(props: { ctx: ViewContext; model: PlanModel }) {
  const { ctx, model } = props;
  const day = {
    kind: 'day',
    day: model.day,
    occasion: model.occasion,
  } as const;
  // A worn entry keeps its outfit: the page plans one more beside it.
  const changing =
    model.replacing?.worn === false ? model.replacing : undefined;
  const build = `/outfits/new?${destinationQuery(day)}&returnTo=/calendar`;
  const ideas = ideasUrl({
    destination: changing ? { ...day, replace: changing.entryId } : day,
  });
  const title = changing ? t('changeEntry.TITLE') : t('CALENDAR_PLAN_TITLE');
  return (
    <Layout ctx={ctx} title={title}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 w-full sm:max-w-lg sm:mx-auto flex flex-col gap-5">
        <PlanHeading model={model} changing={changing} title={title} />
        {!changing && <OccasionChips day={model.day} chosen={model.occasion} />}

        <div class="flex flex-col gap-2">
          <a href={ideas} class="btn btn-primary w-full" data-plan-ideas="">
            {t('gallery.PLAN_IDEAS')}
          </a>
          {!changing && (
            <a href={build} class="btn btn-outline w-full">
              + {t('CALENDAR_PLAN_BUILD')}
            </a>
          )}
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
              {changing && (
                <input
                  type="hidden"
                  name="replace"
                  value={String(changing.entryId)}
                />
              )}
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

type Replacing = NonNullable<PlanModel['replacing']>;

/**
 * The title, back to the week, the day (and, when changing an entry, its
 * occasion and outfit), and why a worn entry is not being changed.
 */
function PlanHeading(props: {
  model: PlanModel;
  changing: Replacing | undefined;
  title: string;
}) {
  const { model, changing, title } = props;
  const worn = model.replacing?.worn ? model.replacing : undefined;
  return (
    <>
      <div class="flex items-center gap-3">
        <BackLink href={`/calendar?week=${model.day}`} />
        <div class="min-w-0">
          <h1 class="text-2xl font-bold">{title}</h1>
          <p class="text-sm text-base-content/60">
            {dayLabel(model.day)}
            {changing && <> · {occasionLabel(model.occasion)}</>}
          </p>
          {changing && (
            <p class="text-sm truncate" data-replacing={changing.entryId}>
              {t('changeEntry.INSTEAD_OF', { name: outfitName(changing) })}
            </p>
          )}
        </div>
      </div>
      {worn && (
        <p class="alert alert-info alert-soft py-2 text-sm" role="note">
          {t('changeEntry.WORN_NOTE', { name: outfitName(worn) })}
        </p>
      )}
    </>
  );
}

function outfitName(replacing: Replacing): string {
  return replacing.outfitName || t('UNTITLED_OUTFIT');
}

/** The occasion as links: the choice lives in the URL. */
function OccasionChips(props: { day: IsoDate; chosen: Occasion }) {
  return (
    <nav aria-label={t('OCCASION')}>
      <p class="text-xs font-semibold uppercase tracking-wide text-base-content/50 mb-2">
        {t('CALENDAR_PLAN_OCCASION')}
      </p>
      <ul class="flex flex-wrap gap-2">
        {OCCASIONS.map((occasion) => {
          const chosen = occasion === props.chosen;
          return (
            <li>
              <a
                href={`/calendar/plan?${destinationQuery({ kind: 'day', day: props.day, occasion })}`}
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
