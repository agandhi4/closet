/**
 * A link inside typed or shared text. A module of its own, importing
 * nothing, because the service worker's bundle imports it too: a share
 * without a photo is sent to the link page with its link alone
 * (src/web/inspiration/share-target.ts).
 */

/**
 * The link field's cap (and the posted link's). Longer than the fetcher's
 * own URL cap, so a pasted line with words around the link still reaches
 * linkIn, and an over-long link is the fetcher's refusal with its message.
 */
export const LINK_INPUT_MAX = 4096;

// Up to the first whitespace; the characters a sentence puts right after a
// link are not part of it.
const UTF8 = new TextEncoder();
const LINK = /https?:\/\/\S+/i;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"»”’]+$/;

/**
 * The first http(s) link in `text`: what a person pasted, or what a share
 * sheet sent (Android puts the link in `text`, often after the page's
 * title). Undefined when there is none.
 */
export function linkIn(text: string): string | undefined {
  return LINK.exec(text)?.[0].replace(TRAILING_PUNCTUATION, '');
}

/**
 * A link the server stores for a look (POST /inspiration's `url`; the
 * column's check reads `^https?://`): one absolute http(s) URL that parses,
 * within LINK_INPUT_MAX. The worker applies it too, so a share's link that
 * the server would refuse is dropped, never posted.
 */
export function isStorableLink(value: string): boolean {
  // Bytes, not UTF-16 units: busboy's fieldSize on the server counts bytes,
  // so an IRI the worker passed would otherwise be cut and refused there.
  return (
    UTF8.encode(value).length <= LINK_INPUT_MAX &&
    /^https?:\/\/\S+$/i.test(value) &&
    URL.canParse(value)
  );
}

/**
 * `text` cut to at most `max` UTF-16 units without splitting a surrogate
 * pair: a lone surrogate makes encodeURIComponent throw.
 */
export function clipText(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
