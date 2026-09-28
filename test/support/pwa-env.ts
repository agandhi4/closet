/**
 * Overrides for an app with the PWA on, as production runs: the service
 * worker, the install prompt and Web Push (/push/*). The VAPID pair is a
 * throwaway from `npx web-push generate-vapid-keys`, never used by a
 * deployment; the sender checks it at boot and needs an https: subject,
 * hence SITE_URL.
 */
export const PWA_ENV: Record<string, string> = {
  PWA_ENABLED: 'true',
  SITE_URL: 'https://closet.test',
  PUBLIC_VAPID_KEY:
    'BIaV1uMypSUEcMFNiKX5wdEPfTc7liQhw-iTn3WN5TjIc-A0CiCF8jqaef8Vo1jB89cMgxM-FR7ghq0EVO2HlhE',
  PRIVATE_VAPID_KEY: 'xznGX5XpEHzBpfVxnrNyUPBjBbQwl4gtu8inPxMNQws',
};
