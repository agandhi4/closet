import { t } from '../i18n';
import { OfflineIcon } from '../layout/app-status';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import type { ViewContext } from '../view-context';

/**
 * The service worker's navigation fallback (FALLBACK_HTML_URL in
 * views/assets/src-sw.ts), precached at install, possibly before sign-in: it
 * renders whatever session the install request had.
 */
export function OfflinePage({ ctx }: { ctx: ViewContext }) {
  return (
    <Layout ctx={ctx}>
      <Navbar ctx={ctx} />
      <main class="p-20 gap-2 flex flex-col justify-center items-center h-full">
        <div class="flex flex-row gap-2">
          <h1>{t('OFFLINE_TITLE')}</h1>
          <OfflineIcon class="size-6 text-error animate-pulse" />
        </div>
        <p>{t('OFFLINE_DESC')}</p>
        <a href="/" class="btn">
          {t('RETURN_TO_HOME')}
        </a>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
