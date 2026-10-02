import { PostForm } from '../auth/form';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { CancelLink } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { itemFacts, itemTitle } from './labels';
import type { PlanDetail, PlanItemRow } from './queries';
import { itemUrl, planUrl } from './urls';
import { ITEM_NOTE_MAX } from './validation';

export interface ChangeItemModel {
  plan: PlanDetail;
  item: PlanItemRow;
  /** What was posted, when a blank note sends the form back (400). */
  note?: string;
  error?: boolean;
}

/**
 * GET /wardrobe/plans/:id/items/:itemId/change (#278): "Change this…" from
 * the plan page, for a proposal or an accepted item. The owner's note for
 * their agent is required (the agent has nothing to go on without it); the
 * item goes to `revise`, out of the plan's matching, until the agent's
 * update_plan_item proposes it again. The plan review asks the same in its
 * strips, with the rest of its post.
 */
export function ChangeItemPage(props: {
  ctx: ViewContext;
  model: ChangeItemModel;
}) {
  const { ctx, model } = props;
  const { plan, item } = model;
  const title = t('plans.CHANGE_TITLE', { item: itemTitle(item) });
  const facts = itemFacts(item);
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} title={title} back={planUrl(plan.id)} formPage />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto flex flex-col gap-3">
        <p class="text-sm text-muted truncate">{plan.name}</p>
        {facts.length > 0 && (
          <p class="text-xs text-muted">{facts.join(' · ')}</p>
        )}
        {item.note && <p class="text-xs italic">{item.note}</p>}
        <PostForm
          action={itemUrl(plan.id, item.id, '/change')}
          class="flex flex-col gap-3"
          needsNetwork
        >
          <label for="change-note" class="text-sm font-medium">
            {t('plans.REVIEW_NOTE_LABEL')}
          </label>
          <textarea
            id="change-note"
            name="note"
            rows={4}
            required
            maxlength={ITEM_NOTE_MAX}
            class={`textarea w-full ${model.error ? 'textarea-error' : ''}`}
            placeholder={t('plans.REVIEW_NOTE_PLACEHOLDER')}
            aria-describedby={model.error ? 'change-note-error' : undefined}
          >
            {model.note ?? ''}
          </textarea>
          {model.error && (
            <p id="change-note-error" class="text-sm text-error">
              {t('plans.REVIEW_NOTE_REQUIRED')}
            </p>
          )}
          <div class="flex gap-2">
            <button type="submit" class="btn btn-primary flex-1">
              {t('plans.SEND_TO_AGENT')}
            </button>
            <CancelLink href={planUrl(plan.id)} />
          </div>
        </PostForm>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
