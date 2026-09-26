import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SharePermission } from '../db/schema';
import { PROJECT_ROOT } from '../project-root';
import { type IsoDate, parseIsoDate } from '../web/calendar/calendar-date';
import { normalizeCategory } from '../web/wardrobe/garment';
import {
  GarmentBody,
  type GarmentFields,
  readGarmentForm,
} from '../web/wardrobe/validation';
import {
  categoryRole,
  GARMENT_ROLES,
  GarmentCategory,
  type GarmentRole,
} from '../wardrobe/properties';
import {
  BibleError,
  type BibleTable,
  linkUrl,
  list,
  plain,
  readTables,
} from './bible';
import { BANDS, type Band } from './weather';

/**
 * A persona as the seed writes it, read from its character bible
 * (src/seed/personas/<key>.md) and checked against the app's own rules
 * before anything is written: every garment goes through the garment
 * form's schema and readGarmentForm, and a value the form would drop (a
 * type from another category, a sleeve on shoes) is an error, not a
 * silently different wardrobe.
 */

export const PERSONA_KEYS = ['demo', 'fresh', 'sparse'] as const;
export type PersonaKey = (typeof PERSONA_KEYS)[number];

export function isPersonaKey(value: string): value is PersonaKey {
  return (PERSONA_KEYS as readonly string[]).includes(value);
}

/** What a saved outfit is for; a day draws from some of these (its week row). */
export const OCCASIONS = [
  'office',
  'meeting',
  'rain',
  'weekend',
  'wfh',
  'workout',
  'date',
  'night-out',
  'formal',
  'travel',
  'beach',
] as const;
export type Occasion = (typeof OCCASIONS)[number];

export interface SeedGarment {
  /** The bible's id (T01), which outfits and events refer to. */
  id: string;
  /** As the garment form stores it (readGarmentForm's result). */
  fields: GarmentFields;
  role: GarmentRole;
  /** Copies owned (the white tees x3); one row each until quantities exist (#7). */
  quantity: number;
  archivedOn: IsoDate | null;
  /** Whether the garment has a (generated) photo. */
  photo: boolean;
}

export interface SeedOutfit {
  /** null: untitled. */
  name: string | null;
  favourite: boolean;
  /** None: saved, never drawn. */
  occasions: Occasion[];
  bands: Band[];
  /** Garment ids in builder order (outfitSlotOrder). */
  garmentIds: string[];
}

export interface SeedEvent {
  from: IsoDate;
  to: IsoDate;
  name: string;
  /** The saved outfit worn (by name); undefined when the rules decide. */
  wears: string | undefined;
  /** False: the day is not logged at all (he forgot). */
  recorded: boolean;
  /** °F added to the day's high. */
  weatherShift: number;
}

export type LaundrySelector =
  | { role: GarmentRole }
  | { types: string[] }
  | { garmentId: string };

export interface LaundryRule {
  selector: LaundrySelector;
  /** Wears before a wash; null: never washed. */
  wears: number | null;
}

export interface Persona {
  key: PersonaKey;
  account: { email: string; firstName: string; lastName: string };
  /** Personas this one shares its wardrobe with, once both exist. */
  sharesWith: { persona: PersonaKey; permission: SharePermission }[];
  garments: SeedGarment[];
  outfits: SeedOutfit[];
  /** Sunday first: the occasions each weekday draws from; null without a history. */
  week: Occasion[][] | null;
  events: SeedEvent[];
  laundry: LaundryRule[];
}

/** Where the bibles live, from src/ and dist/ alike (the image copies them). */
export const PERSONAS_DIR = join(PROJECT_ROOT, 'src', 'seed', 'personas');

export function loadPersona(key: PersonaKey): Persona {
  const path = join(PERSONAS_DIR, `${key}.md`);
  return parsePersona(key, readFileSync(path, 'utf8'));
}

export function parsePersona(key: PersonaKey, markdown: string): Persona {
  const source = `${key}.md`;
  const tables = readTables(markdown, source);
  const find = (...columns: string[]) =>
    tables.filter((table) => columns.every((c) => table.columns.includes(c)));
  const account = find('Field', 'Value')[0];
  if (!account) throw new BibleError(source, 'no Account table');
  const fields = Object.fromEntries(
    account.rows.map((row) => [row.Field, plain(row.Value)]),
  );
  const garments = find('id', 'Colours').flatMap((table) =>
    table.rows.map((row) => readGarment(source, table, row)),
  );
  const ids = new Set(garments.map((g) => g.id));
  const outfits = find('Garments', 'Occasion').flatMap((table) =>
    table.rows.map((row) => readOutfit(source, row, ids)),
  );
  const names = new Set(outfits.flatMap((o) => o.name ?? []));
  const week = find('Day', 'Draws from')[0];
  return {
    key,
    account: {
      email: required(source, fields, 'Email'),
      firstName: required(source, fields, 'First name'),
      lastName: required(source, fields, 'Last name'),
    },
    sharesWith: list(fields['Shares with'] ?? '').map((share) =>
      readShare(source, share),
    ),
    garments,
    outfits,
    week: week ? readWeek(source, week) : null,
    events: find('From', 'To', 'Wears').flatMap((table) =>
      table.rows.map((row) => readEvent(source, row, names)),
    ),
    laundry: find('Garments', 'Wears before a wash').flatMap((table) =>
      table.rows.map((row) => readLaundryRule(source, row, ids)),
    ),
  };
}

