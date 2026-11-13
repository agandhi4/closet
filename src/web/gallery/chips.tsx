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
  tone: 'badge-warning' | 'badge-success' | 'badge-ghost';
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
