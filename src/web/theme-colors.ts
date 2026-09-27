/**
 * The page colour (daisyUI's `base-100`) of the two themes in
 * views/assets/main.css, as hex: what the browser paints before any CSS
 * loads. The manifest's `theme_color` and `background_color`
 * (shell/manifest.ts: the installed app's title bar and splash screen, one
 * value, so the light theme's) and the layout's `<meta name="theme-color">`
 * per scheme (layout/layout.tsx) read them. Hex, not the tokens' oklch:
 * both are read by browser and OS chrome (title bars, splash screens) that
 * does not promise CSS Color 4. theme-colors.spec.ts converts main.css's
 * tokens and fails when these drift from them.
 */
export const THEME_BASE_100 = {
  light: '#faf8f4',
  dark: '#191512',
} as const;
