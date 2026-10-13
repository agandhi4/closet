import { migratedTemplate } from './scratch-database';

/**
 * Vitest globalSetup for the integration project: the migrated template
 * (scratch-database.ts) made once, before the workers start, so no spec file
 * waits on another's maker and the migrations run once per drizzle/ state,
 * not once per file. Runs after the sweep, which drops other builds' templates.
 */
export default async function setup(): Promise<void> {
  await migratedTemplate();
}
