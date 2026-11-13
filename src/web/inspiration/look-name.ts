import { t } from '../i18n';
import type { InspirationSummary } from './queries';

/**
 * The site a look's link is on, as its page names it ("pinterest.com"):
 * the host without `www.`. A stored link always parses: the outbound
 * fetcher refused any that does not before a look was saved with it.
 */
export function linkHost(sourceUrl: string): string {
  return new URL(sourceUrl).hostname.replace(/^www\./, '');
}

/** What a look is called: its title, else its link's site, else "Untitled look". */
export function lookName(
  look: Pick<InspirationSummary, 'title' | 'sourceUrl'>,
): string {
  if (look.title) return look.title;
  if (look.sourceUrl) return linkHost(look.sourceUrl);
  return t('inspiration.UNTITLED');
}
