import { t } from '../i18n';
import { capsuleUrl, garmentUrl } from '../wardrobe/urls';
import type { GarmentCapsule } from './queries';

const SECTION_ID = 'garment-capsules';

/**
 * The garment page's "In capsules" (src/web/wardrobe/garment-page.tsx):
 * for the owner and a MANAGE grantee a toggle per capsule of the wardrobe,
 * one htmx form posted on every change to POST /wardrobe/:id/capsules,
 * which saves at once and answers this section again; for a viewer the
 * capsules the garment is in, as links. Nothing without capsules (or, for
 * a viewer, without memberships). Not a native form: its only values are
 * the chips, so nothing a person does can be refused with a 4xx (the same
 * reasoning as the tagging card).
 */
export function GarmentCapsules(props: {
  garmentId: number;
  capsules: GarmentCapsule[];
  viewOwner: number | undefined;
  canEdit: boolean;
}) {
  const { garmentId, capsules, viewOwner } = props;
  const members = capsules.filter((capsule) => capsule.member);
  if (capsules.length === 0 || (!props.canEdit && members.length === 0)) {
    return <section id={SECTION_ID}></section>;
  }
  return (
    <section id={SECTION_ID} class="mb-6">
      <h2 class="text-sm text-base-content/60 mb-2">{t('IN_CAPSULES')}</h2>
      {props.canEdit ? (
        <form
          hx-post={garmentUrl(garmentId, viewOwner, '/capsules')}
          hx-trigger="change"
          hx-target={`#${SECTION_ID}`}
          hx-swap="outerHTML"
          class="flex flex-wrap gap-2"
        >
          {capsules.map((capsule) => (
            <>
              <input
                type="checkbox"
                name="capsuleIds"
                value={String(capsule.id)}
                class="btn btn-sm rounded-full"
                aria-label={capsule.name}
                checked={capsule.member}
              />
              {/* Listed here: unchecked means "not in it" for this one only. */}
              <input type="hidden" name="shown" value={String(capsule.id)} />
            </>
          ))}
        </form>
      ) : (
        <div class="flex flex-wrap gap-2">
          {members.map((capsule) => (
            <a
              href={capsuleUrl(capsule.id, viewOwner)}
              class="badge badge-outline"
            >
              {capsule.name}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
