import * as z from 'zod/v4';
import { HttpError } from '../../errors';
import { defineTool } from '../tool';

/**
 * The wardrobe plans' tools, retired with plans (#337; doc section 5: "the
 * old plan tools keep working as shims for one release, then go"). The
 * plans have had no screen since #333, so a plan written now would reach
 * nobody: each name answers a refusal naming its successor instead, which
 * an agent working from an old prompt reads and follows. Removed with the
 * plans themselves (#337 part B).
 */
const SUCCESSORS: Record<string, string> = {
  create_plan: 'get_closet_coverage, then create_option_group per need',
  propose_plan_item: 'create_option_group',
  update_plan_item:
    'create_option_group (a need is not edited: propose another)',
  list_plans: 'list_suggestions',
  get_plan_gaps: 'get_closet_coverage',
  get_plan_feedback: 'get_suggestion_feedback',
  get_shopping_list: 'list_suggestions',
  add_candidate: 'suggest_garment',
  update_candidate:
    'suggest_garment (an option is not edited: suggest another)',
  compare_plans: 'get_closet_coverage',
  list_looks: 'list_suggestions',
  propose_look: 'suggest_outfit',
  update_look: 'suggest_outfit (an outfit is not edited: suggest another)',
};

export const RETIRED_TOOLS: readonly string[] = Object.keys(SUCCESSORS);

/** The message a retired tool answers. */
export function retiredMessage(name: string, successor: string): string {
  return `${name} is retired: wardrobe plans are gone. Use ${successor}.`;
}

export const retiredTools = Object.entries(SUCCESSORS).map(
  ([name, successor]) =>
    defineTool({
      name,
      title: `Retired: use ${successor}`,
      description: `RETIRED: wardrobe plans are gone; use ${successor}. Every call is refused.`,
      // Whatever an old prompt passes reaches the refusal, not a schema error.
      input: z.looseObject({}),
      writes: false,
      run() {
        return Promise.reject(
          new HttpError(410, retiredMessage(name, successor)),
        );
      },
    }),
);
