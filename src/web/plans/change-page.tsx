import { PostForm } from '../auth/form';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { CancelLink } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { itemFacts, itemTitle } from './labels';
import { LookFace } from './look-tile';
import type { PlanLookView } from './looks';
import type { PlanDetail, PlanItemRow } from './queries';
import { itemUrl, lookUrl, planUrl } from './urls';
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
        <NoteForm
          action={itemUrl(plan.id, item.id, '/change')}
          back={planUrl(plan.id)}
          note={model.note}
          error={model.error}
        />
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

export interface ChangeLookModel {
  plan: PlanDetail;
  look: PlanLookView;
  /** What was posted, when a blank note sends the form back (400). */
  note?: string;
  error?: boolean;
}

/**
 * GET /wardrobe/plans/:id/looks/:lookId/change (#291): "Change this…" of a
 * look from the plan page, for one to review or loved. As an item's: the
 * note is required, and the look waits on the agent (`revise`) until its
 * update_look proposes it again. The review asks the same on its tiles.
 */
export function ChangeLookPage(props: {
  ctx: ViewContext;
  model: ChangeLookModel;
}) {
  const { ctx, model } = props;
  const { plan, look } = model;
  const title = t('plans.CHANGE_TITLE', { item: look.name });
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} title={title} back={planUrl(plan.id)} formPage />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto flex flex-col gap-3">
        <p class="text-sm text-muted truncate">{plan.name}</p>
        <div class="w-56 self-center flex flex-col gap-1">
          <LookFace look={look} eager />
        </div>
        <NoteForm
          action={lookUrl(plan.id, look.id, '/change')}
          back={planUrl(plan.id)}
          note={model.note}
          error={model.error}
        />
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** The note for the agent, required, and Send to my agent. */
function NoteForm(props: {
  action: string;
  back: string;
  note?: string;
  error?: boolean;
}) {
  return (
    <PostForm action={props.action} class="flex flex-col gap-3" needsNetwork>
      <label for="change-note" class="text-sm font-medium">
        {t('plans.REVIEW_NOTE_LABEL')}
      </label>
      <textarea
        id="change-note"
        name="note"
        rows={4}
        required
        maxlength={ITEM_NOTE_MAX}
        class={`textarea w-full ${props.error ? 'textarea-error' : ''}`}
        placeholder={t('plans.REVIEW_NOTE_PLACEHOLDER')}
        aria-describedby={props.error ? 'change-note-error' : undefined}
      >
        {props.note ?? ''}
      </textarea>
      {props.error && (
        <p id="change-note-error" class="text-sm text-error">
          {t('plans.REVIEW_NOTE_REQUIRED')}
        </p>
      )}
      <div class="flex gap-2">
        <button type="submit" class="btn btn-primary flex-1">
          {t('plans.SEND_TO_AGENT')}
        </button>
        <CancelLink href={props.back} />
      </div>
    </PostForm>
  );
}
