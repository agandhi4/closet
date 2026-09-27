import {
  FORMALITIES,
  propertyApplies,
  typesOf,
  WARMTHS,
} from '../../wardrobe/properties';
import { AutosaveForm } from '../autosave';
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
 * warmth or formality (queries.ts, needsTags), newest first. The card's
 * chips are an `AutosaveForm`: every tap posts the whole card to
 * POST /wardrobe/:id/tag, which saves it and answers the chips as saved
 * (the type's presets filled where nothing was set) and the count left.
 * Next is the same form's submit button: it saves what is on the card (its
 * last taps may still be waiting in the queue, and ride along) and answers
 * the card after this garment, so a garment left alone waits for the next
 * pass. Minutes for a wardrobe, not a form visit per garment.
 */

export const TAG_CARD_ID = 'tag-card';
/** What a tap's answer redraws: the chips, never the form that posts them. */
const TAG_FIELDS_ID = 'tag-fields';
const TAG_LEFT_ID = 'tag-left';

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

/** The card: swapped whole by Next. */
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
  return (
    <div id={TAG_CARD_ID} class="flex flex-col gap-4">
      <TagLeft left={model.left} />
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
      {/* Not a native form: nothing here can be refused with a 4xx a person
          could cause (the chips are the only values). */}
      <AutosaveForm
        action={wardrobeUrl(viewOwner, {}, `/wardrobe/${garment.id}/tag`)}
        region={`#${TAG_FIELDS_ID}`}
        class="flex flex-col gap-5"
      >
        <div id={TAG_FIELDS_ID} class="flex flex-col gap-5">
          <TagFields garment={garment} />
        </div>
        {/* Outside the chips the answers redraw, so a tap on it survives a
            save landing before its own request leaves the queue (htmx reads
            the clicked button then). */}
        <button type="submit" name="next" value="1" class="btn btn-primary">
          {t('TAG_NEXT')}
        </button>
      </AutosaveForm>
    </div>
  );
}

/** A tap's answer: the chips as saved, and the count left out of band. */
export function TagSaved(props: { garment: GarmentDetail; left: number }) {
  return (
    <>
      <TagFields garment={props.garment} />
      <TagLeft left={props.left} oob />
    </>
  );
}

function TagLeft(props: { left: number; oob?: boolean }) {
  return (
    <p
      id={TAG_LEFT_ID}
      class="text-sm text-base-content/60"
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      {t('TAG_LEFT', { count: props.left })}
    </p>
  );
}

function TagFields({ garment }: { garment: GarmentDetail }) {
  return (
    <>
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
    </>
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
