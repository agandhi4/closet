import { t } from '../i18n';
import { IDEAS_PATH } from '../gallery/urls';

export type OutfitsTab = 'saved' | 'ideas';

/**
 * The Outfits page's views: Saved (the list, `/outfits`) and Ideas (the
 * gallery, src/web/gallery): plain boosted links, like the Wardrobe's tabs
 * (the redesign's "Outfits › Saved / Ideas"; the dock's naming is still the
 * owner's call in #43, so the labels are catalog strings only). Static on
 * purpose: `/outfits` is a stale-while-revalidate tab root and must render
 * the same bytes while nothing changes.
 */
export function OutfitTabs({ active }: { active: OutfitsTab }) {
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
      {tab('saved', '/outfits', t('gallery.TAB_SAVED'))}
      {tab('ideas', IDEAS_PATH, t('gallery.TAB_IDEAS'))}
    </div>
  );
}
