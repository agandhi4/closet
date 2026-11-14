import type { Child } from 'hono/jsx';
import { jsonForScript } from '../html';
import { AppBar } from '../layout/app-bar';
import { BrandMark } from '../layout/brand-mark';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import type { ViewContext } from '../view-context';

/**
 * A one-form page: sign in, register, the account's forms, and Sharing's
 * edit-link step-up (its own module so sharing/pages.tsx, which Profile
 * imports, can use it without an import cycle through auth/pages.tsx).
 */
export function AccountShell(props: {
  ctx: ViewContext;
  /** The app bar's title, the page's h1. */
  title: string;
  /** The back arrow (the account's forms go back to Profile). */
  back?: string;
  /** Sign in and register: where signing in lands (return-to.ts). */
  returnTo?: string;
  /**
   * A public entry page's (sign in, register) link preview: the og tags
   * and the schema.org WebPage, both named by `ogTitle`, which stays meta
   * only: the h1 is `title`.
   */
  preview?: { ogTitle: string; description: string };
  children: Child;
}) {
  const { preview } = props;
  return (
    <Layout
      ctx={props.ctx}
      title={preview?.ogTitle ?? props.title}
      ogTitle={preview?.ogTitle}
      ogDescription={preview?.description}
    >
      <AppBar
        ctx={props.ctx}
        title={props.title}
        back={props.back}
        returnTo={props.returnTo}
      />
      {/* Centred while it fits; from the top once it does not, so nothing
          ends up under the fixed app bar, where no scroll reaches it. The
          padding clears the app bar and the dock, as on every other page. */}
      <main class="flex flex-col justify-center-safe items-center min-h-full gap-3 px-4 pt-20 pb-24">
        {preview && (
          <WebPageData
            ctx={props.ctx}
            name={preview.ogTitle}
            description={preview.description}
          />
        )}
        {!props.ctx.user && <BrandMark ctx={props.ctx} />}
        {props.children}
      </main>
      <Dock ctx={props.ctx} />
    </Layout>
  );
}

/** schema.org description of a public entry page, for link previews. */
function WebPageData(props: {
  ctx: ViewContext;
  name: string;
  description: string;
}) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: props.name,
    description: props.description,
    isPartOf: { '@id': `${props.ctx.siteUrl}/#website` },
  };
  return (
    <script
      type="application/ld+json"
      // Structured data is JSON by definition; jsonForScript keeps it
      // from closing the element.
      dangerouslySetInnerHTML={{ __html: jsonForScript(data) }}
    />
  );
}
