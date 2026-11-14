import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './harness';

/**
 * A proxy missing from TRUSTED_PROXIES (#671, src/web/security/
 * untrusted-proxy.ts): one warning per boot and a degraded, non-failing
 * `trusted_proxies` check. The harness trusts 127.0.0.1 and ::1 only.
 */
describe('an untrusted proxy', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  const ready = async () => {
    const res = await t.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    return res.json().checks.trusted_proxies;
  };

  const forwarded = (peer: string) =>
    t.inject({
      method: 'GET',
      url: '/health/live',
      remoteAddress: peer,
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });

  const warnings = () =>
    t.logs
      .messages('warn', 'Security')
      .filter((m) => m.includes('TRUSTED_PROXIES'));

  it('is quiet for a trusted proxy and for a direct caller', async () => {
    await forwarded('127.0.0.1');
    await t.inject({
      method: 'GET',
      url: '/health/live',
      remoteAddress: '203.0.113.9',
    });
    expect(await ready()).toEqual({ status: 'up', required: false });
    expect(warnings()).toEqual([]);
  });

  it('warns once and degrades readiness, which stays 200', async () => {
    for (let n = 0; n < 5; n += 1) await forwarded('203.0.113.9');
    await forwarded('203.0.113.10');
    expect(warnings()).toEqual([
      expect.stringMatching(
        /^203\.0\.113\.9 sent X-Forwarded-For but is not in TRUSTED_PROXIES/,
      ),
    ]);
    const check = await ready();
    expect(check).toEqual({
      status: 'down',
      required: false,
      fix: 'see docs/operations.md#trusted-proxies',
    });
  });
});
