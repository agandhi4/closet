/**
 * The tables of a persona's character bible (src/seed/personas/<name>.md).
 * The bibles are the seed's data, not a description of it: persona.ts turns
 * their tables into what the seed writes, so the story and the rows cannot
 * drift apart. Only GitHub-style pipe tables are read; the prose around them
 * is for people.
 */

/** A pipe table and the heading it sits under. */
export interface BibleTable {
  /** The nearest heading above the table, without its #s. */
  heading: string;
  columns: string[];
  /** Cells by column, in document order. */
  rows: Record<string, string>[];
}

/** A table the seed cannot read; names the bible and the row. */
export class BibleError extends Error {
  constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = 'BibleError';
  }
}

const HEADING = /^#{1,6}\s+(.*)$/;
const DIVIDER = /^\|(\s*:?-+:?\s*\|)+$/;

export function readTables(markdown: string, source: string): BibleTable[] {
  const tables: BibleTable[] = [];
  const lines = markdown.split(/\r?\n/);
  let heading = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const title = HEADING.exec(line);
    if (title) heading = title[1].trim();
    if (!line.startsWith('|') || !DIVIDER.test(lines[i + 1]?.trim() ?? '')) {
      continue;
    }
    const columns = cells(line);
    const rows: Record<string, string>[] = [];
    for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i += 1) {
      const values = cells(lines[i].trim());
      if (values.length !== columns.length) {
        throw new BibleError(
          source,
          `a row of "${heading}" has ${values.length} cells for ${columns.length} columns: ${lines[i]}`,
        );
      }
      rows.push(Object.fromEntries(columns.map((c, n) => [c, values[n]])));
    }
    tables.push({ heading, columns, rows });
  }
  return tables;
}

function cells(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** A cell's value without Markdown emphasis; '' for the empty mark `—`. */
export function plain(cell: string): string {
  const text = cell.replaceAll('**', '').trim();
  return text === '—' ? '' : text;
}

/** A comma-separated cell as its items; none for `—`. */
export function list(cell: string): string[] {
  const text = plain(cell);
  return text ? text.split(',').map((item) => item.trim()) : [];
}

/** The first link's address in a cell (`[title](https://...)`), if any. */
export function linkUrl(cell: string): string | undefined {
  return /\]\((https?:\/\/[^)\s]+)\)/.exec(cell)?.[1];
}
