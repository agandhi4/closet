// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
      // APP_TIMEZONE (src/web/calendar/calendar-date.ts; t.today() in the
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
      ],
      // hono/jsx escapes every text child and attribute value. The one way to
      // emit markup as-is is `dangerouslySetInnerHTML` (greppable, reviewed
      // per use; see CLAUDE.md, Web layer). hono's `raw()` would be a second,
      // quieter hatch.
      'no-restricted-imports': [
        'error',
        {
          paths: [
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
          ],
        },
      ],
    },
  },
);
