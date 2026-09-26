import { t } from '../i18n';
import { capsuleUrl, wardrobeUrl } from './urls';

/**
 * The wardrobe page's two views, Garments (the grid) and Capsules (the
 * list, src/web/capsules): plain boosted links, so the dock keeps its size
 * (plan section 2). Both carry `?ownerId=` in a shared wardrobe, so a
 * grantee moves between the grantor's garments and capsules.
 */
export function WardrobeTabs(props: {
  active: 'garments' | 'capsules';
  viewOwner: number | undefined;
}) {
  const tab = (name: 'garments' | 'capsules', href: string, label: string) => (
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
    </div>
  );
}
