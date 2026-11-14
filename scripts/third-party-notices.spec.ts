import { describe, expect, it } from 'vitest';
import { buildNotices, clientModulePackages } from './third-party-notices';

describe('third-party notices', () => {
  const notices = buildNotices();
  const lines = notices.split('\n');

  it('has an entry for every package CLIENT_MODULES copies', () => {
    for (const name of clientModulePackages()) {
      expect(notices, name).toMatch(new RegExp(`^${name} {2}\\(`, 'm'));
    }
  });

  it('carries the OFL text of both webfonts', () => {
    for (const font of ['inter', 'fraunces']) {
      const start = lines.findIndex((line) =>
        line.startsWith(`@fontsource-variable/${font}  (`),
      );
      expect(start, font).toBeGreaterThan(-1);
      expect(lines.slice(start, start + 40).join('\n'), font).toContain(
        'SIL OPEN FONT LICENSE Version 1.1',
      );
    }
  });

  it('covers what sw.js bundles and what the icons and weather owe', () => {
    expect(notices).toMatch(/^workbox-core {2}\(/m);
    expect(notices).toContain('Heroicons');
    expect(notices).toContain('Hugeicons');
    expect(notices).toContain('Open-Meteo.com');
  });
});
