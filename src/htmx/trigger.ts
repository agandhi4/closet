/**
 * An `HX-Trigger` header naming one event and its detail, which htmx raises
 * on the element that asked. Escaped to ASCII: a header value is Latin-1 on
 * the wire and Node throws on anything past it (a curly quote in a message
 * would fail the reply), while htmx's JSON.parse reads the `\uXXXX` escapes
 * back. Used by the failure (src/web/errors.tsx) and the result of a write
 * (src/web/announce.ts).
 */
export function hxTrigger(event: string, detail: unknown): string {
  return JSON.stringify({ [event]: detail }).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
