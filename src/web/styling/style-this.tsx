import { t } from '../i18n';
import { styleThisUrl } from './urls';

/**
 * "Style this" (#42): Styling with the garment chosen and locked in its
 * row, opened on an idea around it; over a shared wardrobe, browsing only.
 * The garment page's primary action: its owner gets it in the wear line's
 * row of buttons (src/web/wears/wear-section.tsx, which the wear posts
 * answer), anyone else under the facts (src/web/wardrobe/garment-page.tsx).
 */
export function StyleThisLink(props: {
  garmentId: number;
  viewOwner: number | undefined;
}) {
  return (
    <a
      href={styleThisUrl(props.garmentId, props.viewOwner)}
      class="btn btn-primary flex-1 whitespace-nowrap"
    >
      {t('gallery.STYLE_THIS')}
    </a>
  );
}
