import { CONDITIONS } from '../../wardrobe/properties';
import { t } from '../i18n';
import { valueLabel } from './labels';
import type { GarmentDetail } from './queries';
import { garmentUrl } from './urls';
import { CARE_NOTE_MAX } from './validation';

const SECTION_ID = 'garment-condition';

/**
 * The garment page's condition (src/web/wardrobe/garment-page.tsx). For the
 * owner and a MANAGE grantee: a chip per condition and, with a problem, what
 * is wrong, one htmx form posted on every change (a chip, or the note on
 * blur) to POST /wardrobe/:id/condition, which saves at once and answers
 * this section; the form's own action is the no-script path. For a viewer:
 * the condition and its note, only when it is
 * not good. Never part of availability: a garment that needs repair is
 * still in the closet.
 */
export function GarmentCondition(props: {
  garment: Pick<GarmentDetail, 'id' | 'condition' | 'conditionNote'>;
  viewOwner: number | undefined;
  canEdit: boolean;
}) {
  const { garment, viewOwner } = props;
  const problem = garment.condition !== 'good';
  if (!props.canEdit) {
    if (!problem) return <section id={SECTION_ID}></section>;
    return (
      <section id={SECTION_ID} class="mb-4 flex flex-col gap-1">
        <span class="badge badge-warning">
          {valueLabel('condition', garment.condition)}
        </span>
        {garment.conditionNote && (
          <p class="text-sm text-base-content/70">{garment.conditionNote}</p>
        )}
      </section>
    );
  }
  return (
    <section id={SECTION_ID} class="mb-4">
      <h2 class="text-sm text-base-content/60 mb-2">{t('CONDITION')}</h2>
      {/* Enter in the note submits natively: the route answers a plain
          post with the page again. */}
      <form
        method="post"
        action={garmentUrl(garment.id, viewOwner, '/condition')}
        hx-post={garmentUrl(garment.id, viewOwner, '/condition')}
        hx-trigger="change"
        hx-target={`#${SECTION_ID}`}
        hx-swap="outerHTML"
        class="flex flex-col gap-2"
        data-needs-network=""
      >
        <div class="flex flex-wrap gap-2">
          {CONDITIONS.map((condition) => (
            <input
              type="radio"
              name="condition"
              value={condition}
              class={`btn btn-sm rounded-full ${condition === 'good' ? '' : 'checked:btn-warning'}`}
              aria-label={valueLabel('condition', condition)}
              checked={condition === garment.condition}
            />
          ))}
        </div>
        {problem && (
          <input
            type="text"
            name="conditionNote"
            value={garment.conditionNote ?? ''}
            maxlength={CARE_NOTE_MAX}
            placeholder={t('CONDITION_NOTE_PLACEHOLDER')}
            aria-label={t('CONDITION_NOTE')}
            class="input input-bordered input-sm w-full"
          />
        )}
      </form>
    </section>
  );
}
