import fs from 'fs';
import path from 'path';
import {
  AREA_BUDGET,
  type AreaDoc,
  claudeMdProblems,
  kb,
  ROOT_BUDGET,
  ROOT_DOC,
} from './claude-md';

// `npm run docs:check`, part of `npm run check` (so the pre-commit hook and CI's static
// job) and the whole of .github/workflows/docs.yml (a docs-only push to main). The rules
// and why: scripts/claude-md.ts.
const PROJECT_ROOT = path.join(__dirname, '..');
const AREA_TREES = ['src', 'test', 'views', 'scripts', 'docs'];
const SKIPPED_DIRS = new Set(['node_modules']);

function areaDocs(dir: string): string[] {
  const absolute = path.join(PROJECT_ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory())
      return SKIPPED_DIRS.has(entry.name) ? [] : areaDocs(relative);
    return entry.name === 'CLAUDE.md' ? [relative] : [];
  });
}

const rootText = fs.readFileSync(path.join(PROJECT_ROOT, ROOT_DOC), 'utf8');
const areas: AreaDoc[] = AREA_TREES.flatMap(areaDocs).map((doc) => ({
  doc,
  size: fs.statSync(path.join(PROJECT_ROOT, doc)).size,
}));
const problems = claudeMdProblems(rootText, areas, (doc) =>
  fs.existsSync(path.join(PROJECT_ROOT, doc)),
);

if (problems.length > 0) {
  for (const problem of problems) console.error(`docs:check: ${problem}`);
  process.exit(1);
}

const largest = areas.reduce((a, b) => (b.size > a.size ? b : a));
console.log(
  `docs:check: ${ROOT_DOC} ${kb(Buffer.byteLength(rootText))} of ${kb(ROOT_BUDGET)}; ${areas.length} area docs, largest ${largest.doc} ${kb(largest.size)} of ${kb(AREA_BUDGET)}`,
);
