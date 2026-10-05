import * as z from 'zod/v4';
import { selectScalars } from '../../../db/select-scalars';
import { templateDays, weeklyRhythm } from '../../../wardrobe/week';
import { styleProfileSql } from '../../plans/queries';
import { inTemplateOrder, weekTemplateSql } from '../../week-plan/template';
import { defineTool } from '../tool';

/** The owner's style profile and week (#34, #16): the caller's own. */
export const styleTools = [
  defineTool({
    name: 'get_style_profile',
    title: 'Get my style profile',
    description:
      "Your style profile: the styles you dress in, your budget band per piece (budget under $50, mid $50-150, premium $150-400, luxury above) and your palette (garment colours); null when you never saved one. And your week: the week template (Sunday first, weekday 0 to 6: the occasion of the day's outfit, all-day, work or daytime, or none, and the occasions around it, workout, evening, night-out) that plan_week fills, and the rhythm derived from it (how many days a week each occasion comes round). Your home city is the weather's (get_weather), not part of it.",
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      // One statement (#172; it was two).
      const read = await selectScalars(ctx.db, {
        profile: styleProfileSql(ctx.userId),
        template: weekTemplateSql(ctx.userId),
      });
      const template = inTemplateOrder(read.template);
      return {
        profile: read.profile,
        week: {
          template: templateDays(template),
          rhythm: weeklyRhythm(template),
        },
      };
    },
  }),
];
