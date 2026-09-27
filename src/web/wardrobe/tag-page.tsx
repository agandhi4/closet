import {
  FORMALITIES,
  propertyApplies,
  typesOf,
  WARMTHS,
} from '../../wardrobe/properties';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, EmptyState, HangerIcon } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel } from './garment';
import { type LabelledProperty, valueLabel } from './labels';
import type { GarmentDetail } from './queries';
import { garmentUrl, wardrobeUrl } from './urls';

/**
 * GET /wardrobe/tag: one garment at a time that still needs its type,
 * warmth or formality (queries.ts, needsTags), newest first. Every chip tap
 * posts the card's form (POST /wardrobe/:id/tag) and the answer is the
 * same card, saved, with the type's presets filled where nothing was set;
 * Next asks for the card after this garment (`?before=`), so a garment
 * left alone waits for the next pass. Minutes for a wardrobe, not a
 * form visit per garment.
 */

export const TAG_CARD_ID = 'tag-card';

export interface TagCardModel {
  /** The garment on the card; undefined when nothing is left to tag. */
  garment: GarmentDetail | undefined;
  /** Garments still needing tags, this one included. */
  left: number;
  viewOwner: number | undefined;
}

export function TagPage(props: { ctx: ViewContext; model: TagCardModel }) {
  const { ctx, model } = props;
  return (
    <Layout ctx={ctx} title={t('TAG_GARMENTS')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <div class="flex items-center gap-3 mb-6">
          <BackLink href={wardrobeUrl(model.viewOwner)} />
          <h1 class="text-2xl font-bold">{t('TAG_GARMENTS')}</h1>
        </div>
        <TagCard model={model} />
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** The card: swapped whole by every tap and by Next/Skip. */
export function TagCard({ model }: { model: TagCardModel }) {
  const { garment, viewOwner } = model;
  if (!garment) {
    return (
      <div id={TAG_CARD_ID}>
        <EmptyState message={t('TAG_ALL_DONE')}>
          <a href={wardrobeUrl(viewOwner)} class="btn btn-primary btn-sm">
            {t('WARDROBE')}
          </a>
        </EmptyState>
      </div>
    );
  }
  const next = wardrobeUrl(viewOwner, { before: garment.id }, '/wardrobe/tag');
  const swap = {
    'hx-target': `#${TAG_CARD_ID}`,
    'hx-swap': 'outerHTML',
  } as const;
  return (
    <div id={TAG_CARD_ID} class="flex flex-col gap-4">
      <p class="text-sm text-base-content/60">
        {t('TAG_LEFT', { count: model.left })}
      </p>
      <a
        href={garmentUrl(garment.id, viewOwner)}
        class="card bg-base-100 shadow-sm"
      >
        <figure class="aspect-square bg-base-200">
          {garment.photo ? (
            <img
              src={imageUrl(garment.photo, 'nobg')}
              alt={garment.name ?? ''}
              class="object-contain w-full h-full"
              width="600"
              height="600"
              decoding="async"
            />
          ) : (
            <HangerIcon class="size-16 text-base-content/30" strokeWidth="1" />
          )}
        </figure>
        <div class="card-body p-4">
          <h2 class="card-title">{garment.name}</h2>
          <p class="text-sm text-base-content/60 capitalize">
            {categoryLabel(garment.category)}
          </p>
        </div>
      </a>
      {/* Posted whole on every tap; the answer replaces this card. Not a
          native form: nothing here can be refused with a 4xx a person could
          cause (the chips are the only values). */}
      <form
        hx-post={wardrobeUrl(viewOwner, {}, `/wardrobe/${garment.id}/tag`)}
        hx-trigger="change"
        {...swap}
        class="flex flex-col gap-5"
      >
        <TagChips
          name="type"
          property="type"
          label={t('PROPERTY_TYPE')}
          options={typesOf(garment.category).map((type) => type.value)}
          selected={garment.type}
        />
        {propertyApplies('warmth', garment.category) && (
          <TagChips
            name="warmth"
            property="warmth"
            label={t('PROPERTY_WARMTH')}
            options={WARMTHS}
            selected={garment.warmth}
          />
        )}
        <TagChips
          name="formality"
          property="formality"
          label={t('PROPERTY_FORMALITY')}
          options={FORMALITIES}
          selected={garment.formality}
        />
      </form>
      {/* Saved already: Next only moves on (and skips a garment left alone). */}
      <a href={next} hx-get={next} {...swap} class="btn btn-primary">
        {t('TAG_NEXT')}
      </a>
    </div>
  );
}

/** Large radio chips; nothing when the category offers no choice (no types). */
function TagChips(props: {
  name: string;
  property: LabelledProperty;
  label: string;
  options: readonly (string | number)[];
  selected: string | number | null;
}) {
  if (props.options.length === 0) return null;
  return (
    <div role="group" aria-label={props.label} class="flex flex-col gap-2">
      <span class="text-sm font-medium">{props.label}</span>
      <div class="flex flex-wrap gap-2">
        {props.options.map((option) => (
          <input
            type="radio"
            name={props.name}
            value={String(option)}
            class="btn rounded-full"
            aria-label={valueLabel(props.property, option)}
            checked={props.selected === option}
          />
        ))}
      </div>
    </div>
  );
}
