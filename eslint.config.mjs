// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// esquery regexes (no `/` inside) for the theme rule in no-restricted-syntax.
const PALETTE_CLASS =
  '/\\b(?:(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|placeholder|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\\d{2,3}|(?:bg|text|border|fill|stroke)-(?:white|black))\\b/';
const RETIRED_CHIP_CLASS = '/\\bchip-\\d\\b/';
const INLINE_COLOUR =
  '/#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\\(/';
const THEME_TOKENS_ONLY =
  'Colours come from the daisyUI theme tokens in views/assets/main.css (bg-base-200, text-error), never a palette class or an inline colour (#81).';
// text-base-content/0 to /69; \x2F is the slash, which an esquery regex
// cannot hold.
const FAINT_TEXT_CLASS = '/\\btext-base-content\\x2F(?:\\d|[1-6]\\d)\\b/';
const MUTED_TEXT =
  'Muted text is text-muted (WCAG AA on every base in both themes); a decorative graphic that carries no information is text-faint (views/assets/main.css, #88).';

const HONO_RAW_HTML_PATHS = [
  {
    name: 'hono/html',
    message:
      'Use dangerouslySetInnerHTML, the one raw-HTML escape hatch (CLAUDE.md, Web layer).',
  },
  {
    name: 'hono/utils/html',
    message:
      'Use dangerouslySetInnerHTML, the one raw-HTML escape hatch (CLAUDE.md, Web layer).',
  },
];

// Bare spellings of the Node builtins that `node:*` also covers.
const NODE_BUILTINS = [
  'fs',
  'fs/promises',
  'path',
  'crypto',
  'child_process',
  'os',
  'http',
  'https',
  'net',
];
const NO_IO =
  'The pure layers do no I/O and read no clock, environment or crypto: the caller passes it in (docs/web-layer.md).';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      './test/support/legacy-migrations/**/*',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // My custom rules
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-unsafe-optional-chaining': 'off',
      complexity: ['warn', { max: 10 }],
      'max-depth': ['warn', { max: 3 }],
      // One assertion style: `<T>value` does not parse in .tsx files, so
      // `as` everywhere.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as' },
      ],
      // "Today" and every day from an instant come from todayIn() at
      // APP_TIMEZONE (src/calendar-date.ts; t.today() in the
      // integration specs, householdToday() in Playwright's). A UTC date is
      // tomorrow every evening in New York: main went red at 00:01 UTC.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name=/^(slice|substring|substr|split)$/][callee.object.callee.property.name='toISOString']",
          message:
            "A UTC date is not the household's day: use todayIn(APP_TIMEZONE, now) (CLAUDE.md, Gotchas).",
        },
        {
          selector: "CallExpression[callee.property.name='toLocaleDateString']",
          message:
            'A day from an instant comes from todayIn(APP_TIMEZONE, now) (CLAUDE.md, Gotchas).',
        },
        // Colour comes from the two daisyUI themes in views/assets/main.css
        // (#81): semantic tokens only (bg-base-200, text-error), so both
        // schemes and every contrast figure hold. A Tailwind palette class
        // or a colour in a style attribute is the same in light and dark.
        // The retired calendar chips (chip-0..5) cycled hues per entry.
        ...[PALETTE_CLASS, RETIRED_CHIP_CLASS].flatMap((pattern) => [
          {
            selector: `Literal[value=${pattern}]`,
            message: THEME_TOKENS_ONLY,
          },
          {
            selector: `TemplateElement[value.raw=${pattern}]`,
            message: THEME_TOKENS_ONLY,
          },
        ]),
        // Below /70 the base content fails AA on some base (#88): muted
        // text is the one text-muted tone, faint the decorative graphics.
        {
          selector: `Literal[value=${FAINT_TEXT_CLASS}]`,
          message: MUTED_TEXT,
        },
        {
          selector: `TemplateElement[value.raw=${FAINT_TEXT_CLASS}]`,
          message: MUTED_TEXT,
        },
        {
          selector: `JSXAttribute[name.name='style'] Literal[value=${INLINE_COLOUR}]`,
          message: THEME_TOKENS_ONLY,
        },
        {
          selector: `JSXAttribute[name.name='style'] TemplateElement[value.raw=${INLINE_COLOUR}]`,
          message: THEME_TOKENS_ONLY,
        },
      ],
      // hono/jsx escapes every text child and attribute value. The one way to
      // emit markup as-is is `dangerouslySetInnerHTML` (greppable, reviewed
      // per use; see CLAUDE.md, Web layer). hono's `raw()` would be a second,
      // quieter hatch.
      'no-restricted-imports': [
        'error',
        {
          paths: HONO_RAW_HTML_PATHS,
        },
      ],
    },
  },

  // The pure layers (docs/web-layer.md, Code no feature owns): rules over
  // plain values, no HTTP, no database, no I/O, so they run in a unit test
  // without a mock and any feature can import them. They sit below
  // src/web/ and src/db/; a dependency pointing up is a layering bug, so
  // the shared type or helper moves down (src/calendar-date.ts) or the code
  // is made generic over the caller's type (InsightGarment<Photo>). Specs
  // are exempt: they build fixtures. A flat-config rule replaces the earlier
  // block's, so the hono paths are repeated from the shared const.
  {
    files: ['src/wardrobe/**/*.ts', 'src/weather/**/*.ts', 'src/push/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...HONO_RAW_HTML_PATHS,
            {
              name: 'drizzle-orm',
              message: 'The pure layers hold no queries (src/db/CLAUDE.md).',
            },
            ...NODE_BUILTINS.map((name) => ({
              name,
              message: NO_IO,
            })),
          ],
          patterns: [
            {
              group: ['**/web', '**/web/**'],
              message:
                'The pure layers sit below src/web/: move the shared code down to src/ or make it generic over the caller type (docs/web-layer.md).',
            },
            {
              group: ['**/db', '**/db/**', 'drizzle-orm/*'],
              message:
                'The pure layers hold no queries: the caller reads rows and passes plain values (docs/web-layer.md).',
            },
            { group: ['node:*'], message: NO_IO },
          ],
        },
      ],
    },
  },
);
