import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
import { FormField, inputAttributes } from '../form-field';
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
import { CancelLink } from '../layout/parts';

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
      <AppBar ctx={ctx} title={title} back={back} formPage />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <PostForm
          action={editing ? `/capsules/${capsuleId}` : '/capsules'}
          class="flex flex-col gap-4"
        >
          <FormField
            id="capsule-name"
            label={t('NAME')}
            required
            messages={errors.name}
          >
            <input
              {...inputAttributes('capsule-name', 'w-full', errors.name)}
              type="text"
              name="name"
              value={values.name}
              maxlength={CAPSULE_NAME_MAX}
              required
              placeholder={t('CAPSULE_NAME_PLACEHOLDER')}
            />
          </FormField>
          <FormField id="capsule-notes" label={t('NOTES')}>
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
          </FormField>
          <div class="flex gap-2 mt-2">
            <button type="submit" class="btn btn-primary flex-1">
              {t('SAVE')}
            </button>
            <CancelLink href={back} />
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
