import { PostForm } from '../../auth/form';
import { t } from '../../i18n';
import { AppBar } from '../../layout/app-bar';
import { Dock } from '../../layout/dock';
import { Layout } from '../../layout/layout';
import type { ViewContext } from '../../view-context';
import {
  type Destination,
  destinationParams,
  LINK_IMPORT_PATH,
  wardrobeUrl,
  WISHLIST_PATH,
} from '../urls';
import { LINK_INPUT_MAX } from './import';

export interface LinkPageModel {
  /** The link in the field: shared into the app, or as last typed. */
  link: string;
  viewOwner: number | undefined;
  /** Where the garment lands: carried to the form in the post's URL. */
  destination: Destination;
  /** Why the last try was refused (a sentence without hosts or addresses). */
  error?: string;
}

/**
 * GET /wardrobe/new/from-link (and the manifest's share target), and the
 * same page again with the message when the link was refused. A native post
 * (PostForm): a refusal answers 4xx or 5xx, which htmx would not swap, and
 * success is the whole garment form page.
 */
export function LinkPage(props: { ctx: ViewContext; model: LinkPageModel }) {
  const { ctx, model } = props;
  const { viewOwner, destination } = model;
  const wishlist = destination.to === 'wishlist';
  const title = t(
    wishlist ? 'wishlist.ADD_FROM_LINK_TITLE' : 'linkImport.TITLE',
  );
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar
        ctx={ctx}
        title={title}
        back={wardrobeUrl(
          viewOwner,
          {},
          wishlist ? WISHLIST_PATH : '/wardrobe/new',
        )}
        formPage
      />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <p class="text-sm text-muted mb-4">{t('linkImport.INTRO')}</p>
        <PostForm
          action={wardrobeUrl(
            viewOwner,
            destinationParams(destination),
            LINK_IMPORT_PATH,
          )}
          class="flex flex-col gap-4"
        >
          <div class="flex flex-col">
            <label class="label" for="link-url">
              <span class="label-text">{t('linkImport.URL_LABEL')}</span>
            </label>
            <input
              id="link-url"
              type="url"
              name="url"
              inputmode="url"
              class={`input input-bordered w-full ${model.error ? 'input-error' : ''}`}
              value={model.link}
              maxlength={LINK_INPUT_MAX}
              placeholder={t('linkImport.URL_PLACEHOLDER')}
              autocomplete="off"
              required
              aria-invalid={model.error ? 'true' : undefined}
              aria-describedby={model.error ? 'link-url-error' : undefined}
            />
            {model.error && (
              <p
                id="link-url-error"
                class="text-error text-sm mt-1"
                role="alert"
              >
                {model.error}
              </p>
            )}
          </div>
          <button type="submit" class="btn btn-primary">
            {t('linkImport.FETCH')}
          </button>
          <p class="text-xs text-muted text-center">
            {t('linkImport.FETCH_HINT')}
          </p>
        </PostForm>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
