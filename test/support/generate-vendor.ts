import { execFileSync } from 'child_process';

/**
 * Vitest globalSetup for the integration project: builds public/vendor/
 * (`npm run generate:vendor`, the step `npm run build` runs) so the specs
 * serve what a deployed build serves. The check job and the pre-commit hook
 * run this tier without a build; /vendor/sortable.min.js would be a 404 there.
 */
export default function setup(): void {
  execFileSync('npm', ['run', '--silent', 'generate:vendor'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
