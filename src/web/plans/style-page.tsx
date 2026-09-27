import type { Child } from 'hono/jsx';
import { OCCASIONS, type Occasion } from '../../wardrobe/occasions';
import { GARMENT_COLORS } from '../../wardrobe/properties';
import {
  BUDGET_BANDS,
  RHYTHM_PERIODS,
  RHYTHM_TIMES_MAX,
  STYLES,
} from '../../wardrobe/style';
import { PostForm } from '../auth/form';
import { occasionLabel } from '../calendar/labels';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, SavedToast, StripFlags } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { budgetLabel, periodLabel, styleLabel } from './labels';
import { PLANS_PATH, STYLE_PROFILE_PATH, WEATHER_SETTINGS_PATH } from './urls';
import {
  rhythmFieldNames,
  STYLE_NOTES_MAX,
  type StyleProfileBody,
} from './validation';

export interface StyleProfileModel {
  /** The form's values: the stored profile's (styleProfilePost), or what was posted. */
  values: StyleProfileBody;
  errors?: Partial<Record<Occasion, string[]>>;
  saved?: boolean;
  /**
   * The weather's home city (#14), shown read-only: set and changed in
   * Profile › Weather, never stored here. Undefined with the weather off.
   */
  home?: { name: string | null };
}

const FLAGS = ['saved'] as const;

/**
 * GET /auth/profile/style: the signed-in user's style profile (#34, slice
 * 34a), a section of the Profile (docs/plans/2026-09-26-redesign.md):
 * styles, the budget band, the palette and the week's rhythm, counted per
 * calendar occasion (#13's words; the week template #16 will read them).
 * Private: nobody else ever sees it. The home city belongs to the weather
 * (#14): shown here read-only, linking to Profile › Weather to change it.
 */
export function StyleProfilePage(props: {
  ctx: ViewContext;
  model: StyleProfileModel;
}) {
  const { ctx, model } = props;
  const { values, errors = {} } = model;
  return (
    <Layout ctx={ctx} title={t('style.TITLE')}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <div class="flex items-center gap-3 mb-2">
          <BackLink href="/auth/profile" />
          <h1 class="text-2xl font-bold">{t('style.TITLE')}</h1>
        </div>
        <p class="text-sm text-base-content/70 mb-4">
          {t('style.INTRO')}{' '}
          <a href={PLANS_PATH} class="link link-primary">
            {t('plans.TITLE')}
          </a>
        </p>
        {model.home && <HomeCity name={model.home.name} />}
        <PostForm
          action={STYLE_PROFILE_PATH}
          class="flex flex-col gap-5"
          needsNetwork
        >
          <ChipGroup label={t('style.STYLES')}>
            {STYLES.map((style) => (
              <input
                type="checkbox"
                name="styles"
                value={style}
                class="btn btn-sm rounded-full"
                aria-label={styleLabel(style)}
                checked={values.styles?.includes(style)}
              />
            ))}
          </ChipGroup>
          <ChipGroup label={t('style.BUDGET')} hint={t('style.BUDGET_HINT')}>
            <input
              type="radio"
              name="budget"
              value=""
              class="btn btn-sm btn-ghost rounded-full"
              aria-label={t('NOT_SET')}
              checked={!values.budget}
            />
            {BUDGET_BANDS.map((band) => (
              <input
                type="radio"
                name="budget"
                value={band}
                class="btn btn-sm rounded-full"
                aria-label={budgetLabel(band)}
                checked={values.budget === band}
              />
            ))}
          </ChipGroup>
          <ChipGroup label={t('style.PALETTE')}>
            {GARMENT_COLORS.map((color) => (
              <input
                type="checkbox"
                name="palette"
                value={color}
                class="btn btn-sm rounded-full"
                aria-label={color}
                checked={values.palette?.includes(color)}
              />
            ))}
          </ChipGroup>
          <fieldset class="flex flex-col gap-2" id="style-rhythm">
            <legend class="label-text mb-1">{t('style.RHYTHM')}</legend>
            <p class="text-xs text-base-content/60">{t('style.RHYTHM_HINT')}</p>
            {OCCASIONS.map((occasion) => (
              <RhythmRow
                occasion={occasion}
                values={values}
                errors={errors[occasion]}
              />
            ))}
          </fieldset>
          <div class="flex flex-col">
            <label class="label" for="style-notes">
              <span class="label-text">{t('NOTES')}</span>
            </label>
            <textarea
              id="style-notes"
              name="notes"
              class="textarea textarea-bordered w-full"
              rows={3}
              maxlength={STYLE_NOTES_MAX}
              placeholder={t('style.NOTES_PLACEHOLDER')}
            >
              {values.notes ?? ''}
            </textarea>
          </div>
          <button type="submit" class="btn btn-primary">
            {t('SAVE')}
          </button>
        </PostForm>
      </main>
      {model.saved && <SavedToast id="style-toast" text={t('style.SAVED')} />}
      <StripFlags names={FLAGS} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** The weather's home city, and where to change it (the profile's Weather section). */
function HomeCity({ name }: { name: string | null }) {
  return (
    <p class="text-sm mb-4" id="style-home">
      {name === null ? (
        <a class="link link-primary" href={WEATHER_SETTINGS_PATH}>
          {t('weather.SET_LOCATION')}
        </a>
      ) : (
        <>
          {t('weather.HOME_IS', { name })}{' '}
          <a class="link link-primary" href={WEATHER_SETTINGS_PATH}>
            {t('style.CHANGE_HOME')}
          </a>
        </>
      )}
    </p>
  );
}

function ChipGroup(props: { label: string; hint?: string; children: Child }) {
  return (
    <div role="group" aria-label={props.label} class="flex flex-col">
      <span class="label">
        <span class="label-text">{props.label}</span>
      </span>
      {props.hint && (
        <p class="text-xs text-base-content/60 mb-1">{props.hint}</p>
      )}
      <div class="flex flex-wrap gap-2">{props.children}</div>
    </div>
  );
}

/** One occasion's count and period: "Work 3 a week". */
function RhythmRow(props: {
  occasion: Occasion;
  values: StyleProfileBody;
  errors?: string[];
}) {
  const names = rhythmFieldNames(props.occasion);
  const label = occasionLabel(props.occasion);
  const per = props.values[names.per] || 'week';
  return (
    <div class="flex flex-col">
      <div class="grid grid-cols-[1fr_5rem_7rem] items-center gap-2">
        <label for={names.times} class="text-sm">
          {label}
        </label>
        <input
          id={names.times}
          type="number"
          name={names.times}
          min="0"
          max={String(RHYTHM_TIMES_MAX)}
          inputmode="numeric"
          class={`input input-bordered input-sm w-full ${props.errors ? 'input-error' : ''}`}
          value={props.values[names.times] ?? ''}
          aria-invalid={props.errors ? 'true' : undefined}
        />
        <select
          name={names.per}
          class="select select-bordered select-sm w-full"
          aria-label={`${label}: ${t('style.PER')}`}
        >
          {RHYTHM_PERIODS.map((period) => (
            <option value={period} selected={per === period}>
              {periodLabel(period)}
            </option>
          ))}
        </select>
      </div>
      {props.errors?.map((message) => (
        <p class="text-error text-sm mt-1">{message}</p>
      ))}
    </div>
  );
}
