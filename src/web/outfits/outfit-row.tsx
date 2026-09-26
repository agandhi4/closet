import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import type { BuilderRow, RowGarment } from './builder';

function rowUrl(category: string, index: number): string {
  return `/outfits/row-fragment?category=${encodeURIComponent(category)}&index=${index}`;
}

function EmptyPhoto() {
  return (
    <div class="outfit-none size-14 rounded-box bg-base-200 flex items-center justify-center">
      <span class="text-xs text-base-content/40">—</span>
    </div>
  );
}

/**
 * The row's garment: its thumb and name; a tap opens the detail modal
 * (public/js/outfit-builder.js fills it from the data attributes).
 */
function ChosenGarment({ garment }: { garment: RowGarment }) {
  const { photo } = garment;
  return (
    <button
      type="button"
      class="flex-1 flex flex-col items-center gap-1 min-w-0 overflow-hidden"
      data-garment-href={`/wardrobe/${garment.id}`}
      data-garment-name={garment.name ?? ''}
      data-garment-photo={photo ? imageUrl(photo, 'nobg') : ''}
      data-garment-brand={garment.brand ?? ''}
      data-garment-color={garment.color ?? ''}
      data-garment-size={garment.size ?? ''}
      data-garment-notes={garment.notes ?? ''}
    >
      {photo ? (
        <img
          class="outfit-photo size-14 rounded-box object-cover"
          src={imageUrl(photo, 'thumb')}
          alt={garment.name ?? ''}
          width="56"
          height="56"
          decoding="async"
        />
      ) : (
        <EmptyPhoto />
      )}
      <span class="outfit-name text-xs truncate max-w-full text-center">
        {garment.name}
      </span>
      {garment.archived && (
        <span class="badge badge-ghost badge-xs">{t('ARCHIVED')}</span>
      )}
    </button>
  );
}

/**
 * One builder row: drag handle, category, ‹ garment ›, remove. Rendered in
 * the form and returned alone by GET /outfits/row-fragment, which the
 * arrows, swipes and "Add row" swap in (outerHTML, or beforeend on the
 * list). Posts one category + garmentId pair; garmentId is empty for "no
 * garment". The row shows the 400px thumb; the detail modal loads the
 * cutout only when opened. A horizontal swipe steps like the arrows
 * (public/js/outfit-builder.js reads data-prev-index and data-next-index,
 * which the server works out); touch-pan-y leaves those moves to it.
 */
export function OutfitRow({ row }: { row: BuilderRow }) {
  const { garment } = row;
  return (
    <div
      class="outfit-row flex items-center gap-2 py-3 touch-pan-y"
      data-category={row.category}
      data-index={row.index ?? undefined}
      data-count={row.count}
      data-prev-index={row.prevIndex}
      data-next-index={row.nextIndex}
    >
      <span
        class="drag-handle cursor-grab active:cursor-grabbing text-base-content/30 shrink-0 touch-none flex items-center justify-center p-3 -m-3"
        title={t('DRAG_TO_REORDER')}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.5"
          stroke="currentColor"
          class="size-5"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3.75 5.25h16.5m-16.5 4.5h16.5m-16.5 4.5h16.5m-16.5 4.5h16.5"
          />
        </svg>
      </span>
      <span class="w-20 text-sm font-medium shrink-0 capitalize">
        {row.label}
      </span>
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-circle shrink-0"
        aria-label={t('OUTFIT_ROW_PREVIOUS')}
        hx-get={rowUrl(row.category, row.prevIndex)}
        hx-target="closest .outfit-row"
        hx-swap="outerHTML"
      >
        ‹
      </button>
      {garment ? (
        <ChosenGarment garment={garment} />
      ) : (
        <div class="flex-1 flex flex-col items-center gap-1 min-w-0 overflow-hidden">
          <EmptyPhoto />
          <span class="outfit-name text-xs truncate max-w-full text-center"></span>
        </div>
      )}
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-circle shrink-0"
        aria-label={t('OUTFIT_ROW_NEXT')}
        hx-get={rowUrl(row.category, row.nextIndex)}
        hx-target="closest .outfit-row"
        hx-swap="outerHTML"
      >
        ›
      </button>
      <input type="hidden" name="category" value={row.category} />
      <input type="hidden" name="garmentId" value={garment?.id ?? ''} />
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-circle shrink-0 text-error"
        aria-label={t('OUTFIT_ROW_REMOVE')}
        onclick="this.closest('.outfit-row').remove()"
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
            d="M6 18 18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
