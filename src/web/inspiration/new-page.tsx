import { FormField, inputAttributes } from '../form-field';
import { t } from '../i18n';
import { FormPage } from '../layout/form-page';
import type { ViewContext } from '../view-context';
import { LINK_INPUT_MAX } from '../wardrobe/link-import/import';
import { LookPhotoUpload } from './photo-upload';
import { INSPIRATION_LINK_PATH, INSPIRATION_PATH } from './urls';

export interface NewInspirationModel {
  /** The link as typed, kept when it was refused. */
  link: string;
  /** Why the link was refused (a 400 page). */
  error?: string;
}

/**
 * GET /inspiration/new, and its re-render (400) when a link was refused:
 * two ways in (#22). A photo (the camera, or the library for a screenshot
 * or a saved picture) posts at once and opens the new look; a link is the
 * frame's one native post (FormPage), fetched by the server
 * (POST /inspiration/link). Both disabled offline, with the frame's reason.
 */
export function NewInspirationPage(props: {
  ctx: ViewContext;
  model: NewInspirationModel;
}) {
  const { ctx, model } = props;
  const errors = model.error ? [model.error] : undefined;
  return (
    <FormPage
      ctx={ctx}
      title={t('inspiration.ADD_TITLE')}
      back={INSPIRATION_PATH}
      action={INSPIRATION_LINK_PATH}
      submitLabel={t('inspiration.SAVE_LINK')}
      intro={
        <section
          class="flex flex-col gap-3 mb-6"
          aria-labelledby="look-photo-title"
        >
          <p class="text-sm text-muted">{t('inspiration.ADD_HINT')}</p>
          <h2 id="look-photo-title" class="font-semibold">
            {t('inspiration.FROM_PHOTO')}
          </h2>
          <div class="flex gap-2">
            <LookPhotoUpload action={INSPIRATION_PATH} source="camera" />
            <LookPhotoUpload action={INSPIRATION_PATH} source="library" />
          </div>
          <h2 class="font-semibold mt-4">{t('inspiration.FROM_LINK')}</h2>
        </section>
      }
    >
      <FormField id="look-link" label={t('inspiration.LINK')} messages={errors}>
        {/* type="text": a share's "Title https://…" is valid input (linkIn
            finds the link), which type="url" would refuse. */}
        <input
          {...inputAttributes('look-link', 'w-full', errors)}
          type="text"
          inputmode="url"
          name="url"
          value={model.link}
          maxlength={LINK_INPUT_MAX}
          required
          placeholder={t('linkImport.URL_PLACEHOLDER')}
        />
      </FormField>
      <p class="text-xs text-muted -mt-2">{t('inspiration.LINK_HINT')}</p>
    </FormPage>
  );
}
