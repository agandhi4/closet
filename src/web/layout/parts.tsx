import type { Child } from 'hono/jsx';
import { type ImageRef, imageUrl } from '../files/image-url';
import { jsonForScript } from '../html';
import { t } from '../i18n';

/**
 * Small pieces the garment, outfit and share pages have in common: the
 * placeholder for a garment without a photo, a garment thumbnail, the back
 * link and an empty-list state.
 */

/** The stand-in for a garment without a photo. */
export function HangerIcon(props: { class: string; strokeWidth: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width={props.strokeWidth}
      stroke="currentColor"
      class={props.class}
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M9 3.75H6.912a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H15M2.25 13.5h3.86a2.251 2.251 0 0 1 2.012 1.244l.256.512a2.251 2.251 0 0 0 2.013 1.244h3.218a2.251 2.251 0 0 0 2.013-1.244l.256-.512a2.251 2.251 0 0 1 2.013-1.244h3.859M12 3v8.25m0 0-3-3m3 3 3-3"
      />
    </svg>
  );
}

/** Taking a photo with the camera: the garment photo form, outfit selfies. */
export function CameraIcon(props: { class: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class={props.class}
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.174C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-6.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
      />
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z"
      />
    </svg>
  );
}

/** Choosing a photo already taken (the library): outfit selfies. */
export function PhotoLibraryIcon(props: { class: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class={props.class}
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
      />
    </svg>
  );
}

/** An 80px garment tile: the thumb variant, or the placeholder. */
export function GarmentThumb(props: {
  garment: { name: string | null; photo: ImageRef | null };
  class: string;
}) {
  const { garment } = props;
  return garment.photo ? (
    <img
      src={imageUrl(garment.photo, 'thumb')}
      alt={garment.name ?? ''}
      class={`size-20 object-cover ${props.class}`}
      width="80"
      height="80"
      loading="lazy"
      decoding="async"
    />
  ) : (
    <div
      class={`size-20 bg-base-200 flex items-center justify-center ${props.class}`}
    >
      <HangerIcon class="size-6 text-faint" strokeWidth="1.5" />
    </div>
  );
}

export function BackLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      class="btn btn-ghost btn-sm btn-circle"
      aria-label={t('BACK')}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="2"
        stroke="currentColor"
        class="size-4"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
        />
      </svg>
    </a>
  );
}

/** A page with nothing to list yet: an icon, a message and what to do about it. */
export function EmptyState(props: {
  message: string;
  icon?: Child;
  children: Child;
}) {
  return (
    <div class="flex flex-col items-center justify-center gap-4 pt-20 text-muted">
      {props.icon ?? <HangerIcon class="size-16" strokeWidth="1" />}
      <p class="text-center text-sm px-4">{props.message}</p>
      {props.children}
    </div>
  );
}

/**
 * A success message shown once after a redirect that carries a flag in the
 * URL (`?created=1`, `?bulkUpdated=3`); it hides itself (toast-auto-hide in
 * main.css). Pair it with StripFlags so a reload or a shared link does not
 * show it again.
 */
export function SavedToast(props: { id: string; text: string }) {
  return (
    <div
      id={props.id}
      class="toast toast-top toast-center z-20 top-36 toast-auto-hide"
      aria-live="polite"
    >
      <div class="alert alert-success shadow-md">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="size-5 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>{props.text}</span>
      </div>
    </div>
  );
}

/**
 * Drops one-shot flags from the address bar once the page has read them,
 * so a reload or a copied URL does not replay their toast. `names` are the
 * page's own constants; jsonForScript keeps them inert in the script anyway.
 */
export function StripFlags(props: { names: readonly string[] }) {
  const script = `(() => {
  const names = ${jsonForScript(props.names)};
  const url = new URL(window.location.href);
  if (names.some((name) => url.searchParams.has(name))) {
    for (const name of names) url.searchParams.delete(name);
    window.history.replaceState({}, '', url);
  }
})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

/**
 * One section of Profile (src/web/auth/pages.tsx): an anchor other pages
 * link to (`/auth/profile#weather`), its heading and its content. Each
 * feature renders its own (the sharing, weather, notifications and week
 * sections); `scroll-mt-20` keeps the heading clear of the fixed app bar
 * when the anchor is followed.
 */
export function ProfileSection(props: {
  id: string;
  heading: string;
  children: Child;
}) {
  const headingId = `${props.id}-heading`;
  return (
    <section
      id={props.id}
      class="card bg-base-200 w-full scroll-mt-20"
      aria-labelledby={headingId}
    >
      <div class="card-body gap-3">
        <h2 id={headingId} class="card-title">
          {props.heading}
        </h2>
        {props.children}
      </div>
    </section>
  );
}
