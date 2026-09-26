import { t } from '../i18n';

/**
 * An inline click handler: copies the button's `data-copy` to the clipboard
 * and flashes the button green for a second. `resting` is the class it wears
 * otherwise. The copied text reaches the handler as a data attribute, never
 * spliced into its source. Also the wardrobe-share invite link's copy button.
 */
export function copyAndFlash(resting: 'btn-outline' | 'btn-ghost'): string {
  return `navigator.clipboard.writeText(this.dataset.copy).then(() => { this.classList.replace('${resting}', 'btn-success'); setTimeout(() => this.classList.replace('btn-success', '${resting}'), 1000); })`;
}

/**
 * Copies the public share link of a garment or outfit (the /share page,
 * src/web/share/routes.tsx) on SITE_URL, and flashes to say so.
 */
export function ShareLinkButton(props: {
  siteUrl: string;
  type: 'garment' | 'outfit';
  shareableId: string;
  class?: string;
}) {
  const params = new URLSearchParams({
    shareableId: props.shareableId,
    type: props.type,
  });
  return (
    <button
      type="button"
      class={`btn btn-outline btn-sm ${props.class ?? ''}`}
      data-copy={`${props.siteUrl}/share?${params}`}
      onclick={copyAndFlash('btn-outline')}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="1.5"
        stroke="currentColor"
        class="size-4"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.935-2.185 2.25 2.25 0 0 0-3.935 2.185Z"
        />
      </svg>
      {t('SHARE')}
    </button>
  );
}
