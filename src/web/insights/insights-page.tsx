import type { Child } from 'hono/jsx';
import {
  type Breakdown,
  type CostPerWear,
  type InsightGarment,
  LEAST_WORN_MIN_OWNED_DAYS,
  UNWORN_CHOICES,
  UNWORN_SHOWN,
  type UnwornDays,
  type WardrobeInsights,
} from '../../wardrobe/insights';
import type { IsoDate } from '../calendar/calendar-date';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, EmptyState, GarmentThumb } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import { relativeDay } from '../wears/wear-section';
import { styleThisUrl } from '../styling/urls';
import { insightsUrl, NEEDS_ATTENTION_URL } from './urls';

export interface InsightsPageModel {
  insights: WardrobeInsights;
  /** The household's today (APP_TIMEZONE): "last worn 3 days ago". */
  today: IsoDate;
}

/**
 * GET /wardrobe/insights (#17): how the closet is actually used. Phone
 * first, one column of cards: worn lately (30, 90, 365 days), what needs
 * attention, what has not been worn (with "Style this"), most and least
 * worn, cost per wear, the pairs worn together, the colours, categories
 * and brands. Every figure is src/wardrobe/insights.ts's; the page only
 * lays them out. The owner's own, like wears.
 */
export function InsightsPage(props: {
  ctx: ViewContext;
  model: InsightsPageModel;
}) {
  const { ctx, model } = props;
  const { insights } = model;
  return (
    <Layout ctx={ctx} title={t('insights.TITLE')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 sm:max-w-lg sm:mx-auto flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <BackLink href="/wardrobe" />
          <div class="flex-1 min-w-0">
            <h1 class="text-2xl font-bold">{t('insights.TITLE')}</h1>
            <p class="text-sm text-base-content/60">{t('insights.INTRO')}</p>
          </div>
        </div>
        {insights.closet.garments === 0 ? (
          <EmptyState message={t('insights.EMPTY')}>
            <a href="/wardrobe/new" class="btn btn-primary btn-sm">
              + {t('NEW_GARMENT')}
            </a>
          </EmptyState>
        ) : (
          <Figures model={model} />
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

function Figures({ model }: { model: InsightsPageModel }) {
  const { insights, today } = model;
  const { condition } = insights;
  return (
    <>
      <p class="text-sm" id="insights-closet">
        {t('insights.CLOSET_SIZE', insights.closet)}
      </p>
      {insights.recentWearDays === 0 && (
        <p class="alert text-sm" id="insights-no-wears">
          {t('insights.NO_WEARS')}
        </p>
      )}
      <WornLately insights={insights} />
      {condition.needsRepair + condition.replaceSoon > 0 && (
        <Card id="insights-attention" title={t('insights.ATTENTION')}>
          <p class="text-sm">
            {[
              condition.needsRepair > 0 &&
                t('insights.NEEDS_REPAIR', { count: condition.needsRepair }),
              condition.replaceSoon > 0 &&
                t('insights.REPLACE_SOON', { count: condition.replaceSoon }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <a href={NEEDS_ATTENTION_URL} class="btn btn-outline btn-sm">
            {t('insights.ATTENTION')}
          </a>
        </Card>
      )}
      <Unworn insights={insights} today={today} />
      {insights.mostWorn.length > 0 && (
        <Card id="insights-most-worn" title={t('insights.MOST_WORN')}>
          <GarmentList rows={wornRows(insights.mostWorn, today)} />
        </Card>
      )}
      {/* Empty while every garment is newer than the threshold. */}
      {insights.leastWorn.length > 0 && (
        <Card id="insights-least-worn" title={t('insights.LEAST_WORN')}>
          <p class="text-xs text-base-content/60">
            {t('insights.LEAST_WORN_NOTE', {
              days: LEAST_WORN_MIN_OWNED_DAYS,
            })}
          </p>
          <GarmentList rows={wornRows(insights.leastWorn, today)} />
        </Card>
      )}
      <Cost cost={insights.cost} />
      <Pairs insights={insights} />
      <Colours insights={insights} />
      <Card id="insights-categories" title={t('insights.CATEGORIES')}>
        <BreakdownList
          rows={insights.categories}
          label={(key) => categoryLabel(key!)}
        />
      </Card>
      {insights.brands.length > 0 && (
        <Card id="insights-brands" title={t('insights.BRANDS')}>
          <BreakdownList
            rows={insights.brands}
            label={(key) => key ?? t('insights.OTHER_BRANDS')}
          />
          {insights.unbranded > 0 && (
            <p class="text-xs text-base-content/60">
              {t('insights.UNBRANDED', { count: insights.unbranded })}
            </p>
          )}
        </Card>
      )}
    </>
  );
}

function Card(props: { id: string; title: string; children: Child }) {
  return (
    <section class="card bg-base-100 shadow-sm" id={props.id}>
      <div class="card-body p-3 gap-2">
        <h2 class="font-semibold">{props.title}</h2>
        {props.children}
      </div>
    </section>
  );
}

function WornLately({ insights }: { insights: WardrobeInsights }) {
  return (
    <Card id="insights-worn" title={t('insights.WORN_LATELY')}>
      <div class="grid grid-cols-3 gap-2 text-center">
        {insights.worn.map((share) => (
          <div class="rounded-box bg-base-200 p-2" data-window={share.days}>
            <p class="text-2xl font-bold" data-percent>
              {share.percent}%
            </p>
            <p class="text-xs">
              {t('insights.WORN_OF', { worn: share.worn, total: share.total })}
            </p>
            <p class="text-xs text-base-content/60">
              {t('insights.WORN_WINDOW', { days: share.days })}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Unworn(props: { insights: WardrobeInsights; today: IsoDate }) {
  const { days, garments } = props.insights.unworn;
  const shown = garments.slice(0, UNWORN_SHOWN);
  return (
    <Card id="insights-unworn" title={t('insights.UNWORN')}>
      <nav
        class="flex items-center gap-2 flex-wrap"
        aria-label={t('insights.UNWORN_FOR')}
      >
        {UNWORN_CHOICES.map((choice: UnwornDays) => (
          <a
            href={`${insightsUrl(choice)}#insights-unworn`}
            class={`btn btn-xs ${choice === days ? 'btn-primary' : 'btn-ghost'}`}
            aria-current={choice === days ? 'true' : undefined}
          >
            {t('insights.UNWORN_DAYS', { days: choice })}
          </a>
        ))}
      </nav>
      <p class="text-sm" data-unworn-count={garments.length}>
        {garments.length === 0
          ? t('insights.UNWORN_NONE', { days })
          : t('insights.UNWORN_COUNT', { days, count: garments.length })}
      </p>
      <GarmentList
        rows={shown.map((garment) => ({
          garment,
          detail:
            garment.lastWorn === null
              ? t('insights.NEVER_WORN')
              : t('insights.LAST_WORN', {
                  when: relativeDay(garment.lastWorn, props.today),
                }),
        }))}
        action={(g) => (
          <a href={styleThisUrl(g.id)} class="btn btn-outline btn-xs">
            {t('gallery.STYLE_THIS')}
          </a>
        )}
      />
      {garments.length > shown.length && (
        <p class="text-xs text-base-content/60">
          {t('insights.UNWORN_MORE', { count: garments.length - shown.length })}
        </p>
      )}
    </Card>
  );
}

/** "Worn 12 times · last worn 3 days ago"; "Not worn yet". */
function wornDetail(garment: InsightGarment, today: IsoDate): string {
  if (garment.lastWorn === null) return t('wear.NOT_WORN');
  return [
    garment.wearDays === 1
      ? t('wear.WORN_ONCE')
      : t('wear.WORN_TIMES', { count: garment.wearDays }),
    t('wear.LAST_WORN', { when: relativeDay(garment.lastWorn, today) }),
  ].join(' · ');
}

function garmentName(garment: InsightGarment): string {
  return garment.name ?? categoryLabel(garment.category);
}

/** A row per garment: its thumb and name (linking to its page), a line, an action. */
function GarmentList(props: {
  rows: { garment: InsightGarment; detail: string }[];
  action?: (garment: InsightGarment) => Child;
}) {
  if (props.rows.length === 0) return null;
  return (
    <ul class="flex flex-col gap-2">
      {props.rows.map(({ garment, detail }) => (
        <li class="flex items-center gap-3" data-garment-id={garment.id}>
          <a
            href={garmentUrl(garment.id, undefined)}
            class="flex items-center gap-3 flex-1 min-w-0"
          >
            <GarmentThumb garment={garment} class="rounded-box shrink-0" />
            <span class="flex flex-col min-w-0">
              <span class="font-medium truncate">{garmentName(garment)}</span>
              <span class="text-xs text-base-content/60">{detail}</span>
            </span>
          </a>
          {props.action?.(garment)}
        </li>
      ))}
    </ul>
  );
}

/** Garments with the worn line. */
function wornRows(garments: InsightGarment[], today: IsoDate) {
  return garments.map((garment) => ({
    garment,
    detail: wornDetail(garment, today),
  }));
}

function perWearLine(entry: CostPerWear): string {
  const cost = priceLabel(entry.cost);
  if (entry.perWear === null) return t('insights.NOT_WORN_LINE', { cost });
  const perWear = priceLabel(entry.perWear);
  return entry.garment.wearDays === 1
    ? t('insights.PER_WEAR_ONCE', { perWear })
    : t('insights.PER_WEAR_LINE', {
        perWear,
        cost,
        days: entry.garment.wearDays,
      });
}

function CostList(props: {
  id: string;
  title: string;
  entries: CostPerWear[];
}) {
  if (props.entries.length === 0) return null;
  return (
    <div id={props.id}>
      <h3 class="text-sm text-base-content/60 mb-1">{props.title}</h3>
      <GarmentList
        rows={props.entries.map((entry) => ({
          garment: entry.garment,
          detail: perWearLine(entry),
        }))}
      />
    </div>
  );
}

function Cost({ cost }: { cost: WardrobeInsights['cost'] }) {
  return (
    <Card id="insights-cost" title={t('insights.COST_PER_WEAR')}>
      {cost.priced === 0 ? (
        <p class="text-sm text-base-content/60">{t('insights.NO_PRICES')}</p>
      ) : (
        <>
          <p class="text-xs text-base-content/60">{t('insights.COST_INTRO')}</p>
          <p class="text-sm" data-closet-value={cost.closetValue}>
            {t('insights.CLOSET_VALUE', {
              total: priceLabel(cost.closetValue),
            })}
            {cost.unpriced > 0 &&
              ` · ${t('insights.UNPRICED', { count: cost.unpriced })}`}
          </p>
          <CostList
            id="insights-best-value"
            title={t('insights.BEST_VALUE')}
            entries={cost.best}
          />
          <CostList
            id="insights-most-per-wear"
            title={t('insights.MOST_PER_WEAR')}
            entries={cost.worst}
          />
          <CostList
            id="insights-not-worn-yet"
            title={t('insights.NOT_WORN_YET', {
              count: cost.notWornYetCount,
            })}
            entries={cost.notWornYet}
          />
        </>
      )}
    </Card>
  );
}

function Pairs({ insights }: { insights: WardrobeInsights }) {
  return (
    <Card id="insights-pairs" title={t('insights.PAIRS')}>
      {insights.pairs.length === 0 ? (
        <p class="text-sm text-base-content/60">{t('insights.PAIRS_NONE')}</p>
      ) : (
        <>
          <p class="text-xs text-base-content/60">
            {t('insights.PAIRS_INTRO')}
          </p>
          <ul class="flex flex-col gap-3">
            {insights.pairs.map(({ a, b, days }) => (
              <li
                class="flex items-center gap-2"
                data-pair={`${a.id}-${b.id}`}
                data-days={days}
              >
                {[a, b].map((garment) => (
                  <a href={garmentUrl(garment.id, undefined)} class="shrink-0">
                    <GarmentThumb garment={garment} class="rounded-box" />
                  </a>
                ))}
                <span class="flex flex-col min-w-0 text-sm">
                  <span class="truncate">{garmentName(a)}</span>
                  <span class="truncate">{garmentName(b)}</span>
                  <span class="text-xs text-base-content/60">
                    {t('insights.PAIR_DAYS', { count: days })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

type ColourShare = WardrobeInsights['colours'][number];

/**
 * The palette: the closet's colours and the worn ones as strips, each
 * segment as wide as its share (flex-grow over a zero basis, so rounding
 * never overflows the strip), coloured by the garment form's swatch
 * classes (main.css, `.ms-swatch--<colour>`); the legend says it in words.
 */
function Colours({ insights }: { insights: WardrobeInsights }) {
  if (insights.colours.length === 0) return null;
  return (
    <Card id="insights-colours" title={t('insights.COLOURS')}>
      <Strip
        name="closet"
        title={t('insights.COLOURS_CLOSET')}
        colours={insights.colours}
        share={(colour) => colour.closet}
      />
      {insights.recentWearDays > 0 && (
        <Strip
          name="worn"
          title={t('insights.COLOURS_WORN')}
          colours={insights.colours}
          share={(colour) => colour.worn}
        />
      )}
      <ul class="flex flex-col gap-1 text-xs">
        {insights.colours.map((colour) => (
          <li class="flex items-center gap-2">
            <span
              class={`size-3 shrink-0 rounded-full ring-1 ring-base-300 ms-swatch--${colour.colour}`}
            />
            <span>
              <span class="capitalize font-medium">{colour.colour}</span>{' '}
              {t('insights.COLOUR_SHARE', {
                closet: colour.closet,
                worn: colour.worn,
              })}
            </span>
          </li>
        ))}
      </ul>
      {insights.uncoloured > 0 && (
        <p class="text-xs text-base-content/60">
          {t('insights.UNCOLOURED', { count: insights.uncoloured })}
        </p>
      )}
    </Card>
  );
}

function Strip(props: {
  name: string;
  title: string;
  colours: ColourShare[];
  share: (colour: ColourShare) => number;
}) {
  const { share } = props;
  return (
    <div data-strip={props.name}>
      <h3 class="text-sm text-base-content/60 mb-1">{props.title}</h3>
      <div
        class="flex h-5 w-full rounded-full overflow-hidden ring-1 ring-base-300"
        role="img"
        aria-label={props.title}
      >
        {props.colours
          .filter((colour) => share(colour) > 0)
          .map((colour) => (
            <span
              class={`basis-0 ms-swatch--${colour.colour}`}
              style={`flex-grow:${share(colour)}`}
              title={`${colour.colour} ${share(colour)}%`}
              data-colour={colour.colour}
              data-share={share(colour)}
            />
          ))}
      </div>
    </div>
  );
}

function BreakdownList(props: {
  rows: Breakdown[];
  label: (key: string | null) => string;
}) {
  return (
    <ul class="flex flex-col gap-2">
      {props.rows.map((row) => (
        <li data-key={row.key ?? ''}>
          <div class="flex items-baseline justify-between gap-2 text-sm">
            <span class="font-medium truncate">{props.label(row.key)}</span>
            <span class="text-xs text-base-content/60 shrink-0">
              {row.closet}%
            </span>
          </div>
          <p class="text-xs text-base-content/60">{breakdownLine(row)}</p>
          <progress
            class="progress progress-primary w-full"
            value={String(row.worn)}
            max="100"
            aria-label={breakdownLine(row)}
          />
        </li>
      ))}
    </ul>
  );
}

/** "12 garments · 14 pieces · 30% of wears". */
function breakdownLine(row: Breakdown): string {
  return t('insights.BREAKDOWN_LINE', {
    garments: row.garments,
    pieces: row.pieces,
    worn: row.worn,
  });
}
