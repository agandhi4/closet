import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import { FormPage } from '../layout/form-page';
import { FormField, inputAttributes } from '../form-field';
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
 * too, unchecked: the old one is never archived without asking. In the
 * shared add/edit frame (`FormPage`: a native post, disabled offline, #411);
 * a refusal re-renders this page with a 400.
 */
export function BoughtPage(props: { ctx: ViewContext; model: BoughtModel }) {
  const { ctx, model } = props;
  const { garment, values, errors = {} } = model;
  const name = garment.name ?? categoryLabel(garment.category);
  return (
    <FormPage
      ctx={ctx}
      title={t('wishlist.BOUGHT_TITLE', { name })}
      back={garmentUrl(garment.id, model.viewOwner)}
      action={garmentUrl(garment.id, model.viewOwner, '/bought')}
      submitLabel={t('wishlist.MOVE_TO_CLOSET')}
      intro={
        <p class="text-sm text-base-content/70 mb-4">
          {t('wishlist.BOUGHT_INTRO')}
        </p>
      }
    >
      <FormField
        id="bought-acquired"
        label={t('DATE_ACQUIRED')}
        messages={errors.acquiredOn}
      >
        <input
          {...inputAttributes('bought-acquired', 'w-full', errors.acquiredOn)}
          type="date"
          name="acquiredOn"
          value={values.acquiredOn}
        />
      </FormField>
      <FormField
        id="bought-price"
        label={t('wishlist.PRICE_PAID')}
        messages={errors.price}
      >
        <input
          {...inputAttributes('bought-price', 'w-full', errors.price)}
          type="text"
          inputmode="decimal"
          name="price"
          value={values.price}
          maxlength={PRICE_INPUT_MAX}
          placeholder={t('PRICE_PLACEHOLDER')}
        />
      </FormField>
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
    </FormPage>
  );
}
