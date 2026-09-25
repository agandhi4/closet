import type {
  EnvironmentContext,
  JestEnvironmentConfig,
} from '@jest/environment';
import { TestEnvironment } from 'jest-environment-node';

/**
 * Jest's node environment with the process time zone pinned for one spec
 * file, so local-time Date methods behave the same on a laptop in New York
 * and on a UTC CI runner. A spec opts in with two docblock pragmas:
 * `@jest-environment ../test/support/timezone-environment.ts` and
 * `@jest-environment-options {"timeZone": "America/New_York"}`.
 * (The path is relative to the jest project's rootDir, `src/` for the unit
 * tier.) Setting `process.env.TZ` inside a test does nothing: the sandbox's
 * `process.env` is a copy, and only the real one's setter makes V8 reload
 * its zone. The environment runs outside the sandbox, so it sets the real
 * one and restores it on teardown for the next file in the worker.
 */
export default class TimeZoneEnvironment extends TestEnvironment {
  private readonly timeZone: string;
  private previousTimeZone: string | undefined;

  constructor(config: JestEnvironmentConfig, context: EnvironmentContext) {
    super(config, context);
    const { timeZone } = config.projectConfig.testEnvironmentOptions;
    if (typeof timeZone !== 'string' || !timeZone) {
      throw new Error(
        `${context.testPath}: @jest-environment-options needs a "timeZone"`,
      );
    }
    this.timeZone = timeZone;
  }

  async setup(): Promise<void> {
    await super.setup();
    this.previousTimeZone = process.env.TZ;
    process.env.TZ = this.timeZone;
  }

  async teardown(): Promise<void> {
    if (this.previousTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = this.previousTimeZone;
    }
    await super.teardown();
  }
}
