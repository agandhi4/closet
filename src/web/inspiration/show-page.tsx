import { PostForm } from '../auth/form';
import { AutosaveForm } from '../autosave';
import { inspirationPhotoUrl } from '../files/image-url';
import { FormField, inputAttributes } from '../form-field';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { PageMain } from '../layout/page-main';
import type { ViewContext } from '../view-context';
import { REFUSALS } from '../wardrobe/link-import/import';
import { linkHost, lookName } from './look-name';
import { LookPhotoUpload } from './photo-upload';
import {
  INSPIRATION_NOTE_MAX,
  INSPIRATION_TITLE_MAX,
  type InspirationDetail,
} from './queries';
import {
  deleteInspirationPath,
  INSPIRATION_PATH,
  inspirationPhotoPath,
  inspirationUrl,
} from './urls';
import type { UnreadReason } from './writes';

/**
 * GET /inspiration/:id, a saved look's page (#22): its photo (or the way to
 * add one: a link saved without its photo says once why, `?unread=`), its
 * link, its title and note saved as they change (AutosaveForm), and Delete.
 * The pieces read in it and "Recreate this look" come with 22b.
 */
export function InspirationPage(props: {
  ctx: ViewContext;
  look: InspirationDetail;
  unread: UnreadReason | undefined;
}) {
  const { ctx, look, unread } = props;
  const name = lookName(look);
  const photoAction = inspirationPhotoPath(look.id);
  return (
    <Layout ctx={ctx} title={name}>
      <AppBar ctx={ctx} title={name} back={INSPIRATION_PATH} />
      <PageMain class="p-4 pt-20 pb-24 flex flex-col gap-4">
        {unread && <UnreadNote reason={unread} />}
        {look.photo ? (
          <section class="flex flex-col gap-2">
            <img
              src={inspirationPhotoUrl(look.photo, 'original')}
              alt={t('inspiration.PHOTO_ALT', { title: name })}
              class="w-full rounded-box bg-base-200"
              decoding="async"
            />
            <LookPhotoUpload
              action={photoAction}
              source="library"
              label={t('inspiration.CHANGE_PHOTO')}
            />
          </section>
        ) : (
          <section
            class="flex flex-col gap-3 rounded-box bg-base-200 p-4"
            aria-labelledby="look-no-photo"
          >
            <p id="look-no-photo" class="text-sm text-muted">
              {t('inspiration.NO_PHOTO')}
            </p>
            <div class="flex gap-2">
              <LookPhotoUpload action={photoAction} source="camera" />
              <LookPhotoUpload action={photoAction} source="library" />
            </div>
          </section>
        )}
        {look.sourceUrl && (
          // Only ever http(s) (linkIn, and the column's check). A new tab, so
          // the app stays where it was; noopener keeps the page from
          // reaching back into this one, noreferrer from learning its URL.
          <a
            href={look.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="link link-primary text-sm self-start"
          >
            {t('inspiration.OPEN_LINK', { host: linkHost(look.sourceUrl) })}
          </a>
        )}
        <AutosaveForm
          action={inspirationUrl(look.id)}
          native
          class="flex flex-col gap-3"
        >
          <FormField id="look-title" label={t('inspiration.TITLE')}>
            <input
              {...inputAttributes('look-title', 'w-full')}
              type="text"
              name="title"
              value={look.title ?? ''}
              maxlength={INSPIRATION_TITLE_MAX}
              placeholder={t('inspiration.UNTITLED')}
            />
          </FormField>
          <FormField id="look-note" label={t('inspiration.NOTE')}>
            <textarea
              id="look-note"
              name="note"
              class="textarea textarea-bordered w-full"
              rows={3}
              maxlength={INSPIRATION_NOTE_MAX}
              placeholder={t('inspiration.NOTE_PLACEHOLDER')}
            >
              {look.note ?? ''}
            </textarea>
          </FormField>
        </AutosaveForm>
        <PostForm
          action={deleteInspirationPath(look.id)}
          confirm={t('inspiration.DELETE_CONFIRM')}
          class="mt-6"
        >
          <button type="submit" class="btn btn-error btn-outline btn-sm w-full">
            {t('inspiration.DELETE')}
          </button>
        </PostForm>
      </PageMain>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** Why a pasted link came without its photo, and the way round it. */
function UnreadNote({ reason }: { reason: UnreadReason }) {
  return (
    <div role="status" class="alert alert-warning alert-soft text-sm">
      <span class="flex flex-col gap-1">
        <span>
          {reason === 'no-photo'
            ? t('inspiration.UNREAD_NO_PHOTO')
            : `${t('inspiration.UNREAD')} ${t(REFUSALS[reason].message)}`}
        </span>
        <span>{t('inspiration.UNREAD_HINT')}</span>
      </span>
    </div>
  );
}
