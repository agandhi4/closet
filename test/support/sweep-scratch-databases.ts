import { sweepStaleScratchDatabases } from './scratch-database';

/**
 * Vitest globalSetup for the integration project: before the run, drop the
 * scratch databases earlier killed runs left behind (see
 * sweepStaleScratchDatabases). Best effort: a sweep that cannot connect lets
 * the run go on and fail with createScratchDatabase's own message.
 */
export default async function setup(): Promise<void> {
  try {
    const dropped = await sweepStaleScratchDatabases(Date.now());
    if (dropped.length > 0) {
      console.log(`Dropped ${dropped.length} stale scratch database(s)`);
    }
  } catch (error) {
    console.warn(`Scratch database sweep skipped: ${String(error)}`);
  }
}
