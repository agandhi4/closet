import type { Idea } from '../../wardrobe/generator';
import type { Occasion } from '../../wardrobe/occasions';
import { displayTemperature } from '../../weather/temperature';
import { PostForm } from '../auth/form';
import { type IsoDate, dayOfWeek } from '../calendar/calendar-date';
import { DAY_NAMES, dayLabel, occasionLabel } from '../calendar/labels';
import type { CapsuleRef } from '../capsules/queries';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, EmptyState } from '../layout/parts';
import { OutfitCollage } from '../outfits/collage';
import {
  destinationQuery,
  destinationTarget,
  type OutfitDestination,
} from '../outfits/destination';
import { OutfitTabs } from '../outfits/outfit-tabs';
import { tripUrl } from '../trips/urls';
import type { ViewContext } from '../view-context';
import { UNIT_SYMBOLS } from '../weather/views';
import { ideaName, type IdeasWeather, shuffledSeed } from './ideas';
import type { PoolGarment } from './queries';
import { type GalleryState, ideasUrl } from './urls';

/**
 * The Outfits page's Ideas tab (#9): generated outfits as full-width cards
 * in a horizontal scroll-snap strip. Swiping is the browser's own
 * scrolling (no carousel library, no touch handlers); the strip's last
 * child is a sentinel that loads the next page when it scrolls into view
 * and replaces itself (GET /outfits/ideas/more), as the wardrobe grid's
 * does. A card's primary action follows `?for=` (OutfitDestination): plan
 * it on that day (or, with `&replace=`, put it in that entry's place, #69),
 * add it to that trip (#10), else save it. Every write is data-needs-network: offline
 * the cards the worker cached still show, the writes are disabled and the
 * page says why.
 */

/** A gallery with its seed decided (the page resolves the daily seed). */
export type SeededState = GalleryState & { seed: number };

export interface IdeasPageModel {
  state: SeededState;
  /** The day and occasion the ideas are for (today, all day, without `?for=`). */
  planning: { day: IsoDate; occasion: Occasion };
  /** The trip a pick goes to (`for=trip:ID`), the owner's. */
  trip: { id: number; name: string } | undefined;
  capsule: CapsuleRef | undefined;
  /** The owner's capsules, for the scope menu. */
  capsules: CapsuleRef[];
  styled: PoolGarment | undefined;
  cards: IdeaCardsModel;
}

