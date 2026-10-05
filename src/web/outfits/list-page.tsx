import type { Child } from 'hono/jsx';
import { PostForm } from '../auth/form';
import { type DayChoice, plannedNote } from '../calendar/day-choice';
import { shortDayLabel } from '../calendar/labels';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { OUTFIT_GRID } from '../layout/columns';
import { PageMain } from '../layout/page-main';
import { EmptyState } from '../layout/parts';
import {
  LOOKS_INIT,
  LookSaveAction,
  LookStripTile,
  LooksStrip,
} from '../plans/look-tile';
import type { ShownLooks } from '../plans/looks';
import { planUrl } from '../plans/urls';
import { stylingUrl } from '../styling/urls';
import type { ViewContext } from '../view-context';
import { OutfitCollage } from './collage';
import { DayDestinationLine } from './day-destination';
import type { DayDestination } from './destination';
import { OutfitTabs } from './outfit-tabs';
import type { OutfitActivity, GarmentOutfit } from './queries';
import { buyFirstNote, toBuyLine } from './to-buy';
import { outfitUrl } from './urls';

/** Tiles above the fold on a phone (two rows of two): their images load at once. */
const EAGER_TILES = 4;

export interface SavedModel {
  /** Every outfit of the owner's, newest first. */
  outfits: GarmentOutfit[];
  /** Worn counts and next plans, by outfit id (absent: never planned). */
  activity: Map<number, OutfitActivity>;
  /**
   * `?for=day:` (R5): the grid picks an outfit for that day (the
   * calendar's "Pick a saved outfit"). `destination` carries `replace`
   * only while that entry can still change (pickDestination).
   */
  picking?: { destination: DayDestination; choice: DayChoice };
  /**
   * The strip of the plan shown above the grid (loved first, none
   * declined; looksOfShownPlan picks the plan); no looks hides the row.
   * `draftedBy` names the agent when it is a draft. Never read while picking.
   */
  planLooks: ShownLooks;
}

/**
 * GET /outfits, the Outfits page's Saved tab (redesign plan, "Outfits"):
 * every outfit as a two-column grid of collage tiles (OutfitCollage `tile`),
 * with its name, how often it was worn and when it is next planned. You
 * search what you saved, so it is a grid; Ideas, one idea at a time, is a
 * strip. A tile opens the outfit, where Plan picks a day; the per-card
 * calendar dropdown is gone (R5).
 *
 * With `?for=day:D&occasion=O[&replace=E]` the grid picks for that day: one
 * native PostForm to POST /calendar (as the plan page's list), each tile a
 * submit button; an outfit already on the day is disabled and says for
 * which occasion, and an incomplete one (a piece not bought yet, #335) says
 * to buy it first. Without a query the page is a stale-while-revalidate tab
 * root: it renders the same bytes while nothing changes (the activity line
 * depends on the day, never the hour).
 */
