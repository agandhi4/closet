/**
 * Helpers for the few places markup is built as a string instead of through
 * JSX, which escapes on its own. Both feed `dangerouslySetInnerHTML`.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text and attribute-safe escaping, the same set hono/jsx escapes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * JSON for the body of an inline <script> (an importmap, a data island).
 * JSON.stringify leaves `</script>` and `<!--` intact, and either would end or
 * derail the script element; `<` is the same character to the JSON and
 * JavaScript parsers.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
