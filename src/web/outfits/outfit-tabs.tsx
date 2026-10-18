import { t } from '../i18n';
import { ideasUrl } from '../gallery/urls';
import { LinkTabs } from '../layout/link-tabs';
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
  const destination = props.destination ?? { kind: 'none' };
  return (
    <LinkTabs
      active={props.active}
      class="tabs tabs-box tabs-sm mb-4 mx-2"
      tabs={[
        {
          name: 'saved',
          href: savedUrl(destination),
          label: t('gallery.TAB_SAVED'),
        },
        {
          name: 'ideas',
          href: ideasUrl({ destination }),
          label: t('gallery.TAB_IDEAS'),
        },
      ]}
    />
  );
}
