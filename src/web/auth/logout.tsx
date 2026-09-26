import { t } from '../i18n';
import { PostForm } from './form';

/**
 * Signing out is a POST (a GET let any cross-site link or image sign someone
 * out). The navbar renders LogoutForm once, empty, and each LogoutButton (the
 * desktop bar and the mobile drawer) submits it through the `form`
 * attribute, so the button stays a direct child of its menu item and keeps
 * daisyUI's menu styling. A native post, like every PostForm: the answer is
 * a redirect the service worker watches for (views/assets/src-sw.ts).
 */

export const LOGOUT_PATH = '/auth/logout';
const LOGOUT_FORM_ID = 'logout-form';

// Hidden: it has nothing to show, and it must not take a cell of the
// drawer's grid. A hidden form still submits for its buttons.
export function LogoutForm() {
  return <PostForm id={LOGOUT_FORM_ID} action={LOGOUT_PATH} class="hidden" />;
}

export function LogoutButton() {
  return (
    <button type="submit" form={LOGOUT_FORM_ID}>
      {t('LOGOUT')}
    </button>
  );
}
