import { t } from '../i18n';
import { PostForm } from './form';

/**
 * Signing out is a POST (a GET let any cross-site link or image sign someone
 * out). The one control is this form: Profile's last section, and the page
 * behind GET /auth/logout (old cached pages link there). A native post,
 * like every PostForm: the answer is a redirect the service worker watches
 * for (views/assets/src-sw.ts). Disabled offline, where the post could not
 * reach the server and the cookie would stay.
 */

export const LOGOUT_PATH = '/auth/logout';

export function SignOutForm() {
  return (
    <PostForm id="logout-form" action={LOGOUT_PATH} needsNetwork>
      <button type="submit" class="btn btn-outline btn-error w-full">
        {t('LOGOUT')}
      </button>
    </PostForm>
  );
}
