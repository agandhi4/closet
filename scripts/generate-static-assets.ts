import path from 'path';
import { PUBLIC_DIR } from '../src/static-assets';
import { precompress, syncClientModules } from './static-assets';

// `npm run generate:modules` and `npm run generate:precompress` (both in
// `npm run build`); the steps themselves are in scripts/static-assets.ts.
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

const step = process.argv[2];
if (step === 'modules') {
  const { copied, removed } = syncClientModules();
  console.log(
    `public/modules: ${copied.length} copied${copied.length ? ` (${copied.join(', ')})` : ''}, ${removed.length} removed`,
  );
} else if (step === 'precompress') {
  const started = Date.now();
  const r = precompress();
  console.log(
    `Precompressed ${path.relative(process.cwd(), PUBLIC_DIR)}/: ${r.written} written` +
      (r.written ? ` (brotli ${kb(r.bytes)} -> ${kb(r.brotliBytes)})` : '') +
      `, ${r.current} current, ${r.removed} removed, ${Date.now() - started} ms`,
  );
} else {
  console.error('Usage: generate-static-assets.ts modules|precompress');
  process.exit(1);
}
