import { type TSchema, Type } from '@sinclair/typebox';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { ROW_ID_MAX } from '../schemas';

/**
 * The shapes every /api/v1 resource shares (docs/plans/2026-11-12-json-
 * api.md section 2): lists, their opaque cursors, the stored lowercase
 * enums, and the rule that a null field is left out. A feature's mappers
 * (`src/web/<feature>/<resource>-resource.ts`) build on them.
 */

/** A stored enum's values as its schema: the spec lists them for a client. */
export function literals<T extends string | number>(values: readonly T[]) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

/**
 * An optional input field a client may set to null, which clears it (a
 * PATCH's absent field is left alone). Plain anyOf: only because /api
 * bodies are never coerced (jsonApiValidator, validator.ts); on a coercing
 * route a branch would turn a 0 into null, or a null into "".
 */
export function Nullable<T extends TSchema>(
  schema: T,
  options: { description?: string } = {},
) {
  return Type.Optional(Type.Union([schema, Type.Null()], options));
}

/** A list's page size: `limit`, the feature's own page by default, at most 100. */
export const LIST_LIMIT_MAX = 100;

export function ListLimit(byDefault: number) {
  return Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: LIST_LIMIT_MAX,
      default: byDefault,
      description: `How many a page holds: ${byDefault} unless asked, at most ${LIST_LIMIT_MAX}`,
    }),
  );
}

/** `?cursor=`: the previous page's `nextCursor`, as it was answered. */
export const ListCursor = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9_-]+$',
  description: "The previous page's `pagination.nextCursor`",
});

const Pagination = Type.Object(
  {
    /** Absent on the last page. */
    nextCursor: Type.Optional(Type.String()),
    limit: Type.Integer(),
  },
  { title: 'Pagination' },
);

/**
 * A list's answer: `{ data, pagination }`, plus whatever the route reads
 * with it (`extra`, the grid's `total`). Never a total by default: a count
 * costs a statement.
 */
export function ListOf<
  Item extends TSchema,
  Extra extends Record<string, TSchema>,
>(item: Item, options: { title: string; description: string; extra?: Extra }) {
  return Type.Object(
    {
      data: Type.Array(item),
      pagination: Pagination,
      ...(options.extra ?? ({} as Extra)),
    },
    { title: options.title, description: options.description },
  );
}

/**
 * A keyset cursor over row ids, newest first (the grid's `before`, #192a):
 * base64url, so a client treats it as opaque and a later keyset (a sort key
 * with the id) can change it without a new parameter.
 */
const ID_CURSOR = /^id:([1-9]\d{0,9})$/;

export function idCursor(id: number): string {
  return Buffer.from(`id:${id}`).toString('base64url');
}

/** The id an idCursor names; any other string is a 400 `validation`. */
export function readIdCursor(cursor: string): number {
  const match = ID_CURSOR.exec(Buffer.from(cursor, 'base64url').toString());
  const id = match ? Number(match[1]) : 0;
  if (id < 1 || id > ROW_ID_MAX) throw new HttpError(400, t('api.BAD_CURSOR'));
  return id;
}

/**
 * A position cursor, for a list whose order is not a keyset of its rows
 * (the trips: upcoming first, by a phase that moves with the day, #194a):
 * the count already answered. A row added or removed between pages shifts
 * the next one by it, which a short list re-read in full tolerates.
 */
const OFFSET_CURSOR = /^at:([1-9]\d{0,5})$/;

export function offsetCursor(offset: number): string {
  return Buffer.from(`at:${offset}`).toString('base64url');
}

/** The offset an offsetCursor names; any other string is a 400 `validation`. */
export function readOffsetCursor(cursor: string): number {
  const match = OFFSET_CURSOR.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match) throw new HttpError(400, t('api.BAD_CURSOR'));
  return Number(match[1]);
}

/** A mapped resource with its null fields left out, as the API sends them. */
export type WithoutNulls<T> = {
  [K in keyof T as null extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>;
};

/**
 * `value` without its null fields (one level: a nested object maps its own).
 * Needed, not cosmetic: Fastify serializes a null through a `string` schema
 * as `""`.
 */
export function withoutNulls<T extends object>(value: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== null),
  ) as WithoutNulls<T>;
}