export function OutfitsPage(props: { ctx: ViewContext; model: SavedModel }) {
  const { ctx, model } = props;
  const destination = model.picking?.destination;
  return (
    <Layout ctx={ctx} title={t('OUTFITS')}>
      <AppBar
        ctx={ctx}
        title={t('OUTFITS')}
        actions={
          <a href={stylingUrl({ destination })} class="btn btn-primary btn-sm">
            + {t('styling.NEW')}
          </a>
        }
      />
      <PageMain width="wide" class="p-4 pt-20 pb-24 flex flex-col gap-3">
        <OutfitTabs active="saved" destination={destination} />
        {model.picking && (
          <PickingHeader destination={model.picking.destination} />
        )}
        <PlanLooksRow {...model.planLooks} />
        {model.outfits.length === 0 ? (
          <NoOutfits destination={destination} />
        ) : model.picking ? (
          <PickingGrid model={model} picking={model.picking} />
        ) : (
          <ul id="saved-outfits" class={OUTFIT_GRID}>
            {model.outfits.map((outfit, index) => (
              <li>
                <a
                  href={outfitUrl(outfit.id)}
                  class="flex flex-col gap-1.5"
                  data-outfit-id={outfit.id}
                >
                  <OutfitTile
                    outfit={outfit}
                    eager={index < EAGER_TILES}
                    line={
                      toBuyLine(outfit.garments) ??
                      activityLine(model.activity.get(outfit.id))
                    }
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </PageMain>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * "From your plan": the shown plan's looks as the plan page draws them
 * (LooksStrip, LookFace), each with Save as outfit while every piece is
 * owned (or the outfit it became). Edge to edge like the plan page's;
 * nothing without looks. Static markup: the strip's bytes change only when
 * a look does, so the tab root stays stable.
 */
function PlanLooksRow({ looks, draftedBy }: ShownLooks) {
  if (looks.length === 0) return null;
  return (
    <div class="-mx-4 mb-2">
      <LooksStrip
        id="plan-looks"
        title={t('outfits.FROM_PLAN_TITLE')}
        count={looks.length}
        hint={
          draftedBy === null ? (
            t('outfits.FROM_PLAN_HINT')
          ) : (
            <>
              {t('outfits.FROM_DRAFT_HINT', { name: draftedBy })}{' '}
              <a class="link" href={planUrl(looks[0].planId)}>
                {t('outfits.FROM_DRAFT_LINK')}
              </a>
            </>
          )
        }
      >
        {looks.map((look, index) => (
          <LookStripTile look={look} selected={index === 0} eager={index < 2}>
            <div class="mt-1">
              <LookSaveAction look={look} />
            </div>
          </LookStripTile>
        ))}
      </LooksStrip>
      <script type="module" dangerouslySetInnerHTML={{ __html: LOOKS_INIT }} />
    </div>
  );
}

/** What the grid is picking for, the way back, and that picking needs a connection. */
function PickingHeader({ destination }: { destination: DayDestination }) {
  return (
    <div class="flex flex-col gap-2 px-2">
      <DayDestinationLine destination={destination} />
      <p class="text-sm text-muted">{t('outfits.PICK_PROMPT')}</p>
      <p
        data-offline-note=""
        class="alert alert-warning alert-soft py-2 text-sm"
        role="note"
      >
        {t('outfits.OFFLINE_PICK')}
      </p>
    </div>
  );
}

/**
 * The grid as one form: a tap on a tile posts its outfit for the day, and
 * POST /calendar answers with the week (or, with `replace`, puts it in that
 * entry's place, replaceEntryOutfit). Each tile is its name's submit
 * button stretched over the tile (the stretched-link pattern: a button may
 * hold only phrasing content, and the collage is blocks).
 */
function PickingGrid(props: {
  model: SavedModel;
  picking: NonNullable<SavedModel['picking']>;
}) {
  const { model, picking } = props;
  const { destination, choice } = picking;
  return (
    <PostForm action="/calendar" needsNetwork>
      <input type="hidden" name="date" value={destination.day} />
      <input type="hidden" name="occasion" value={destination.occasion} />
      <input type="hidden" name="week" value={destination.day} />
      {destination.replace !== undefined && (
        <input
          type="hidden"
          name="replace"
          value={String(destination.replace)}
        />
      )}
      <ul id="saved-outfits" class={OUTFIT_GRID}>
        {model.outfits.map((outfit, index) => {
          // Already on the day, or incomplete (#335): it cannot be picked.
          const note =
            plannedNote(choice, outfit.id) ?? buyFirstNote(outfit.garments);
          return (
            <li class="relative" data-outfit-id={outfit.id}>
              <OutfitTile
                outfit={outfit}
                eager={index < EAGER_TILES}
                line={note ?? activityLine(model.activity.get(outfit.id))}
                dimmed={note !== undefined}
                name={
                  <button
                    type="submit"
                    name="outfitId"
                    value={String(outfit.id)}
                    class="block w-full text-left truncate after:absolute after:inset-0 after:rounded-box focus-visible:after:outline-2 focus-visible:after:outline-primary"
                    disabled={note !== undefined}
                  >
                    {outfitName(outfit)}
                  </button>
                }
              />
            </li>
          );
        })}
      </ul>
    </PostForm>
  );
}

/**
 * One tile: the collage on the plinth, the name and a line under it (the
 * activity, or why it cannot be picked). `name` replaces the plain name
 * where the name is the control (the picking grid's button). A disabled
 * tile dims its collage only: text is never dimmed (Conventions).
 */
function OutfitTile(props: {
  outfit: GarmentOutfit;
  eager: boolean;
  line: string | undefined;
  dimmed?: boolean;
  name?: Child;
}) {
  const { outfit, line } = props;
  return (
    <>
      <div class={props.dimmed ? 'opacity-50' : undefined}>
        <OutfitCollage
          garments={outfit.garments}
          size="tile"
          eager={props.eager}
        />
      </div>
      <span class="flex flex-col min-w-0 px-0.5">
        <span class="text-sm font-medium truncate">
          {props.name ?? outfitName(outfit)}
        </span>
        {line && <span class="text-xs text-muted truncate">{line}</span>}
      </span>
    </>
  );
}

/** "Planned Oct 3 · Worn 4×", what is known; undefined for neither. */
function activityLine(
  activity: OutfitActivity | undefined,
): string | undefined {
  if (!activity) return undefined;
  const parts = [
    activity.nextPlanned &&
      t('outfits.PLANNED_ON', { day: shortDayLabel(activity.nextPlanned) }),
    activity.wornCount > 0 &&
      t('outfits.WORN_TIMES', { count: activity.wornCount }),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function outfitName(outfit: GarmentOutfit): string {
  return outfit.name || t('UNTITLED_OUTFIT');
}

/** No outfit saved yet: the way to style the first (for the day being planned, if any). */
function NoOutfits({
  destination,
}: {
  destination: DayDestination | undefined;
}) {
  return (
    <EmptyState
      message={t('NO_OUTFITS')}
      icon={
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1"
          stroke="currentColor"
          class="size-16"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
          />
        </svg>
      }
    >
      <a href={stylingUrl({ destination })} class="btn btn-primary btn-sm">
        {t('ADD_FIRST_OUTFIT')}
      </a>
    </EmptyState>
  );
}
