import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../project-root';
import { THEME_BASE_100 } from './theme-colors';

const MAIN_CSS = readFileSync(
  join(PROJECT_ROOT, 'views/assets/main.css'),
  'utf8',
);

/** A theme's `--color-<name>` tokens, from its `@plugin "daisyui/theme"` block. */
function themeTokens(theme: string): Map<string, string> {
  const block = [
    ...MAIN_CSS.matchAll(/@plugin "daisyui\/theme" \{([\s\S]*?)\n\}/g),
  ]
    .map((match) => match[1])
    .find((body) => body.includes(`name: "${theme}";`));
  if (!block) throw new Error(`No daisyUI theme ${theme} in main.css`);
  return new Map(
    [...block.matchAll(/--color-([a-z0-9-]+): ([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

// CSS Color 4's OKLab to sRGB (https://www.w3.org/TR/css-color-4/#color-conversion-code),
// gamut-clipped as the browser paints it.
function oklchToHex(value: string): string {
  const match = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!match) throw new Error(`Not an oklch() token: ${value}`);
  const [lightness, chroma, hue] = match.slice(1).map(Number);
  const l = lightness / 100;
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3);
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
  return `#${linear
    .map((v) => Math.min(1, Math.max(0, v)))
    .map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

describe('THEME_BASE_100', () => {
  it.each([
    ['light', 'closet-light'],
    ['dark', 'closet-dark'],
  ] as const)('is the %s theme’s base-100 in main.css', (scheme, theme) => {
    const token = themeTokens(theme).get('base-100') ?? 'missing';
    expect(oklchToHex(token)).toBe(THEME_BASE_100[scheme]);
  });

  it('knows the conversion from a colour with a reference value', () => {
    // CSS Color 4's sample: oklch(62.8% 0.2577 29.23) is sRGB red.
    expect(oklchToHex('oklch(62.8% 0.2577 29.23)')).toBe('#ff0000');
  });
});
