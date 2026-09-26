import { resolve } from 'path';

// Repository root, for paths that live outside the compiled tree (public/,
// drizzle/, node_modules/). Resolved from this file rather than process.cwd() so
// it holds whether the app runs from src/ (Vitest) or dist/
// (node dist/main): both are exactly one level below the root.
export const PROJECT_ROOT = resolve(__dirname, '..');
