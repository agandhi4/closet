import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import type { ViewContext } from '../view-context';
import { EmptyState, GarmentThumb } from '../layout/parts';
import type { OutfitSummary } from './queries';

// After a successful POST /calendar from a card's dropdown: close the
// dropdown and show the toast for three seconds.
const SCHEDULED = `on htmx:afterRequest[detail.successful]
   reset me
   call document.activeElement.blur()
   for el in <[tabindex]/> in closest .dropdown
     call el.blur()
   end
   remove .hidden from #calendar-toast
   wait 3s
   add .hidden to #calendar-toast`;

/** GET /outfits: every outfit as a card of its garments, newest first. */
export function OutfitsPage(props: {
  ctx: ViewContext;
  outfits: OutfitSummary[];
}) {
  const { ctx, outfits } = props;
  return (
    <Layout ctx={ctx} title={t('OUTFITS')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24">
        <div class="flex items-center justify-between mb-6 px-2">
          <h1 class="text-2xl font-bold">{t('OUTFITS')}</h1>
          <a href="/outfits/new" class="btn btn-primary btn-sm">
            + {t('BUILD_OUTFIT')}
          </a>
        </div>
        {outfits.length > 0 ? (
          <div class="flex flex-wrap gap-4 justify-center">
            {outfits.map((outfit) => (
              <OutfitCard outfit={outfit} />
            ))}
          </div>
        ) : (
          <EmptyState
            message={t('NO_OUTFITS')}
            icon={
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1"
                stroke="currentColor"
                class="size-16"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
                />
              </svg>
            }
          >
            <a href="/outfits/new" class="btn btn-primary btn-sm">
              {t('ADD_FIRST_OUTFIT')}
            </a>
          </EmptyState>
        )}
      </main>
      <div
        id="calendar-toast"
        class="toast toast-top toast-center hidden z-20 top-20"
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
          <span>{t('CALENDAR_OUTFIT_ADDED')}</span>
        </div>
      </div>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * One outfit: name (a link), the "add to calendar" dropdown, notes, and its
 * garments' thumbnails in the order it was built. The card body navigates
 * by script because it contains the dropdown's form, which an <a> cannot.
 */
function OutfitCard({ outfit }: { outfit: OutfitSummary }) {
  const href = `/outfits/${outfit.id}`;
  return (
    <div
      class="card bg-base-100 w-96 shadow-sm hover:shadow-md transition-shadow"
      data-outfit-id={outfit.id}
    >
      <div
        class="card-body p-3 cursor-pointer"
        onclick={`window.location.href=${JSON.stringify(href)}`}
      >
        <div class="flex items-center justify-between gap-2">
          <a href={href} class="card-title text-sm hover:underline truncate">
            {outfit.name || t('UNTITLED_OUTFIT')}
          </a>
          <div
            class="dropdown dropdown-end shrink-0"
            onclick="event.stopPropagation();"
          >
            <label
              tabindex={0}
              class="btn btn-ghost btn-xs btn-square"
              title={t('ADD_TO_CALENDAR')}
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
                  d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5m-9-6h.008v.008H12v-.008ZM12 15h.008v.008H12V15Zm0 2.25h.008v.008H12v-.008ZM9.75 15h.008v.008H9.75V15Zm0 2.25h.008v.008H9.75v-.008ZM7.5 15h.008v.008H7.5V15Zm0 2.25h.008v.008H7.5v-.008Zm6.75-4.5h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V15Zm0 2.25h.008v.008h-.008v-.008Zm2.25-4.5h.008v.008H16.5v-.008Zm0 2.25h.008v.008H16.5V15Z"
                />
              </svg>
            </label>
            <div
              tabindex={0}
              class="dropdown-content z-10 card card-compact shadow-lg bg-base-100 border border-base-300 w-64 mt-1"
            >
              <div class="card-body p-4 gap-3">
                <p class="font-semibold text-sm">
                  {t('CALENDAR_ADD_OUTFIT_PROMPT')}
                </p>
                <form
                  hx-post="/calendar"
                  hx-swap="none"
                  hx-push-url="false"
                  _={SCHEDULED}
                  class="flex flex-col gap-2"
                >
                  <input type="hidden" name="outfitId" value={outfit.id} />
                  <input
                    type="date"
                    name="date"
                    class="input input-sm input-bordered w-full"
                    required
                    onblur="this.closest('form').querySelector('[type=submit]').focus()"
                  />
                  <button type="submit" class="btn btn-primary btn-sm w-full">
                    {t('SAVE')}
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
        {outfit.notes && (
          <p class="text-xs text-base-content/60 line-clamp-2">
            {outfit.notes}
          </p>
        )}
        <a href={href} class="flex flex-wrap gap-1 mt-1">
          {outfit.garments.map((garment) => (
            <GarmentThumb garment={garment} class="rounded" />
          ))}
        </a>
      </div>
    </div>
  );
}