function required(
  source: string,
  fields: Record<string, string>,
  name: string,
): string {
  const value = fields[name];
  if (!value) throw new BibleError(source, `Account has no ${name}`);
  return value;
}

function readShare(source: string, share: string): Persona['sharesWith'][0] {
  const match = /^(\w+) \((VIEW|MANAGE)\)$/.exec(share);
  if (!match || !isPersonaKey(match[1])) {
    throw new BibleError(source, `"Shares with" names no persona: ${share}`);
  }
  return {
    persona: match[1],
    permission: match[2] as SharePermission,
  };
}

// The garment tables' columns and the form field each fills. A column the
// seed does not know is an error, so a renamed header cannot quietly drop
// a property.
const FORM_COLUMNS: Record<string, string> = {
  'Name in the app': 'name',
  Brand: 'brand',
  Size: 'size',
  Warmth: 'warmth',
  'Form.': 'formality',
  Pattern: 'pattern',
  Fit: 'fit',
  Sleeve: 'sleeve',
  Length: 'length',
  Acquired: 'dateAquired',
  'Why he owns it': 'notes',
  Notes: 'notes',
};
const OTHER_COLUMNS = new Set([
  'id',
  'Type',
  'Category',
  'Category / type',
  'Colours',
  'Materials',
  'Product',
  'Price',
  'Weight',
  'WR',
  'Qty',
  'Archived',
  'Photo',
]);

function readGarment(
  source: string,
  table: BibleTable,
  row: Record<string, string>,
): SeedGarment {
  const id = row.id;
  const where = `${source} ${id}`;
  const post = textFields(source, row);
  // A column the table does not have reads as empty.
  const cell = (column: string) => row[column] ?? '';
  const { category, type } = readCategory(where, table, row);
  Object.assign(post, {
    category,
    type: type ?? '',
    color: list(cell('Colours')),
    materials: list(cell('Materials')),
    fabricWeight: /^([\d.]+) oz$/.exec(plain(cell('Weight')))?.[1] ?? '',
    waterResistant: plain(cell('WR')) === 'yes' ? 'true' : undefined,
    sourceUrl: linkUrl(cell('Product')) ?? '',
    price: /\$[\d,]+(?:\.\d{1,2})?/.exec(cell('Price'))?.[0] ?? '',
  });
  const fields = storedFields(where, post);
  return {
    id,
    fields,
    role: categoryRole(fields.category),
    quantity: Number(plain(cell('Qty')) || 1),
    archivedOn: readDate(where, plain(cell('Archived'))),
    photo: plain(cell('Photo')) !== 'no',
  };
}

// The columns that are form fields as they are, as the form posts them.
function textFields(
  source: string,
  row: Record<string, string>,
): Record<string, unknown> {
  const post: Record<string, unknown> = {
    props: '1',
    product: '1',
    fabricWeightUnit: 'oz',
  };
  for (const [column, cell] of Object.entries(row)) {
    const field = FORM_COLUMNS[column];
    // A hand-set warmth or formality is marked `*`; the value is the same.
    if (field) post[field] = plain(cell).replace(/\*$/, '');
    else if (!OTHER_COLUMNS.has(column)) {
      throw new BibleError(source, `unknown garment column "${column}"`);
    }
  }
  return post;
}

// The category from its own column, or from the section heading ("Tops").
function readCategory(
  where: string,
  table: BibleTable,
  row: Record<string, string>,
): { category: string; type: string | null } {
  const combined = row['Category / type'];
  if (combined !== undefined) {
    const [category, type] = plain(combined).split('/');
    return { category: category.trim(), type: type?.trim() || null };
  }
  const category = row.Category ?? normalizeCategory(table.heading);
  if (!category) throw new BibleError(where, 'no category');
  return { category: plain(category), type: plain(row.Type ?? '') || null };
}

// The post through both of the form's layers: the route's schema (a value
// outside a property's set is refused there) and readGarmentForm; then
// every posted value must have been kept.
function storedFields(
  where: string,
  post: Record<string, unknown>,
): GarmentFields {
  let body: GarmentBody;
  try {
    body = Value.Parse(GarmentBody, post);
  } catch (error) {
    throw new BibleError(where, `not a garment form post: ${String(error)}`);
  }
  const form = readGarmentForm(body);
  if (!form.ok) {
    throw new BibleError(where, JSON.stringify(form.errors));
  }
  const dropped = [
    'type',
    'warmth',
    'formality',
    'pattern',
    'fit',
    'sleeve',
    'length',
    'fabricWeight',
    'sourceUrl',
    'price',
  ].filter(
    (name) => post[name] && form.fields[name as keyof GarmentFields] === null,
  );
  if (post.waterResistant && !form.fields.waterResistant) {
    dropped.push('waterResistant');
  }
  if ((post.materials as string[]).length > 0 && !form.fields.materials) {
    dropped.push('materials');
  }
  if (dropped.length > 0) {
    throw new BibleError(
      where,
      `the garment form drops ${dropped.join(', ')} for category ${form.fields.category}`,
    );
  }
  return form.fields;
}

