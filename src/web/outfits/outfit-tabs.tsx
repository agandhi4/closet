import { t } from '../i18n';
import { ideasUrl } from '../gallery/urls';
import type { DayDestination } from './destination';
import { savedUrl } from './urls';

export type OutfitsTab = 'saved' | 'ideas';

/**
 * The Outfits page's views: Saved (the grid, `/outfits`) and Ideas (the
 * gallery, src/web/gallery): plain boosted links, like the Wardrobe's tabs
 * (the redesign's "Outfits › Saved / Ideas", #43). A day being planned
 * (`?for=day:`) travels between the two, so "+ Plan" can go either way
 * and still come back to the day. Without one the tabs are static on
 * purpose: `/outfits` is a stale-while-revalidate tab root and must render
 * the same bytes while nothing changes.
 */
export function OutfitTabs(props: {
  active: OutfitsTab;
  destination?: DayDestination;
}) {
  const { active } = props;
  const destination = props.destination ?? { kind: 'none' };
  const tab = (name: OutfitsTab, href: string, label: string) => (
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
    <div role="tablist" class="tabs tabs-box tabs-sm mb-4 mx-2">
      {tab('saved', savedUrl(destination), t('gallery.TAB_SAVED'))}
      {tab('ideas', ideasUrl({ destination }), t('gallery.TAB_IDEAS'))}
    </div>
  );
}
