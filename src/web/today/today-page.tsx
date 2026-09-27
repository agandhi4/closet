import type { Child } from 'hono/jsx';
import type { Idea } from '../../wardrobe/generator';
import type { Occasion } from '../../wardrobe/occasions';
import { PostForm } from '../auth/form';
import type { IsoDate } from '../calendar/calendar-date';
import { dayLabel, occasionLabel } from '../calendar/labels';
import { ideaName } from '../gallery/ideas';
import { Reasons } from '../gallery/ideas-page';
import type { PoolGarment } from '../gallery/queries';
import { ideasUrl } from '../gallery/urls';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { OutfitCollage } from '../outfits/collage';
import type { ViewContext } from '../view-context';
import { WeatherSlot } from '../weather/views';
import type { TodayEntry } from './queries';
import type { IdeasRow, PlannedRow, TodayModel } from './today';
import { TODAY_PATH, todayIdeasUrl, WEAR_THIS_PATH } from './urls';

/**
 * Today (#15; docs/plans/2026-09-26-redesign.md, "Today"): the day's date,
 * its weather line (the #14 fragment, loaded in place like the other
 * pages'), then a row per occasion: a planned outfit with "Wore it" and
 * "Change", or three ideas to swipe with "Wear this" and Refresh. A summary
 * with one decision on it: every card leads into another tab's page with
 * the destination set, and Today stores nothing of its own.
 *
 * Network-first, not a stale-while-revalidate tab root (src/web/page-cache.ts):
 * all of it is the day's (the plan, the ideas, what was worn), so a copy
 * from yesterday would offer yesterday's decision. Offline, the worker's
 * last copy shows with its age, and every write is data-needs-network.
 */
