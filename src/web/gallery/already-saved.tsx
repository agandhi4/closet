import { t } from '../i18n';
import { SavedToast, StripFlags } from '../layout/parts';
import { ALREADY_SAVED_FLAG } from './urls';

/**
 * "Already saved" after a pick that found its outfit (a double tap, a
 * retried post): on the outfit page for a save, on the week for a plan.
 * Nothing when `shown` is false; the flag is stripped from the address
 * either way, so a reload does not replay it.
 */
export function AlreadySavedToast({ shown }: { shown: boolean }) {
  return (
    <>
      {shown && (
        <SavedToast
          id="already-saved-toast"
          text={t('gallery.ALREADY_SAVED')}
        />
      )}
      <StripFlags names={[ALREADY_SAVED_FLAG]} />
    </>
  );
}
