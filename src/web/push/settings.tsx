import { t } from '../i18n';
import type { SendReport } from './sender';

/**
 * The profile page's notification controls. Whether this browser can and
 * does receive notifications is only known in the browser, so every state's
 * text is rendered here, hidden, and the <push-settings> element
 * (public/js/push.js) shows the one that applies. The permission prompt
 * only ever comes from the enable button: browsers penalize prompts without
 * a gesture and iOS refuses them.
 *
 * States (data-show): checking (before the script runs), on, off, blocked
 * (permission denied), unsupported, install (iOS/iPadOS outside the
 * installed app, where there is no push at all), error.
 */
export function PushSettings() {
  return (
    <section
      class="card bg-base-200 w-full max-w-sm"
      aria-labelledby="push-heading"
    >
      <div class="card-body gap-3">
        <h2 id="push-heading" class="card-title">
          {t('PUSH_HEADING')}
        </h2>
        <push-settings class="flex flex-col gap-2">
          <p data-show="checking">{t('PUSH_CHECKING')}</p>
          <p data-show="on" hidden>
            {t('PUSH_STATE_ON')}
          </p>
          <p data-show="off" hidden>
            {t('PUSH_STATE_OFF')}
          </p>
          <p data-show="blocked" hidden>
            {t('PUSH_STATE_BLOCKED')}
          </p>
          <p data-show="unsupported" hidden>
            {t('PUSH_STATE_UNSUPPORTED')}
          </p>
          <p data-show="install" hidden>
            {t('PUSH_STATE_INSTALL')}
          </p>
          <p data-show="error" class="text-error" role="alert" hidden>
            {t('PUSH_STATE_ERROR')}
          </p>
          <button
            type="button"
            class="btn btn-primary"
            data-show="off error"
            data-action="enable"
            hidden
          >
            {t('PUSH_ENABLE')}
          </button>
          <button
            type="button"
            class="btn"
            data-show="on"
            data-action="disable"
            hidden
          >
            {t('PUSH_DISABLE')}
          </button>
        </push-settings>
        {/* Sends to all of the user's devices, not only this one, so it is
            there whatever this browser's state; the answer says how many. */}
        <button
          type="button"
          class="btn btn-outline"
          hx-post="/push/test"
          hx-target="#push-test-result"
          hx-swap="innerHTML"
        >
          {t('PUSH_SEND_TEST')}
        </button>
        <div id="push-test-result" aria-live="polite"></div>
      </div>
    </section>
  );
}

/** POST /push/test's answer, swapped under the button. */
export function TestResult({ report }: { report: SendReport }) {
  if (report.devices === 0) return <p>{t('PUSH_TEST_NO_DEVICES')}</p>;
  return (
    <>
      {report.delivered > 0 && (
        <p class="text-success">
          {t('PUSH_TEST_SENT', { count: report.delivered })}
        </p>
      )}
      {report.failed > 0 && (
        <p class="text-error">
          {t('PUSH_TEST_FAILED', { count: report.failed })}
        </p>
      )}
      {report.pruned > 0 && (
        <p>{t('PUSH_TEST_REMOVED', { count: report.pruned })}</p>
      )}
    </>
  );
}
