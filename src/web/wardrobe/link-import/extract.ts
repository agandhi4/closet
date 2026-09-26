import type {
  GarmentCategory,
  Material,
  Warmth,
} from '../../../wardrobe/properties';
import type { GarmentColor } from '../garment';
import { BRAND_MAX, NAME_MAX } from '../validation';
import {
  guessColors,
  guessFabricWeight,
  guessKind,
  guessMaterials,
  guessWeightWarmth,
} from './guess';
import { decodeEntities, type DocumentMetadata, scanDocument } from './html';

/**
 * What a product page says about the garment on it, as garment form
 * prefills (issue #6; docs/plans/2026-09-26-wardrobe-features.md, section
 * 0). Sources in order of reliability: schema.org Product JSON-LD, then
 * Open Graph and product meta tags, then `<title>`; each field comes from
 * the first source that has it. Colour, category, type, materials and
 * weight are guessed from the words (guess.ts). Pure: HTML in, prefills out.
 *
 * The page is a stranger's and may be hostile or broken: nothing here
 * throws on any input, JSON-LD that does not parse is skipped, and every
 * value is bounded before it leaves.
 */

export interface ExtractedPrice {
  /** A plain decimal ("1299.00"), never a float, for a numeric column. */
  amount: string;
  /** ISO 4217, upper case, when the page says. */
  currency: string | null;
}

export type ExtractionSource = 'json-ld' | 'open-graph' | 'title';

export interface ExtractedProduct {
  /** The most reliable source that yielded anything; null for none. */
  source: ExtractionSource | null;
  name: string | null;
  brand: string | null;
  price: ExtractedPrice | null;
  colors: GarmentColor[];
  category: GarmentCategory | null;
  type: string | null;
  materials: Material[];
  /** Grams per square metre, only when the page states a weight. */
  fabricWeight: number | null;
  /** Only from "heavyweight"/"lightweight" words without a stated weight. */
  warmth: Warmth | null;
  /** Absolute http(s) image URLs, best first, without duplicates. */
  images: string[];
}

export const MAX_IMAGE_CANDIDATES = 8;
const MAX_URL_LENGTH = 2048;
const MAX_HINT_TEXT = 5000;

export function extractProduct(html: string, pageUrl: URL): ExtractedProduct {
  const document = scanDocument(html);
  // Most reliable first; a source that found nothing is null.
  const sources = [
    findProduct(document.jsonLd),
    openGraph(document),
    titleFields(document.title),
  ].filter((source) => source !== null);
  const fields = mergeFields(sources);
  return {
    source: sources[0]?.source ?? null,
    name: clip(fields.name, NAME_MAX),
    brand: clip(fields.brand, BRAND_MAX),
    price: fields.price,
    ...guessProperties(fields),
    images: absoluteImages(
      sources.flatMap((source) => source.images),
      baseUrl(document.baseHref, pageUrl),
    ),
  };
}

/** What one source says, as text; null where it says nothing. */
interface SourceFields {
  source: ExtractionSource;
  name: string | null;
  brand: string | null;
  color: string | null;
  material: string | null;
  description: string | null;
  category: string | null;
  price: ExtractedPrice | null;
  images: string[];
}

type MergedFields = Omit<SourceFields, 'source' | 'images'>;

const EMPTY_FIELDS: MergedFields = {
  name: null,
  brand: null,
  color: null,
  material: null,
  description: null,
  category: null,
  price: null,
};

/** Each field from the first source that has it. */
function mergeFields(sources: readonly SourceFields[]): MergedFields {
  const merged = { ...EMPTY_FIELDS };
  for (const key of Object.keys(EMPTY_FIELDS) as (keyof MergedFields)[]) {
    const from = sources.find((source) => source[key] !== null);
    if (from) Object.assign(merged, { [key]: from[key] });
  }
  return merged;
}

/**
 * The guesses from the words: the category from the name (else the page's
 * own category), the colour from the colour field (else the name), the
 * materials from the material field (else the name and description).
 */
function guessProperties(
  fields: MergedFields,
): Pick<
  ExtractedProduct,
  'colors' | 'category' | 'type' | 'materials' | 'fabricWeight' | 'warmth'
> {
  const hints = hintText(fields);
  const kind = kindOf(fields);
  const fabricWeight = guessFabricWeight(hints);
  return {
    colors: guessColors(fields.color ?? fields.name ?? ''),
    ...kind,
    materials: guessMaterials(fields.material ?? hints),
    fabricWeight,
    warmth:
      kind.category && fabricWeight === null
        ? guessWeightWarmth(hints, kind.category, kind.type)
        : null,
  };
}

