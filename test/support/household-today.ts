import { loadConfig } from '../../src/config';
import { type IsoDate, todayIn } from '../../src/calendar-date';

/**
 * The day the server under test calls today, for the Playwright specs: the
 * app's own todayIn() at the APP_TIMEZONE the server resolves (the same
 * loadConfig() over the same environment and .env files: playwright.config.ts
 * starts the server with this process's environment). Never a UTC date
 * (toISOString): that is tomorrow every evening in New York. The integration
 * specs ask their in-process app instead (t.today(), harness.ts).
 */
export function householdToday(): IsoDate {
  return todayIn(loadConfig().APP_TIMEZONE, new Date());
}
