import english from '../i18n/en/lang.json';
import { escapeHtml } from './html';

/**
 * English strings for JSX views, typed to the keys of src/i18n/en/lang.json:
 * `t('ABOUT_TITLE')`, `t('validation.IS_EMAIL')`. A misspelled key is a type
 * error, not raw text in the page. Handlebars views keep nestjs-i18n (`{{t
 * 'lang.KEY'}}`) until they are ported; both read the same file.
 */

type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

export type StringKey = Leaves<typeof english>;
/** Values for `{name}` placeholders (nestjs-i18n's interpolation syntax). */
export type StringParams = Record<string, string | number>;

function flatten(node: object, prefix = ''): [string, string][] {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[prefix + key, value] as [string, string]]
      : flatten(value as object, `${prefix}${key}.`),
  );
}

const STRINGS = new Map(flatten(english));
const PLACEHOLDER = /\{(\w+)\}/g;

function interpolate(
  key: StringKey,
  params: StringParams,
  encode: (value: string) => string,
): string {
  // The key type guarantees the entry exists.
  const template = STRINGS.get(key)!;
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!(name in params)) {
      throw new Error(`t('${key}'): missing parameter {${name}}`);
    }
    return encode(String(params[name]));
  });
}

/** Plain text; JSX escapes it where it lands. */
export function t(key: StringKey, params: StringParams = {}): string {
  return interpolate(key, params, (value) => value);
}

/**
 * A string whose English text carries markup (ABOUT_INTRO's attribution
 * link), for `dangerouslySetInnerHTML`. The template comes from the bundled
 * language file and is trusted; the parameters are escaped, so config or user
 * values can never inject markup through it.
 */
export function tHtml(key: StringKey, params: StringParams = {}): string {
  return interpolate(key, params, escapeHtml);
}
