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
import { weatherTools } from './weather';

/**
 * Every MCP tool (#33), in the order clients list them: the weather's
 * (#14) only with WEATHER_ENABLED. Deferred, each for its feature:
 * plan_week (#16, the weekly auto-plan: suggest_outfits' ideasFor per day
 * and occasion), a trip's forecast (#10: get_weather for the trip's
 * destination and dates). Wardrobe plans (#34) are tools/plans.ts (34a:
 * the style profile, plans, gaps, proposals) and tools/shopping.ts (34b:
 * the shopping list, candidates, comparing plans); "Bought it" stays the
 * owner's, in the app. The outfit gallery (#9) is tools/gallery.ts, with
 * "Goes with my closet" for a wishlist item (#18b, goes_with_closet),
 * insights (#17) tools/insights.ts's wardrobe_stats.
 */
export function mcpTools(options: {
  weather: boolean;
}): readonly ClosetTool<z.ZodObject>[] {
  return [
    ...garmentTools,
    ...capsuleTools,
    ...outfitTools,
    ...galleryTools,
    ...calendarTools,
    ...insightTools,
    ...(options.weather ? weatherTools : []),
    ...sharingTools,
    ...planTools,
    ...shoppingTools,
  ];
}
