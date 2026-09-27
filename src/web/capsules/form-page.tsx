import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import type { ViewContext } from '../view-context';
import {
  CAPSULE_NAME_MAX,
  CAPSULE_NOTES_MAX,
  type CapsuleField,
} from './validation';

export interface CapsuleFormModel {
  /** Absent for a new capsule. */
  capsuleId?: number;
  values: { name: string; notes: string };
  errors?: FieldErrors<CapsuleField>;
}

/**
 * GET /capsules/new and /capsules/:id/edit (the owner's only), and their
 * re-render with the message when a post is refused (400): a native post
 * (PostForm), since htmx drops a boosted 4xx. The edit form also deletes
 * the capsule (its garments stay in the closet).
 */
export function CapsuleFormPage(props: {
  ctx: ViewContext;
  model: CapsuleFormModel;
}) {
  const { ctx, model } = props;
  const { capsuleId, values, errors = {} } = model;
  const editing = capsuleId !== undefined;
  const title = t(editing ? 'EDIT_CAPSULE' : 'NEW_CAPSULE');
  const back = editing ? `/capsules/${capsuleId}` : '/capsules';
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} title={title} back={back} />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <PostForm
          action={editing ? `/capsules/${capsuleId}` : '/capsules'}
          class="flex flex-col gap-4"
        >
          <div class="flex flex-col">
            <label class="label" for="capsule-name">
              <span class="label-text">{t('NAME')} *</span>
            </label>
            <input
              id="capsule-name"
              type="text"
              name="name"
              class={`input input-bordered w-full ${errors.name ? 'input-error' : ''}`}
              value={values.name}
              maxlength={CAPSULE_NAME_MAX}
              required
              placeholder={t('CAPSULE_NAME_PLACEHOLDER')}
              aria-invalid={errors.name ? 'true' : undefined}
            />
            {errors.name?.map((message) => (
              <p class="text-error text-sm mt-1">{message}</p>
            ))}
          </div>
          <div class="flex flex-col">
            <label class="label" for="capsule-notes">
              <span class="label-text">{t('NOTES')}</span>
            </label>
            <textarea
              id="capsule-notes"
              name="notes"
              class="textarea textarea-bordered w-full"
              rows={3}
              maxlength={CAPSULE_NOTES_MAX}
              placeholder={t('CAPSULE_NOTES_PLACEHOLDER')}
            >
              {values.notes}
            </textarea>
          </div>
          <div class="flex gap-2 mt-2">
            <button type="submit" class="btn btn-primary flex-1">
              {t('SAVE')}
            </button>
            <a href={back} class="btn btn-ghost">
              {t('CANCEL')}
            </a>
          </div>
        </PostForm>
        {editing && (
          <button
            type="button"
            class="btn btn-error btn-outline btn-sm w-full mt-8"
            hx-delete={`/capsules/${capsuleId}`}
            hx-confirm={t('CONFIRM_DELETE_CAPSULE')}
          >
            {t('DELETE_CAPSULE')}
          </button>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
