import { Type } from '@sinclair/typebox';
import { t } from '../i18n';
import { LinkTabs } from '../layout/link-tabs';

/**
 * Which of the owner's outfits a saved-outfit list shows (#659): the ones
 * someone kept (keptOutfit: a person's or the agent's, and one-offs they
 * adopted) or the rest, "Worn and planned" (the planner's and the ideas
 * picked for a day or a trip). The Saved tab, the calendar's plan page and
 * a trip's add page, all through savedOutfitsSql.
 */
export const OUTFIT_LISTS = ['kept', 'one-offs'] as const;
export type OutfitList = (typeof OUTFIT_LISTS)[number];

/** The lists' querystring field, spread into each page's schema: navigation state, so lenient. */
export const OutfitListQuery = { show: Type.Optional(Type.String()) };

/** `?show=one-offs` is the segment; anything else, or nothing, is the kept list (never a 400). */
export function parseOutfitList(show: string | undefined): OutfitList {
  return show === 'one-offs' ? 'one-offs' : 'kept';
}

/**
 * `href` with the list's field set: the kept list is the bare address, so
 * the Saved tab's root stays byte-stable.
 */
export function withOutfitList(href: string, list: OutfitList): string {
  if (list === 'kept') return href;
  return `${href}${href.includes('?') ? '&' : '?'}show=one-offs`;
}

/**
 * The two lists as link tabs above a saved-outfit list. `href` is the
 * page's own address without `show` (its destination kept), so switching
 * keeps what the page was picking for.
 */
export function OutfitListTabs(props: { list: OutfitList; href: string }) {
  return (
    <LinkTabs
      active={props.list}
      class="tabs tabs-border tabs-sm mx-2"
      tabs={[
        {
          name: 'kept',
          href: withOutfitList(props.href, 'kept'),
          label: t('outfits.LIST_KEPT'),
        },
        {
          name: 'one-offs',
          href: withOutfitList(props.href, 'one-offs'),
          label: t('outfits.LIST_ONE_OFFS'),
        },
      ]}
    />
  );
}
