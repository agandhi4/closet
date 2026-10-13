import {
  clearFragments,
  mergeFragments,
  statementsOut,
} from './statement-budgets';

/**
 * The integration project's global setup: with STATEMENTS_OUT, starts from
 * no fragments and, once every spec file ran, merges theirs into the file
 * (statement-budgets.ts). Without it, does nothing.
 */
export default function setup(): (() => void) | undefined {
  const out = statementsOut();
  if (!out) return undefined;
  clearFragments(out);
  return () => {
    const keys = mergeFragments(out);
    process.stdout.write(`statement budgets: ${keys} routes in ${out}\n`);
  };
}
