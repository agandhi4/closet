import { describe, expect, it } from 'vitest';
import { isPushServiceEndpoint } from './endpoint';

describe('isPushServiceEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://api.push.apple.com/3/device/x',
    'https://wns2-by3p.notify.windows.com/w/?token=x',
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ])('accepts %s', (endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'https://127.0.0.1/push',
    'https://localhost/push',
    'https://10.0.0.5/push',
    'https://pgvault/push',
    'https://nas.box/push',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilpush.apple.com/x',
    'https://push.apple.com/x',
    'https://push.apple.com.evil.example/x',
    'not a url',
  ])('refuses %s', (endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(false);
  });
});