/** Where material and weight are stated: the name, material and description. */
function hintText({ name, material, description }: MergedFields): string {
  return [name, material, description?.slice(0, MAX_HINT_TEXT)]
    .filter(Boolean)
    .join(' \n ');
}

function kindOf(
  fields: MergedFields,
): Pick<ExtractedProduct, 'category' | 'type'> {
  const kind = guessKind(fields.name ?? '') ?? guessKind(fields.category ?? '');
  return kind ?? { category: null, type: null };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const PRODUCT_TYPES = new Set([
  'product',
  'productgroup',
  'individualproduct',
  'productmodel',
]);
const MAX_DEPTH = 8;
const MAX_NODES = 5000;

/** The first Product node in the page's JSON-LD blocks. */
function findProduct(blocks: readonly string[]): SourceFields | null {
  for (const block of blocks) {
    const parsed = parseJsonLd(block);
    const node =
      parsed === undefined ? null : findProductNode(parsed, { nodes: 0 }, 0);
    if (node) return productFields(node);
  }
  return null;
}

/**
 * JSON-LD as pages really write it: sometimes wrapped in a comment or
 * CDATA, sometimes with raw newlines inside strings (which JSON forbids).
 * Undefined when it still does not parse.
 */
function parseJsonLd(raw: string): Json | undefined {
  const text = raw
    .trim()
    .replace(/^(?:<!--|<!\[CDATA\[)/, '')
    .replace(/(?:-->|\]\]>)$/, '')
    .trim();
  // eslint-disable-next-line no-control-regex -- raw control characters are the breakage being repaired
  for (const candidate of [text, text.replace(/[\u0000-\u001f]+/g, ' ')]) {
    try {
      return JSON.parse(candidate) as Json;
    } catch {
      // Try the next repair, then give up on this block.
    }
  }
  return undefined;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A node's @type names, without a vocabulary prefix, lower case. */
function typeNames(node: JsonObject): string[] {
  const type = node['@type'];
  const names = Array.isArray(type) ? type : [type];
  return names
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.replace(/^.*[/:#]/, '').toLowerCase());
}

/**
 * Depth-first through arrays, `@graph` and nested objects (a WebPage's
 * `mainEntity`), bounded in depth and node count so a hostile document
 * cannot make the walk expensive.
 */
function findProductNode(
  value: Json,
  budget: { nodes: number },
  depth: number,
): JsonObject | null {
  if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) return null;
  if (isObject(value) && typeNames(value).some((t) => PRODUCT_TYPES.has(t))) {
    return value;
  }
  for (const child of childNodes(value)) {
    const found = findProductNode(child, budget, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The arrays and objects inside an array or object. */
function childNodes(value: Json): Json[] {
  const children = Array.isArray(value)
    ? value
    : isObject(value)
      ? Object.values(value)
      : [];
  return children.filter((child) => typeof child === 'object' && child);
}

function productFields(node: JsonObject): SourceFields {
  // A ProductGroup (Shopify's variants) may keep offers and images on its
  // variants only.
  const variants = asArray(node.hasVariant).filter(isObject);
  return {
    source: 'json-ld',
    name: text(node.name),
    brand: text(node.brand) ?? text(node.manufacturer),
    color: text(node.color),
    material:
      asArray(node.material)
        .map((item) => text(item))
        .filter(Boolean)
        .join(', ') || null,
    description: text(node.description),
    category: text(node.category),
    price:
      offerPrice(node.offers) ??
      variants.map((v) => offerPrice(v.offers)).find(Boolean) ??
      null,
    images: [
      ...imageUrls(node.image),
      ...variants.flatMap((variant) => imageUrls(variant.image)),
    ],
  };
}

function asArray(value: Json | undefined): Json[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A value as display text: a string or number as it is, a Thing by its
 * name (`{"@type": "Brand", "name": "Acme"}`), a list by its first item.
 * Entities decoded (pages double-encode "Men&#39;s"), tags stripped,
 * whitespace collapsed.
 */
function text(value: Json | undefined, depth = 0): string | null {
  if (typeof value !== 'object' || value === null) return scalarText(value);
  if (depth > 2) return null;
  const candidates = Array.isArray(value)
    ? value
    : [value.name, value['@value']];
  for (const candidate of candidates) {
    const found = text(candidate, depth + 1);
    if (found) return found;
  }
  return null;
}

function scalarText(value: Json | undefined): string | null {
  if (typeof value === 'string') return cleanText(value);
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : null;
}

function cleanText(value: string): string | null {
  return (
    decodeEntities(value.replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim() || null
  );
}

/** A string (or a list, or an ImageObject's url/contentUrl) as URLs. */
function imageUrls(value: Json | undefined, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (depth > 2) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => imageUrls(item, depth + 1));
  }
  if (isObject(value)) {
    return imageUrls(value.contentUrl ?? value.url, depth + 1);
  }
  return [];
}

/** The first priced Offer (or AggregateOffer's lowPrice) with its currency. */
function offerPrice(offers: Json | undefined): ExtractedPrice | null {
  for (const offer of asArray(offers)) {
    if (!isObject(offer)) continue;
    const specification = asArray(offer.priceSpecification).find(isObject);
    const amount = parsePrice(
      offer.price ?? offer.lowPrice ?? specification?.price,
    );
    if (amount) {
      return {
        amount,
        currency: parseCurrency(
          offer.priceCurrency ?? specification?.priceCurrency,
        ),
      };
    }
  }
  return null;
}

/**
 * A positive amount as a plain decimal string: 29, "29.00", "$1,299.00",
 * "USD 120", "29,99" (a decimal comma). Null for anything else: 0 (a page's
 * "no price"), negatives, ranges ("10 - 20"), exponents, two numbers.
 */
export function parsePrice(value: Json | undefined): string | null {
  const raw =
    typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';
  const numbers = raw.match(/[\d.,]+/g);
  if (numbers?.length !== 1 || raw.includes('-')) return null;
  let digits = numbers[0];
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits)) {
    digits = digits.replace(/,/g, '');
  } else if (/^\d+,\d{1,2}$/.test(digits)) {
    digits = digits.replace(',', '.');
  }
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(digits) || Number(digits) <= 0) {
    return null;
  }
  return digits;
}

function parseCurrency(value: Json | undefined): string | null {
  return typeof value === 'string' && /^[a-z]{3}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : null;
}

/**
 * Open Graph, its product: extension, and the Twitter card's image; null
 * when the page has none of the product ones (a plain description meta tag
 * alone is not a product).
 */
function openGraph(document: DocumentMetadata): SourceFields | null {
  const all = (...keys: string[]) =>
    keys.flatMap((key) => document.metas.get(key) ?? []);
  const first = (...keys: string[]) => {
    const value = all(...keys)[0];
    return value === undefined ? null : cleanText(value);
  };
  const amount = parsePrice(all('product:price:amount', 'og:price:amount')[0]);
  const fields: SourceFields = {
    source: 'open-graph',
    name: first('og:title', 'twitter:title'),
    brand: first('product:brand', 'og:brand'),
    color: first('product:color'),
    material: null,
    description: first('og:description', 'description'),
    category: null,
    price: amount
      ? {
          amount,
          currency: parseCurrency(
            all('product:price:currency', 'og:price:currency')[0],
          ),
        }
      : null,
    images: all(
      'og:image:secure_url',
      'og:image',
      'og:image:url',
      'twitter:image',
      'twitter:image:src',
    ),
  };
  const found =
    fields.name ??
    fields.brand ??
    fields.color ??
    fields.price ??
    fields.images[0];
  return found ? fields : null;
}

/** The last resort: `<title>` without the site's name after the last bar. */
function titleFields(title: string | null): SourceFields | null {
  if (!title) return null;
  const bar = title.lastIndexOf(' | ');
  return {
    ...EMPTY_FIELDS,
    source: 'title',
    name: bar > 0 ? title.slice(0, bar).trim() : title,
    images: [],
  };
}

function clip(value: string | null | undefined, max: number): string | null {
  return value ? value.slice(0, max).trim() : null;
}

/** `<base href>` when it is an http(s) URL, else the page's own URL. */
function baseUrl(baseHref: string | null, pageUrl: URL): URL {
  if (!baseHref) return pageUrl;
  try {
    const base = new URL(baseHref, pageUrl);
    return base.protocol === 'http:' || base.protocol === 'https:'
      ? base
      : pageUrl;
  } catch {
    return pageUrl;
  }
}

/**
 * Candidates resolved against the page (protocol-relative CDN URLs
 * included), http(s) only, fragments dropped, each once, at most
 * MAX_IMAGE_CANDIDATES. Fetching them is outbound-fetch's job, which
 * checks each again: a URL here is only a string.
 */
function absoluteImages(candidates: readonly string[], base: URL): string[] {
  const images: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > MAX_URL_LENGTH) continue;
    let url: URL;
    try {
      url = new URL(trimmed, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    if (url.href.length > MAX_URL_LENGTH || images.includes(url.href)) {
      continue;
    }
    images.push(url.href);
    if (images.length === MAX_IMAGE_CANDIDATES) break;
  }
  return images;
}
