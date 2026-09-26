import type { Child } from 'hono/jsx';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import type { OutfitGarment } from './queries';

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

/** An 80px garment tile: the thumb variant, or the placeholder. */
export function GarmentThumb(props: { garment: OutfitGarment; class: string }) {
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
      <HangerIcon class="size-6 text-base-content/30" strokeWidth="1.5" />
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
    <div class="flex flex-col items-center justify-center gap-4 pt-20 text-base-content/40">
      {props.icon ?? <HangerIcon class="size-16" strokeWidth="1" />}
      <p class="text-center text-sm px-4">{props.message}</p>
      {props.children}
    </div>
  );
}