export function IdeasPage(props: { ctx: ViewContext; model: IdeasPageModel }) {
  const { ctx, model } = props;
  const { state, cards } = model;
  const shuffle = ideasUrl({ ...state, seed: shuffledSeed(state.seed) });
  return (
    <Layout ctx={ctx} title={t('gallery.TITLE')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2 px-2">
          <h1 class="text-2xl font-bold">{t('OUTFITS')}</h1>
          <a href={shuffle} class="btn btn-ghost btn-sm" data-shuffle="">
            ⤮ {t('gallery.SHUFFLE')}
          </a>
        </div>
        <OutfitTabs active="ideas" />
        <Scope model={model} />
        {cards.weather && <WeatherNote weather={cards.weather} />}
        <p
          data-offline-note=""
          class="alert alert-warning alert-soft py-2 text-sm"
          role="note"
        >
          {t('gallery.OFFLINE')}
        </p>
        {cards.ideas.length > 0 ? (
          <div
            id="idea-strip"
            class="flex overflow-x-auto overscroll-x-contain snap-x snap-mandatory gap-4 pb-2"
            aria-label={t('gallery.STRIP_LABEL')}
          >
            <IdeaCards model={cards} />
          </div>
        ) : (
          <EmptyState
            message={t(
              model.capsule ? 'gallery.EMPTY_CAPSULE' : 'gallery.EMPTY',
            )}
          >
            <a href="/wardrobe" class="btn btn-primary btn-sm">
              {t('gallery.EMPTY_ACTION')}
            </a>
          </EmptyState>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * What the ideas are for and drawn from: the day and occasion with the way
 * back to the plan page, the capsule (a menu to change it) and "Style
 * this"'s garment, each removable.
 */
function Scope({ model }: { model: IdeasPageModel }) {
  const { state, planning, trip, capsule, capsules, styled } = model;
  const { destination } = state;
  return (
    <div class="flex flex-col gap-2 px-2">
      {destination.kind === 'trip' && trip && (
        <div class="flex items-center gap-2" data-ideas-trip={trip.id}>
          <BackLink href={tripUrl(trip.id)} />
          <p class="text-sm min-w-0">
            <span class="font-medium">
              {t('gallery.FOR_TRIP', { name: trip.name })}
            </span>{' '}
            · {dayLabel(planning.day)}
            {destination.occasion && (
              <> · {occasionLabel(destination.occasion)}</>
            )}
          </p>
        </div>
      )}
      {destination.kind === 'day' && (
        <div class="flex items-center gap-2">
          <BackLink href={`/calendar/plan?${destinationQuery(destination)}`} />
          <p class="text-sm">
            <span class="font-medium">
              {destination.replace === undefined
                ? t('gallery.FOR_DAY', { day: dayLabel(planning.day) })
                : t('changeEntry.FOR_DAY', { day: dayLabel(planning.day) })}
            </span>{' '}
            · {occasionLabel(planning.occasion)}
          </p>
        </div>
      )}
      <div class="flex flex-wrap items-center gap-2">
        {capsules.length > 0 && (
          <details class="dropdown">
            <summary class="btn btn-sm btn-outline rounded-full">
              {capsule ? capsule.name : t('gallery.ALL_GARMENTS')} ▾
            </summary>
            <ul class="dropdown-content menu bg-base-100 rounded-box shadow-md z-20 w-56 mt-1">
              <li>
                <a href={ideasUrl({ ...state, capsuleId: undefined })}>
                  {t('gallery.ALL_GARMENTS')}
                </a>
              </li>
              {capsules.map((option) => (
                <li>
                  <a
                    href={ideasUrl({ ...state, capsuleId: option.id })}
                    aria-current={
                      option.id === capsule?.id ? 'true' : undefined
                    }
                  >
                    {option.name}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
        {styled && (
          <span class="badge badge-lg badge-soft badge-primary gap-1">
            {t('gallery.WITH', { name: styled.name ?? '' })}
            <a
              href={ideasUrl({ ...state, withId: undefined })}
              aria-label={t('gallery.WITHOUT')}
              class="link link-hover"
            >
              ✕
            </a>
          </span>
        )}
      </div>
    </div>
  );
}

function WeatherNote({ weather }: { weather: IdeasWeather }) {
  const { needs, unit } = weather;
  const notes = [
    needs.layer ? t('weather.TAKE_LAYER') : null,
    needs.rain ? t('gallery.RAIN') : null,
  ].filter((note) => note !== null);
  return (
    <p class="px-2 text-sm text-base-content/70" data-ideas-weather="">
      {t('gallery.FEELS', {
        range: t('weather.RANGE', {
          low: displayTemperature(needs.feelsLike.min, unit),
          high: displayTemperature(needs.feelsLike.max, unit),
          unit: UNIT_SYMBOLS[unit],
        }),
      })}
      {notes.map((note) => (
        <span> · {note}</span>
      ))}
    </p>
  );
}

export interface IdeaCardsModel {
  state: SeededState;
  planning: { day: IsoDate; occasion: Occasion };
  ideas: Idea<PoolGarment>[];
  weather: IdeasWeather | null;
  /** 1-based. */
  page: number;
  more: boolean;
}

/**
 * One page of cards and, when there are more, the sentinel that fetches
 * the next (`intersect`: it watches the strip's own scrolling, which
 * `revealed` does not). GET /outfits/ideas/more answers with this alone.
 */
export function IdeaCards({ model }: { model: IdeaCardsModel }) {
  return (
    <>
      {model.ideas.map((idea, index) => (
        <IdeaCard
          model={model}
          idea={idea}
          eager={model.page === 1 && index === 0}
        />
      ))}
      {model.more && (
        <div
          class="snap-center shrink-0 w-16 flex items-center justify-center"
          hx-get={ideasUrl(model.state, {
            path: '/outfits/ideas/more',
            page: model.page + 1,
          })}
          hx-trigger="intersect once"
          hx-swap="outerHTML"
          data-ideas-more=""
        >
          <span
            class="loading loading-dots loading-md text-base-content/40"
            aria-label={t('LOADING_MORE')}
          ></span>
        </div>
      )}
    </>
  );
}

/** The gallery's state as hidden fields: a write's redirect comes back to the same ideas. */
function StateFields({ state }: { state: SeededState }) {
  const { destination } = state;
  return (
    <>
      {destination.kind !== 'none' && (
        <input
          type="hidden"
          name="for"
          value={destinationTarget(destination)}
        />
      )}
      {destination.kind !== 'none' && destination.occasion && (
        <input type="hidden" name="occasion" value={destination.occasion} />
      )}
      {destination.kind === 'day' && destination.replace !== undefined && (
        <input
          type="hidden"
          name="replace"
          value={String(destination.replace)}
        />
      )}
      {state.capsuleId !== undefined && (
        <input type="hidden" name="capsule" value={String(state.capsuleId)} />
      )}
      {state.withId !== undefined && (
        <input type="hidden" name="with" value={String(state.withId)} />
      )}
      <input type="hidden" name="seed" value={String(state.seed)} />
    </>
  );
}

/** A card's primary action, by where the idea goes. */
function pickLabel(destination: OutfitDestination): string {
  switch (destination.kind) {
    case 'none':
      return t('gallery.PICK_SAVE');
    case 'trip':
      return t('gallery.PICK_TRIP');
    case 'day':
      return destination.replace === undefined
        ? t('gallery.PICK_DAY', {
            weekday: t(DAY_NAMES[dayOfWeek(destination.day)]),
          })
        : t('changeEntry.PICK');
  }
}

function IdeaCard(props: {
  model: IdeaCardsModel;
  idea: Idea<PoolGarment>;
  eager: boolean;
}) {
  const { model, idea } = props;
  const { destination } = model.state;
  const name = ideaName(idea.garments);
  const pairs = idea.garments.flatMap((a, i) =>
    idea.garments.slice(i + 1).map((b) => [a, b] as const),
  );
  return (
    <article
      class="snap-center shrink-0 w-full card bg-base-100 shadow-sm"
      data-idea={idea.garments.map((g) => g.id).join(',')}
    >
      <div class="card-body p-3 gap-3">
        <OutfitCollage garments={idea.garments} eager={props.eager} />
        <h2 class="font-semibold text-sm line-clamp-2">{name}</h2>
        <Reasons idea={idea} weather={model.weather !== null} />
        {/* One row: the pick, and "Not this" opening upward over the
            collage, so a whole card fits a phone screen above the dock. */}
        <div class="flex items-start gap-2">
          <PostForm action="/outfits/ideas/pick" class="flex-1" needsNetwork>
            {idea.garments.map((g) => (
              <input type="hidden" name="garmentId" value={String(g.id)} />
            ))}
            <StateFields state={model.state} />
            <button type="submit" class="btn btn-primary btn-sm w-full">
              {pickLabel(destination)}
            </button>
          </PostForm>
          <details class="dropdown dropdown-top dropdown-end">
            <summary class="btn btn-ghost btn-sm">
              {t('gallery.NOT_THIS')}
            </summary>
            <div class="dropdown-content bg-base-100 rounded-box shadow-md z-20 w-72 p-3 mb-1 flex flex-col gap-2">
              <div class="flex flex-wrap gap-2">
                {model.weather && (
                  <PostForm
                    action="/outfits/ideas/feedback"
                    class="contents"
                    needsNetwork
                  >
                    <StateFields state={model.state} />
                    <button
                      type="submit"
                      name="feeling"
                      value="too-warm"
                      class="btn btn-outline btn-xs"
                    >
                      {t('gallery.TOO_WARM')}
                    </button>
                    <button
                      type="submit"
                      name="feeling"
                      value="too-cold"
                      class="btn btn-outline btn-xs"
                    >
                      {t('gallery.TOO_COLD')}
                    </button>
                  </PostForm>
                )}
                {/* A dismissal only: nothing is stored. */}
                <button
                  type="button"
                  class="btn btn-outline btn-xs"
                  onclick="this.closest('[data-idea]').remove()"
                >
                  {t('gallery.NOT_TODAY')}
                </button>
              </div>
              <p class="text-xs text-base-content/60">
                {t('gallery.CLASHES_PROMPT')}
              </p>
              <div class="flex flex-wrap gap-2">
                {pairs.map(([a, b]) => (
                  // htmx removes the card on success; without script the
                  // same form posts natively and comes back to the gallery.
                  <form
                    method="post"
                    action="/outfits/ideas/avoid"
                    hx-post="/outfits/ideas/avoid"
                    hx-target="closest [data-idea]"
                    hx-swap="delete"
                    data-needs-network=""
                  >
                    <input
                      type="hidden"
                      name="garmentId"
                      value={String(a.id)}
                    />
                    <input
                      type="hidden"
                      name="garmentId"
                      value={String(b.id)}
                    />
                    <StateFields state={model.state} />
                    <button type="submit" class="btn btn-outline btn-xs">
                      {t('gallery.PAIR', {
                        a: a.name ?? '',
                        b: b.name ?? '',
                      })}
                    </button>
                  </form>
                ))}
              </div>
            </div>
          </details>
        </div>
      </div>
    </article>
  );
}

/**
 * Why this idea: how it meets the weather and the occasion, and what the
 * rotation brought back. Today's cards show it too (src/web/today).
 */
export function Reasons({
  idea,
  weather,
}: {
  idea: Idea<PoolGarment>;
  weather: boolean;
}) {
  const rested = idea.garments
    .filter((g) => idea.rested.includes(g.id) && g.name)
    .map((g) => g.name)
    .slice(0, 2);
  const chips = [
    ...idea.problems.map((problem) => ({
      text: t(`gallery.problem.${problem}`),
      tone: 'badge-warning',
    })),
    ...(weather && idea.problems.length === 0
      ? [{ text: t('gallery.FITS_WEATHER'), tone: 'badge-success' }]
      : []),
    ...(rested.length > 0
      ? [
          {
            text: t('gallery.RESTED', { names: rested.join(', ') }),
            tone: 'badge-ghost',
          },
        ]
      : []),
  ];
  if (chips.length === 0) return null;
  return (
    <ul class="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <li class={`badge badge-sm badge-soft ${chip.tone} h-auto py-0.5`}>
          {chip.text}
        </li>
      ))}
    </ul>
  );
}
