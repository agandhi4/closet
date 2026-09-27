import type * as z from 'zod/v4';
import type { ClosetTool } from '../tool';
import { calendarTools } from './calendar';
import { capsuleTools } from './capsules';
import { galleryTools } from './gallery';
import { garmentTools } from './garments';
import { insightTools } from './insights';
import { outfitTools } from './outfits';
import { planTools } from './plans';
import { sharingTools } from './sharing';
import { shoppingTools } from './shopping';
import { todayTools } from './today';
import { weatherTools } from './weather';
import { weekPlanTools } from './week-plan';

/**
 * Every MCP tool (#33), in the order clients list them: the weather's
 * (#14) only with WEATHER_ENABLED. Deferred: a trip's forecast (#10:
 * get_weather for the trip's destination and dates). The weekly auto-plan
 * (#16) is tools/week-plan.ts's plan_week, its template in
 * get_style_profile. Wardrobe plans (#34) are tools/plans.ts (34a:
 * the style profile, plans, gaps, proposals) and tools/shopping.ts (34b:
 * the shopping list, candidates, comparing plans); "Bought it" stays the
 * owner's, in the app. The outfit gallery (#9) is tools/gallery.ts, with
 * "Goes with my closet" for a wishlist item (#18b, goes_with_closet),
 * insights (#17) tools/insights.ts's wardrobe_stats, Today (#15)
 * tools/today.ts.
 */
export function mcpTools(options: {
  weather: boolean;
}): readonly ClosetTool<z.ZodObject>[] {
  return [
    ...garmentTools,
    ...capsuleTools,
    ...outfitTools,
    ...galleryTools,
    ...todayTools,
    ...calendarTools,
    ...weekPlanTools,
    ...insightTools,
    ...(options.weather ? weatherTools : []),
    ...sharingTools,
    ...planTools,
    ...shoppingTools,
  ];
}
