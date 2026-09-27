import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import { Messages } from '../wardrobe/garment-form';
import { garmentUrl } from '../wardrobe/urls';
import { PRICE_INPUT_MAX } from '../wardrobe/validation';
import { differencesText, itemTitle } from '../plans/labels';
import type { PlanFollowUps, PlanPurchase } from '../plans/purchase';
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
  /**
   * The owner's plan items it is a candidate for, and what buying it does
   * to each (34b, src/web/plans/purchase.ts); empty for a grantee.
   */
  plans: PlanPurchase[];
  /** The plan follow-ups as posted, on a re-render; the suggestions otherwise. */
  ticked?: PlanFollowUps;
  errors?: FieldErrors<BoughtField>;
}

/**
 * GET /wardrobe/:id/bought: "Bought it" for a wishlist item. The day it was
 * bought (today) and the price paid (the listed price) prefilled, and, when
 * it replaces a garment still in the closet, a checkbox to archive that one
 * too, unchecked: the old one is never archived without asking. For the
 * owner, when it is a candidate for plan items (34b), what buying it does
 * to each: that it fulfils it, or that it does not match ("blue vs black")
 * with "Change the item to match" unticked, and the item's other
 * candidates to remove from the wishlist (ticked only when the item ends
 * up owned). A native post (PostForm): a refusal re-renders this page with
 * a 400.
 */
export function BoughtPage(props: { ctx: ViewContext; model: BoughtModel }) {
  const { ctx, model } = props;
  const { garment, values, errors = {} } = model;
  const name = garment.name ?? categoryLabel(garment.category);
  const title = t('wishlist.BOUGHT_TITLE', { name });
  return (
    <Layout ctx={ctx} title={title}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 max-w-lg mx-auto">
        <div class="flex items-center gap-3 mb-6">
          <BackLink href={garmentUrl(garment.id, model.viewOwner)} />
          <h1 class="text-2xl font-bold">{title}</h1>
        </div>
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
          {model.plans.length > 0 && (
            <PlanSection plans={model.plans} ticked={model.ticked} />
          )}
          <div class="flex gap-2 mt-2">
            <a
              href={garmentUrl(garment.id, model.viewOwner)}
              class="btn btn-ghost flex-1"
            >
              {t('CANCEL')}
            </a>
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

/** What buying it does to the owner's plan items it is a candidate for. */
function PlanSection(props: {
  plans: PlanPurchase[];
  ticked: PlanFollowUps | undefined;
}) {
  const { ticked } = props;
  return (
    <section
      id="bought-plans"
      class="flex flex-col gap-3"
      aria-labelledby="bought-plans-title"
    >
      <h2
        id="bought-plans-title"
        class="text-xs font-semibold uppercase tracking-wide text-base-content/50"
      >
        {t('shopping.FOR_YOUR_PLANS')}
      </h2>
      {props.plans.map((purchase) => (
        <div
          class="card bg-base-100 shadow-sm"
          id={`bought-item-${purchase.item.id}`}
          data-matches={String(purchase.differences.length === 0)}
        >
          <div class="card-body p-3 gap-2 text-sm">
            <p class="font-medium">
              {t('shopping.ITEM_IN_PLAN', {
                item: itemTitle(purchase.item),
                plan: purchase.plan.name,
              })}
            </p>
            {purchase.differences.length === 0 ? (
              <p class="text-success">{fitText(purchase)}</p>
            ) : (
              <>
                <p class="text-warning" data-mismatch>
                  {t('shopping.MISMATCH', {
                    differences: differencesText(purchase.differences),
                  })}
                </p>
                <label class="label cursor-pointer justify-start gap-3 whitespace-normal">
                  <input
                    type="checkbox"
                    name="adjustItems"
                    value={String(purchase.item.id)}
                    class="checkbox checkbox-sm"
                    checked={ticked?.adjustItems.includes(purchase.item.id)}
                  />
                  <span class="label-text">{t('shopping.ADJUST_ITEM')}</span>
                </label>
                <p class="text-xs text-base-content/60">
                  {t('shopping.KEEP_HINT')}
                </p>
              </>
            )}
            {purchase.others.length > 0 && (
              <fieldset class="flex flex-col gap-1">
                <legend class="text-xs text-base-content/60 mb-1">
                  {t('shopping.OTHER_CANDIDATES')}
                </legend>
                {purchase.others.map(({ candidate, suggested }) => (
                  <label class="label cursor-pointer justify-start gap-3 whitespace-normal">
                    <input
                      type="checkbox"
                      name="removeCandidates"
                      value={String(candidate.garmentId)}
                      class="checkbox checkbox-sm"
                      checked={
                        ticked
                          ? ticked.removeCandidates.includes(
                              candidate.garmentId,
                            )
                          : suggested
                      }
                    />
                    <span class="label-text">
                      {t('shopping.REMOVE_CANDIDATE', {
                        name:
                          candidate.name ?? categoryLabel(candidate.category),
                      })}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

/** What a matching purchase does to its item, in words. */
function fitText(purchase: PlanPurchase): string {
  switch (purchase.after) {
    case 'owned':
      return t('shopping.FULFILS');
    case 'partly':
    case 'missing':
      return t('shopping.COUNTS_TOWARD');
    case null:
      return t('shopping.MATCHES_PROPOSED');
  }
}
