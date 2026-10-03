import pino from 'pino';
import { loadConfig } from '../../src/config';
import { loadPersona } from '../../src/seed/persona';
import { seedPersona } from '../../src/seed/seed';
import { createPhotos, photosConfig } from '../../src/web/files/photos';
import { E2E_PASSWORD } from './e2e-session';
import { householdToday } from './household-today';
import { withServerDb } from './server-db';

/**
 * The demo persona's wardrobe (src/seed/personas/demo.md: its garments,
 * photos, outfits and calendar) under a new account of its own, seeded into
 * the server's database at the household's today; its email, which signs in
 * with E2E_PASSWORD. Not the persona's own account: screenshots.spec.ts
 * resets that one (--reset) while other specs run beside it in CI.
 */
export async function seedDemoAs(prefix: string): Promise<string> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const demo = loadPersona('demo');
  const config = loadConfig();
  const logger = pino({ level: 'silent' });
  await withServerDb(async (db) => {
    const report = await seedPersona(
      {
        db,
        photos: createPhotos(photosConfig(config), db, logger),
        logger,
        timeZone: config.APP_TIMEZONE,
        weatherEnabled: config.WEATHER_ENABLED,
      },
      { ...demo, account: { ...demo.account, email } },
      { anchor: householdToday(), password: E2E_PASSWORD },
    );
    if (!report) throw new Error(`${email} already existed`);
  });
  return email;
}
