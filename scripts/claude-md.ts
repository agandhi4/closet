// The rules `npm run docs:check` (scripts/check-claude-md.ts) holds the CLAUDE.md docs to,
// a pure function of their text and sizes so scripts/claude-md.spec.ts can prove them.
// The root CLAUDE.md is loaded by every agent session; each area's CLAUDE.md only when a
// file in its directory is read (#104). The budgets keep the root from silently regrowing:
// new knowledge goes to its area's doc, and an area that outgrows its budget splits.
// The index check keeps the root's area index and the docs on disk in step.
export const ROOT_DOC = 'CLAUDE.md';
export const ROOT_BUDGET = 48 * 1024;
export const AREA_BUDGET = 16 * 1024;
const INDEX_HEADING = '### Area index';

export interface AreaDoc {
  /** Relative to the project root, POSIX separators (`src/seed/CLAUDE.md`). */
  doc: string;
  size: number;
}

export function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * The root's Area index section, its heading to the next heading; undefined
 * without one. A doc named anywhere else in the root (a Layout line, a "see")
 * is not indexed, so only this section counts (#119).
 */
export function areaIndex(rootText: string): string | undefined {
  const lines = rootText.split('\n');
  const start = lines.findIndex((line) => line.trim() === INDEX_HEADING);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('#'));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

export function claudeMdProblems(
  rootText: string,
  areas: AreaDoc[],
  exists: (doc: string) => boolean,
): string[] {
  const problems: string[] = [];
  const rootSize = Buffer.byteLength(rootText);
  if (rootSize > ROOT_BUDGET) {
    problems.push(
      `${ROOT_DOC} is ${kb(rootSize)}, over its ${kb(ROOT_BUDGET)} budget: move area detail to the area's CLAUDE.md`,
    );
  }

  const index = areaIndex(rootText);
  if (index === undefined) {
    problems.push(`${ROOT_DOC} has no "${INDEX_HEADING}" section`);
  }
  for (const { doc, size } of areas) {
    if (size > AREA_BUDGET) {
      problems.push(
        `${doc} is ${kb(size)}, over the ${kb(AREA_BUDGET)} area budget: split it (a subdirectory's CLAUDE.md or a sibling doc it links)`,
      );
    }
    if (index !== undefined && !index.includes(`\`${doc}\``)) {
      problems.push(`${doc} is not in ${ROOT_DOC}'s area index`);
    }
  }

  // The whole root, not only the index: a stale pointer misleads wherever it is.
  const named = new Set(
    Array.from(
      rootText.matchAll(/`([\w./-]+\/CLAUDE\.md)`/g),
      (match) => match[1],
    ),
  );
  for (const doc of named) {
    if (!exists(doc)) {
      problems.push(`${ROOT_DOC} names ${doc}, which does not exist`);
    }
  }
  return problems;
}
