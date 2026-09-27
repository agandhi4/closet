import { t } from '../i18n';
import { capsuleUrl, wardrobeUrl, WISHLIST_PATH } from './urls';

export type WardrobeTab = 'garments' | 'capsules' | 'wishlist';

/**
 * The wardrobe page's views, Garments (the grid), Capsules (the list,
 * src/web/capsules) and Wishlist (src/web/wishlist): plain boosted links,
 * so the dock keeps its size (plan section 2; the redesign's Wardrobe tabs,
 * docs/plans/2026-09-26-redesign.md). All carry `?ownerId=` in a shared
 * wardrobe, so a grantee moves between the grantor's garments, capsules and
 * wishlist.
 */
export function WardrobeTabs(props: {
  active: WardrobeTab;
  viewOwner: number | undefined;
}) {
  const tab = (name: WardrobeTab, href: string, label: string) => (
    <a
      role="tab"
      href={href}
      class={props.active === name ? 'tab tab-active' : 'tab'}
      aria-selected={props.active === name ? 'true' : 'false'}
    >
      {label}
    </a>
  );
  return (
    <div role="tablist" class="tabs tabs-box tabs-sm mb-4 mx-2">
      {tab('garments', wardrobeUrl(props.viewOwner), t('GARMENTS'))}
      {tab('capsules', capsuleUrl(undefined, props.viewOwner), t('CAPSULES'))}
      {tab(
        'wishlist',
        wardrobeUrl(props.viewOwner, {}, WISHLIST_PATH),
        t('wishlist.TAB'),
      )}
    </div>
  );
}