export function TodayPage(props: { ctx: ViewContext; model: TodayModel }) {
  const { ctx, model } = props;
  return (
    <Layout ctx={ctx} title={t('today.TITLE')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-4">
        <h1 class="text-2xl font-bold px-2">{dayLabel(model.today)}</h1>
        <WeatherSlot ctx={ctx} />
        <p
          data-offline-note=""
          class="alert alert-warning alert-soft py-2 text-sm"
          role="note"
        >
          {t('today.OFFLINE')}
        </p>
        {model.rows.map((row) =>
          row.kind === 'planned' ? (
            <PlannedRowView row={row} today={model.today} />
          ) : (
            <IdeasRowView row={row} today={model.today} />
          ),
        )}
        <a
          href={`/calendar/plan?for=day:${model.today}`}
          class="btn btn-ghost btn-sm self-start"
        >
          + {t('today.PLAN_ANOTHER')}
        </a>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

function RowHeading(props: { occasion: Occasion; children?: Child }) {
  return (
    <div class="flex items-center justify-between gap-2 px-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-base-content/60">
        {occasionLabel(props.occasion)}
      </h2>
      {props.children}
    </div>
  );
}

function PlannedRowView(props: { row: PlannedRow; today: IsoDate }) {
  const { row, today } = props;
  return (
    <section
      class="flex flex-col gap-2"
      data-today-row="planned"
      data-occasion={row.occasion}
    >
      <RowHeading occasion={row.occasion} />
      {row.entries.map((entry, index) => (
        <PlannedCard entry={entry} today={today} eager={index === 0} />
      ))}
    </section>
  );
}

function PlannedCard(props: {
  entry: TodayEntry;
  today: IsoDate;
  eager: boolean;
}) {
  const { entry, today } = props;
  const name = entry.outfit.name || t('UNTITLED_OUTFIT');
  const worn = `/calendar/${entry.id}/worn`;
  return (
    <article class="card bg-base-100 shadow-sm" data-entry={entry.id}>
      <div class="card-body p-3 gap-3">
        <a href={`/outfits/${entry.outfit.id}`} aria-label={name}>
          <OutfitCollage garments={entry.outfit.garments} eager={props.eager} />
        </a>
        <h3 class="font-semibold text-sm line-clamp-2">{name}</h3>
        {entry.worn ? (
          <div class="flex items-center gap-2">
            <span class="badge badge-success gap-1" data-worn="">
              ✓ {t('today.WORN_TODAY')}
            </span>
            <PostForm action={worn} needsNetwork>
              <input type="hidden" name="worn" value="0" />
              <input type="hidden" name="returnTo" value={TODAY_PATH} />
              <button type="submit" class="btn btn-ghost btn-xs">
                {t('today.UNDO')}
              </button>
            </PostForm>
          </div>
        ) : (
          <div class="flex items-center gap-2">
            <PostForm action={worn} class="flex-1" needsNetwork>
              <input type="hidden" name="worn" value="1" />
              <input type="hidden" name="returnTo" value={TODAY_PATH} />
              <button type="submit" class="btn btn-primary btn-sm w-full">
                {t('today.WORE_IT')}
              </button>
            </PostForm>
            <a
              href={ideasUrl({
                destination: {
                  kind: 'day',
                  day: today,
                  occasion: entry.occasion,
                },
              })}
              class="btn btn-ghost btn-sm"
            >
              {t('today.CHANGE')}
            </a>
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * A row of today's ideas for an occasion: the whole answer of Refresh
 * (GET /today/ideas, swapped over this row), so the next page, its own
 * Refresh and the strip arrive together.
 */
export function IdeasRowView(props: { row: IdeasRow; today: IsoDate }) {
  const { row, today } = props;
  return (
    <section
      class="flex flex-col gap-2"
      data-today-row="ideas"
      data-occasion={row.occasion}
      data-page={row.page}
    >
      <RowHeading occasion={row.occasion}>
        {row.ideas.length > 0 && (
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            hx-get={todayIdeasUrl(row.occasion, row.nextPage)}
            hx-target="closest [data-today-row]"
            hx-swap="outerHTML"
            aria-label={t('today.REFRESH_LABEL')}
          >
            ⤮ {t('today.REFRESH')}
          </button>
        )}
      </RowHeading>
      {row.ideas.length > 0 ? (
        <div
          class="flex overflow-x-auto overscroll-x-contain snap-x snap-mandatory gap-3 pb-2"
          aria-label={t('today.STRIP_LABEL')}
        >
          {row.ideas.map((idea, index) => (
            <IdeaCard
              idea={idea}
              occasion={row.occasion}
              weather={row.weather !== null}
              eager={index === 0}
            />
          ))}
        </div>
      ) : (
        <p class="px-2 text-sm text-base-content/60">
          {t('gallery.EMPTY')}{' '}
          <a href="/wardrobe" class="link">
            {t('gallery.EMPTY_ACTION')}
          </a>
        </p>
      )}
      {row.ideas.length > 0 && (
        <a
          href={ideasUrl({
            destination: { kind: 'day', day: today, occasion: row.occasion },
          })}
          class="link link-hover text-sm px-2 self-start"
        >
          {t('today.MORE_IDEAS')}
        </a>
      )}
    </section>
  );
}

function IdeaCard(props: {
  idea: Idea<PoolGarment>;
  occasion: Occasion;
  weather: boolean;
  eager: boolean;
}) {
  const { idea } = props;
  return (
    <article
      class="snap-center shrink-0 w-[85%] card bg-base-100 shadow-sm"
      data-idea={idea.garments.map((g) => g.id).join(',')}
    >
      <div class="card-body p-3 gap-3">
        <OutfitCollage garments={idea.garments} eager={props.eager} />
        <h3 class="font-semibold text-sm line-clamp-2">
          {ideaName(idea.garments)}
        </h3>
        <Reasons idea={idea} weather={props.weather} />
        <PostForm action={WEAR_THIS_PATH} class="mt-auto" needsNetwork>
          {idea.garments.map((g) => (
            <input type="hidden" name="garmentId" value={String(g.id)} />
          ))}
          <input type="hidden" name="occasion" value={props.occasion} />
          <button type="submit" class="btn btn-primary btn-sm w-full">
            {t('today.WEAR_THIS')}
          </button>
        </PostForm>
      </div>
    </article>
  );
}
