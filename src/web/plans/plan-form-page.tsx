import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import type { ViewContext } from '../view-context';
import { PLANS_PATH, planUrl } from './urls';
import { PLAN_NAME_MAX, PLAN_NOTES_MAX } from './validation';
import { CancelLink } from '../layout/parts';

export interface PlanFormModel {
  /** Absent for a new plan. */
  planId?: number;
  values: { name: string; notes: string };
  errors?: FieldErrors<'name'>;
}

/**
 * GET /wardrobe/plans/new and /wardrobe/plans/:id/edit, and their
 * re-render with the message when a post is refused (400): a native post
 * (PostForm), since htmx drops a boosted 4xx.
 */
export function PlanFormPage(props: {
  ctx: ViewContext;
  model: PlanFormModel;
}) {
  const { ctx, model } = props;
  const { planId, values, errors = {} } = model;
  const editing = planId !== undefined;
  const title = t(editing ? 'plans.EDIT_PLAN' : 'plans.NEW_PLAN');
  const back = editing ? planUrl(planId) : PLANS_PATH;
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} title={title} back={back} formPage />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <PostForm
          action={editing ? planUrl(planId) : PLANS_PATH}
          class="flex flex-col gap-4"
          needsNetwork
        >
          <div class="flex flex-col">
            <label class="label" for="plan-name">
              <span class="label-text">{t('NAME')} *</span>
            </label>
            <input
              id="plan-name"
              type="text"
              name="name"
              class={`input input-bordered w-full ${errors.name ? 'input-error' : ''}`}
              value={values.name}
              maxlength={PLAN_NAME_MAX}
              required
              placeholder={t('plans.NAME_PLACEHOLDER')}
              aria-invalid={errors.name ? 'true' : undefined}
            />
            {errors.name?.map((message) => (
              <p class="text-error text-sm mt-1">{message}</p>
            ))}
          </div>
          <div class="flex flex-col">
            <label class="label" for="plan-notes">
              <span class="label-text">{t('NOTES')}</span>
            </label>
            <textarea
              id="plan-notes"
              name="notes"
              class="textarea textarea-bordered w-full"
              rows={3}
              maxlength={PLAN_NOTES_MAX}
              placeholder={t('plans.NOTES_PLACEHOLDER')}
            >
              {values.notes}
            </textarea>
          </div>
          <div class="flex gap-2 mt-2">
            <button type="submit" class="btn btn-primary flex-1">
              {t('SAVE')}
            </button>
            <CancelLink href={back} />
          </div>
        </PostForm>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
