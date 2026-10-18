/**
 * A bar of view tabs that are plain boosted links (the Wardrobe's, the
 * Outfits page's and the Calendar's): the one writer of a link tab's role,
 * its lit class and `aria-selected` (`@link-tabs`, scripts/ci/guards.conf).
 * A `false` entry is a tab left out (Laundry in a shared wardrobe).
 */
export function LinkTabs<T extends string>(props: {
  active: T;
  tabs: readonly ({ name: T; href: string; label: string } | false)[];
  class: string;
  id?: string;
}) {
  return (
    <div role="tablist" class={props.class} id={props.id}>
      {props.tabs.map(
        (tab) =>
          tab && (
            <a
              role="tab"
              href={tab.href}
              class={props.active === tab.name ? 'tab tab-active' : 'tab'}
              aria-selected={props.active === tab.name ? 'true' : 'false'}
            >
              {tab.label}
            </a>
          ),
      )}
    </div>
  );
}