function readDate(where: string, text: string): IsoDate | null {
  if (!text) return null;
  const day = parseIsoDate(text);
  if (!day) throw new BibleError(where, `not a date: ${text}`);
  return day;
}

// Builder order: an outfit's slots are written layer first, as the builder
// lists its rows; categories the list lacks come last.
const SLOT_ORDER: readonly string[] = [
  GarmentCategory.OUTERWEAR,
  GarmentCategory.DRESSES,
  GarmentCategory.TOPS,
  GarmentCategory.BOTTOMS,
  GarmentCategory.FOOTWEAR,
  GarmentCategory.ACCESSORIES,
  GarmentCategory.BAGS,
  GarmentCategory.OTHER,
];

/** Slot order of a garment's category (outfits write their slots in it). */
export function slotRank(category: string): number {
  const rank = SLOT_ORDER.indexOf(category);
  return rank === -1 ? SLOT_ORDER.length : rank;
}

function readOutfit(
  source: string,
  row: Record<string, string>,
  garmentIds: Set<string>,
): SeedOutfit {
  const title = plain(row.Name);
  const favourite = title.endsWith(' *');
  const name = favourite ? title.slice(0, -2) : title;
  const where = `${source} outfit "${name || row['#']}"`;
  const garments = [...row.Garments.matchAll(/\b[A-Z]\d{2}\b/g)].map(
    ([id]) => id,
  );
  const unknown = garments.filter((id) => !garmentIds.has(id));
  if (unknown.length > 0 || garments.length === 0) {
    throw new BibleError(where, `unknown garments: ${unknown.join(', ')}`);
  }
  const occasions = list(row.Occasion);
  const wrong = occasions.filter(
    (o) => !(OCCASIONS as readonly string[]).includes(o),
  );
  if (wrong.length > 0) {
    throw new BibleError(where, `unknown occasions: ${wrong.join(', ')}`);
  }
  return {
    name: name || null,
    favourite,
    occasions: occasions as Occasion[],
    bands: readBands(where, plain(row.Bands)),
    garmentIds: garments,
  };
}

function readBands(where: string, text: string): Band[] {
  if (text === 'any') return [...BANDS];
  const bands = list(text);
  const wrong = bands.filter((b) => !(BANDS as readonly string[]).includes(b));
  if (wrong.length > 0) {
    throw new BibleError(where, `unknown bands: ${wrong.join(', ')}`);
  }
  return bands as Band[];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function readWeek(source: string, table: BibleTable): Occasion[][] {
  return WEEKDAYS.map((day) => {
    const row = table.rows.find((r) => r.Day === day);
    if (!row) throw new BibleError(source, `the week has no ${day}`);
    const draws = list(row['Draws from']);
    const wrong = draws.filter(
      (o) => !(OCCASIONS as readonly string[]).includes(o),
    );
    if (wrong.length > 0 || draws.length === 0) {
      throw new BibleError(source, `${day} draws from ${row['Draws from']}`);
    }
    return draws as Occasion[];
  });
}

function readEvent(
  source: string,
  row: Record<string, string>,
  outfitNames: Set<string>,
): SeedEvent {
  const where = `${source} event ${row.From}`;
  const wears = plain(row.Wears);
  if (wears && wears !== 'not recorded' && !outfitNames.has(wears)) {
    throw new BibleError(where, `no saved outfit is called "${wears}"`);
  }
  const shift = plain(row.Weather);
  return {
    from: readDate(where, row.From)!,
    to: readDate(where, row.To)!,
    name: row.Event,
    wears: wears === 'not recorded' ? undefined : wears || undefined,
    recorded: wears !== 'not recorded',
    weatherShift: shift ? Number(shift) : 0,
  };
}

function readLaundryRule(
  source: string,
  row: Record<string, string>,
  garmentIds: Set<string>,
): LaundryRule {
  const selector = plain(row.Garments);
  const wears = plain(row['Wears before a wash']);
  const rule = { wears: wears === 'never' ? null : Number(wears) };
  if (rule.wears !== null && !(rule.wears > 0)) {
    throw new BibleError(source, `laundry: "${wears}" is not a count`);
  }
  if (selector.startsWith('type:')) {
    return { ...rule, selector: { types: list(selector.slice(5)) } };
  }
  if (garmentIds.has(selector)) {
    return { ...rule, selector: { garmentId: selector } };
  }
  if ((GARMENT_ROLES as readonly string[]).includes(selector)) {
    return { ...rule, selector: { role: selector as GarmentRole } };
  }
  throw new BibleError(source, `laundry: "${selector}" selects nothing`);
}
