import type { IdeaProblem } from '../../wardrobe/generator';
import { t } from '../i18n';
import type { IdeasWeather } from './ideas';

/**
 * How an outfit meets the day, as small chips: the gallery's and Today's
 * card reasons (Reasons, ideas-page.tsx) and Styling's fit line (#468b), so
 * every surface words a problem and a fit the same way.
 */

export interface Chip {
  text: string;
  tone: 'badge-warning' | 'badge-success' | 'badge-ghost' | 'badge-info';
}

/** A named problem: a weather miss or the occasion's formality ('breaks-rule' names its rules instead). */
export function problemChip(
  problem: Exclude<IdeaProblem, 'breaks-rule'>,
): Chip {
  return warningChip(t(`gallery.problem.${problem}`));
}

export function warningChip(text: string): Chip {
  return { text, tone: 'badge-warning' };
}

/** No problem against a day that has weather: "Fits the weather", or the typical weather's. */
export function fitsChip(weather: Pick<IdeasWeather, 'typical'>): Chip {
  return {
    text: t(weather.typical ? 'gallery.FITS_TYPICAL' : 'gallery.FITS_WEATHER'),
    tone: 'badge-success',
  };
}

/**
 * Advice for the day rather than any card's problem ("Take the umbrella",
 * #648): shown once above an idea list (Ideas' header, Today's ideas row),
 * never on a card, as no idea is judged on it.
 */
export function adviceChips(weather: IdeasWeather | null): Chip[] {
  return weather?.needs.umbrella
    ? [{ text: t('gallery.TAKE_UMBRELLA'), tone: 'badge-info' }]
    : [];
}

export function ChipList({ chips }: { chips: readonly Chip[] }) {
  if (chips.length === 0) return null;
  return (
    <ul class="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <li class={`badge badge-sm badge-soft ${chip.tone} h-auto py-0.5`}>
          {chip.text}
        </li>
      ))}
    </ul>
  );
}
