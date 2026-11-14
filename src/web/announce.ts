import type { FastifyReply } from 'fastify';
import { hxTrigger } from '../htmx/trigger';

/**
 * The htmx event a write's answer raises with what it did ("Marked
 * washed"), which public/js/toast.js says in `#toast-host`, the page's one
 * polite status region (src/web/layout/app-status.tsx; #679). That plain
 * script spells the name itself, so the two change together. The failure
 * path is REQUEST_FAILED_EVENT (src/web/errors.tsx), into the same region.
 */
export const STATUS_EVENT = 'closet:status';

/**
 * A reversible write's Undo, a button in the toast (public/js/toast.js):
 * its tap posts `fields` to `action` (htmx, same origin, the answer's own
 * navigation) and the toast stays long enough to be reached.
 */
export interface StatusUndo {
  /** The button's words. */
  label: string;
  action: string;
  fields: Record<string, string>;
}

/** The event's detail. */
export interface StatusMessage {
  message: string;
  undo?: StatusUndo;
}

/**
 * Says what an htmx write did, through the status region. For a write
 * swapped in place (a native post's landing page says it with SavedToast,
 * src/web/layout/parts.tsx): a live region inserted with the swap is not
 * reliably read, the persistent one is. Call before sending the answer.
 */
export function announce(
  reply: FastifyReply,
  message: string,
  undo?: StatusUndo,
): FastifyReply {
  const detail: StatusMessage = { message, undo };
  return reply.header('HX-Trigger', hxTrigger(STATUS_EVENT, detail));
}
