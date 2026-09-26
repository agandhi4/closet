import { t, tHtml } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import type { ViewContext } from '../view-context';

export function AboutPage({ ctx }: { ctx: ViewContext }) {
  const appName = ctx.appName;
  return (
    <Layout
      ctx={ctx}
      title={t('ABOUT_TITLE')}
      ogTitle={t('ABOUT_OG_TITLE', { appName })}
      ogDescription={t('ABOUT_OG_DESC', { appName })}
    >
      <Navbar ctx={ctx} />
      <main class="flex flex-col items-center py-16 px-4">
        <div class="max-w-2xl w-full prose">
          <h1 class="text-3xl font-bold mb-8">
            {t('ABOUT_HEADING', { appName })}
          </h1>
          {/* ABOUT_INTRO carries the upstream attribution link (the one
              permitted upstream reference, CLAUDE.md Gotchas). */}
          <p
            class="mb-6"
            dangerouslySetInnerHTML={{
              __html: tHtml('ABOUT_INTRO', { appName }),
            }}
          />
          <h2 class="text-xl font-semibold mt-8 mb-3">
            {t('ABOUT_OPEN_SOURCE')}
          </h2>
          <p class="mb-6">{t('ABOUT_OPEN_SOURCE_DESC', { appName })}</p>
          <h2 class="text-xl font-semibold mt-8 mb-3">{t('ABOUT_TECH')}</h2>
          <p class="mb-6">{t('ABOUT_TECH_DESC')}</p>
          <p class="text-sm text-base-content/60">
            {t('APP_VERSION')} {ctx.appRelease}
          </p>
        </div>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
