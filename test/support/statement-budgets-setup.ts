import { afterAll } from 'vitest';
import { statementsOut, writeFragment } from './statement-budgets';

// Per spec file (a setupFile of the integration project): its counts, as a
// fragment the global teardown merges (statement-budgets.ts).
afterAll(() => {
  const out = statementsOut();
  if (out) writeFragment(out);
});
