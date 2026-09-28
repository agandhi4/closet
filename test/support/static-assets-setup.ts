import { precompress, syncClientModules } from '../../scripts/static-assets';

/**
 * Vitest globalSetup for the integration project: public/ as the build
 * leaves it for what the app serves from disk (the client libraries in
 * public/modules/, every precompressed variant), so the specs meet
 * production's static delivery without a build. Both steps skip what is
 * already current, so a repeat run costs a directory walk.
 */
export default function setup(): void {
  syncClientModules();
  precompress();
}
