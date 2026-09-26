import { imageUrl } from '../../file/file-url/image-url';
import { t } from '../i18n';
import type { BuilderRow, RowGarment } from './builder';

function rowUrl(category: string, index: number): string {
  return `/outfits/row-fragment?category=${encodeURIComponent(category)}&index=${index}`;
}

// Swipe left/right steps to the next/previous garment, like the ‹ › buttons.
// The server has worked out both targets (data-next-index, data-prev-index),
// including from a garment outside the cycle.
const SWIPE = `on touchstart
     set my startX to event.touches[0].clientX
     set my startY to event.touches[0].clientY
   on touchmove
     if my startX is not null
       set dx to Math.abs(event.touches[0].clientX - my startX)
       set dy to Math.abs(event.touches[0].clientY - my startY)
       if dx > dy
         js(event) event.preventDefault() end
       end
     end
   on touchend
     if my startX is not null
       set dx to event.changedTouches[0].clientX - my startX
       set my startX to null
       set my startY to null
       if Math.abs(dx) >= 30
         if dx < 0
           set newIdx to @data-next-index
         else
           set newIdx to @data-prev-index
         end
         js(me, newIdx) htmx.ajax('GET', '/outfits/row-fragment?category=' + encodeURIComponent(me.dataset.category) + '&index=' + newIdx, {target: me, swap: 'outerHTML'}) end
       end
     end`;

// Fills #garment-modal (GarmentModal, form-page.tsx) from the button's data
// attributes and opens it.
const OPEN_MODAL = `on click js(me)
     const d = me.dataset;
     document.getElementById('modal-garment-link').href = d.garmentHref;
     document.getElementById('modal-garment-name').textContent = d.garmentName;
     const img = document.getElementById('modal-photo-img');
     const ph = document.getElementById('modal-photo-placeholder');
     img.src = d.garmentPhoto || '';
     img.classList.toggle('hidden', !d.garmentPhoto);
     ph.classList.toggle('hidden', !!d.garmentPhoto);
     [['modal-brand', d.garmentBrand], ['modal-color', d.garmentColor], ['modal-size', d.garmentSize], ['modal-notes', d.garmentNotes]]
       .forEach(([id, val]) => { const el = document.getElementById(id); el.textContent = val || ''; el.classList.toggle('hidden', !val); });
     document.getElementById('garment-modal').showModal();
   end`;

function EmptyPhoto() {
  return (
    <div class="outfit-none size-14 rounded-box bg-base-200 flex items-center justify-center">
      <span class="text-xs text-base-content/40">—</span>
    </div>
  );
}

/** The row's garment: its thumb and name; a tap opens the detail modal. */
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
      _={OPEN_MODAL}
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
 * cutout only when opened.
 */
export function OutfitRow({ row }: { row: BuilderRow }) {
  const { garment } = row;
  return (
    <div
      class="outfit-row flex items-center gap-2 py-3"
      data-category={row.category}
      data-index={row.index ?? undefined}
      data-count={row.count}
      data-prev-index={row.prevIndex}
      data-next-index={row.nextIndex}
      _={SWIPE}
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
        _="on click remove closest .outfit-row"
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
