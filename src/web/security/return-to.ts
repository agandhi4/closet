/**
 * The one check for a user-supplied "go back here" value (`?returnTo=` on
 * the outfit form, rendered as a link and posted back): only a path on this
 * site passes, anything else becomes `fallback`. A path is "/" alone or "/"
 * followed by a character that is neither "/" nor "\": "//evil.com" and
 * "/\evil.com" are protocol-relative URLs to another host (browsers read
 * "\" as "/"), and "javascript:" or "https://..." are not paths at all.
 * Control characters are refused too: browsers strip tabs and newlines
 * from URLs, so "/\t/evil.com" would become "//evil.com".
 */
export function safeReturnTo(
  value: string | undefined | null,
  fallback: string,
): string {
  if (!value) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value === '/' || /^\/[^/\\]/.test(value) ? value : fallback;
}
