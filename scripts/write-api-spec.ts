import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { generateApiSpec, serializeSpec, SPEC_PATH } from './api-spec';

// `npm run api:spec`: regenerates the committed OpenAPI document after an
// /api/v1 contract change (scripts/api-spec.ts); commit the diff with it.
void generateApiSpec().then((spec) => {
  writeFileSync(SPEC_PATH, serializeSpec(spec));
  console.log(`Wrote ${relative(process.cwd(), SPEC_PATH)}`);
});
