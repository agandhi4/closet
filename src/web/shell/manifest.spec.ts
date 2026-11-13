import { describe, expect, it } from 'vitest';
import { webManifest } from './manifest';

const config = { appName: 'Closet', iconName: 'icon.png' };

// Android's share sheet (#22d): one share_target, so one takes links and
// photos. The worker relays its POST (src-sw.ts) to POST /inspiration/share,
// which saves a photo as a look and sends a link to the link import
// (inspiration.spec.ts); with no worker to relay it, links alone, by GET.
describe('the manifest share target', () => {
  it('takes photos and links by a multipart POST the worker relays, with the PWA on', () => {
    expect(webManifest({ ...config, pwaEnabled: true }).share_target).toEqual({
      action: '/inspiration/share',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [{ name: 'photo', accept: ['image/*'] }],
      },
    });
  });

  it('takes links by GET to the link import, which fetches nothing, without it', () => {
    expect(webManifest({ ...config, pwaEnabled: false }).share_target).toEqual({
      action: '/wardrobe/new/from-link',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    });
  });
});
