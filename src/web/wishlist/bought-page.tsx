import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { CancelLink, Messages } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import { PRICE_INPUT_MAX } from '../wardrobe/garment-input';
import type { GarmentRef } from './queries';

export type BoughtField = 'acquiredOn' | 'price';

export interface BoughtModel {
  garment: { id: number; name: string | null; category: string };
  viewOwner: number | undefined;
  /** As the form shows them: today and the listed price, or what was posted. */
  values: { acquiredOn: string; price: string };
  /**
   * The closet garment it replaces, offered for the archive; undefined when
   * there is none still in the closet, or the requester may not archive
   * (a grantee: archiving is the owner's).
   */
  archivable: GarmentRef | undefined;
  errors?: FieldErrors<BoughtField>;
}

/**
 * GET /wardrobe/:id/bought: "Bought it" for a wishlist item. The day it was
 * bought (today) and the price paid (the listed price) prefilled, and, when
 * it replaces a garment still in the closet, a checkbox to archive that one
 * too, unchecked: the old one is never archived without asking. A native
 * post (PostForm): a refusal re-renders this page with a 400.
 */
export function BoughtPage(props: { ctx: ViewContext; model: BoughtModel }) {
  const { ctx, model } = props;
  const { garment, values, errors = {} } = model;
  const name = garment.name ?? categoryLabel(garment.category);
  const title = t('wishlist.BOUGHT_TITLE', { name });
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar
        ctx={ctx}
        title={title}
        back={garmentUrl(garment.id, model.viewOwner)}
        formPage
      />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <p class="text-sm text-base-content/70 mb-4">
          {t('wishlist.BOUGHT_INTRO')}
        </p>
        <PostForm
          action={garmentUrl(garment.id, model.viewOwner, '/bought')}
          class="flex flex-col gap-4"
        >
          <div class="flex flex-col">
            <label class="label" for="bought-acquired">
              <span class="label-text">{t('DATE_ACQUIRED')}</span>
            </label>
            <input
              id="bought-acquired"
              type="date"
              name="acquiredOn"
              class={`input input-bordered w-full ${errors.acquiredOn ? 'input-error' : ''}`}
              value={values.acquiredOn}
            />
            <Messages messages={errors.acquiredOn} />
          </div>
          <div class="flex flex-col">
            <label class="label" for="bought-price">
              <span class="label-text">{t('wishlist.PRICE_PAID')}</span>
            </label>
            <input
              id="bought-price"
              type="text"
              inputmode="decimal"
              name="price"
              class={`input input-bordered w-full ${errors.price ? 'input-error' : ''}`}
              value={values.price}
              maxlength={PRICE_INPUT_MAX}
              placeholder={t('PRICE_PLACEHOLDER')}
            />
            <Messages messages={errors.price} />
          </div>
          {model.archivable && (
            <label class="label cursor-pointer justify-start gap-3 whitespace-normal">
              <input
                type="checkbox"
                name="archiveReplaced"
                value="1"
                class="checkbox checkbox-sm"
              />
              <span class="label-text">
                {t('wishlist.ARCHIVE_REPLACED', {
                  name:
                    model.archivable.name ??
                    categoryLabel(model.archivable.category),
                })}
              </span>
            </label>
          )}
          <div class="flex gap-2 mt-2">
            <CancelLink
              href={garmentUrl(garment.id, model.viewOwner)}
              class="flex-1"
            />
            <button type="submit" class="btn btn-primary flex-1">
              {t('wishlist.MOVE_TO_CLOSET')}
            </button>
          </div>
        </PostForm>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
