import type * as z from 'zod/v4';
import type { ClosetTool } from '../tool';
import { calendarTools } from './calendar';
import { capsuleTools } from './capsules';
import { garmentTools } from './garments';
import { outfitTools } from './outfits';
import { planTools } from './plans';
import { sharingTools } from './sharing';
import { shoppingTools } from './shopping';
import { weatherTools } from './weather';

/**
 * Every MCP tool (#33), in the order clients list them: the weather's
 * (#14) only with WEATHER_ENABLED. Deferred, each for its feature:
 * plan_week (#16, the weekly auto-plan), wardrobe_stats (#17, insights),
 * "goes with my closet" for a wishlist item (#18b, the generator over the
 * closet plus the item), a trip's forecast (#10: get_weather for the
 * trip's destination and dates). Wardrobe plans (#34) are tools/plans.ts
 * (34a: the style profile, plans, gaps, proposals) and tools/shopping.ts
 * (34b: the shopping list, candidates, comparing plans); "Bought it" stays
 * the owner's, in the app.
 */
export function mcpTools(options: {
  weather: boolean;
}): readonly ClosetTool<z.ZodObject>[] {
  return [
    ...garmentTools,
    ...capsuleTools,
    ...outfitTools,
    ...calendarTools,
    ...(options.weather ? weatherTools : []),
    ...sharingTools,
    ...planTools,
    ...shoppingTools,
  ];
}
