import type * as z from 'zod/v4';
import type { ClosetTool } from '../tool';
import { calendarTools } from './calendar';
import { capsuleTools } from './capsules';
import { galleryTools } from './gallery';
import { garmentTools } from './garments';
import { insightTools } from './insights';
import { lookTools } from './looks';
import { outfitTools } from './outfits';
import { planTools } from './plans';
import { sharingTools } from './sharing';
import { shoppingTools } from './shopping';
import { sizeTools } from './sizes';
import { todayTools } from './today';
import { tripTools } from './trips';
import { weatherTools } from './weather';
import { weekPlanTools } from './week-plan';

/**
 * Every MCP tool (#33), in the order clients list them: the weather's
 * (#14) only with WEATHER_ENABLED. The weekly auto-plan (#16) is
 * tools/week-plan.ts's plan_week, its template in get_style_profile. Trips
 * (#10) are tools/trips.ts: list_trips, get_trip (the packing list, and the
 * destination's forecast with WEATHER_ENABLED) and plan_trip_outfit.
 * Wardrobe plans (#34) are tools/plans.ts (34a:
 * the style profile, plans, gaps, proposals) and tools/shopping.ts (34b:
 * the shopping list, candidates, comparing plans); "Bought it" stays the
 * owner's, in the app. Looks (#290) are tools/looks.ts: list_looks,
 * propose_look, update_look. The outfit gallery (#9) is tools/gallery.ts, with
 * "Goes with my closet" for a wishlist item (#18b, goes_with_closet),
 * insights (#17) tools/insights.ts's wardrobe_stats, Today (#15)
 * tools/today.ts. A garment's photo for tagging (#90) is tools/garments.ts's
 * get_garment_photo, its queue search_garments' needsTagging. Sizes (#24)
 * are tools/sizes.ts's get_sizes, read only.
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
    ...tripTools,
    ...insightTools,
    ...(options.weather ? weatherTools : []),
    ...sharingTools,
    ...planTools,
    ...lookTools,
    ...sizeTools,
    ...shoppingTools,
  ];
}
