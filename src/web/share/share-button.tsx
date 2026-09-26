import { t } from '../i18n';

// The link reaches the script as a data attribute, never spliced into the
// hyperscript source.
const COPY_SHARE_LINK = `on click
   call navigator.clipboard.writeText(@data-share-url)
   then add .btn-success then remove .btn-outline
   wait 1s
   then remove .btn-success then add .btn-outline`;

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
      data-share-url={`${props.siteUrl}/share?${params}`}
      _={COPY_SHARE_LINK}
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
