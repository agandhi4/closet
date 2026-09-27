import type * as z from 'zod/v4';
import type { ClosetTool } from '../tool';
import { calendarTools } from './calendar';
import { capsuleTools } from './capsules';
import { garmentTools } from './garments';
import { outfitTools } from './outfits';
import { planTools } from './plans';
import { sharingTools } from './sharing';
import { weatherTools } from './weather';

/**
 * Every MCP tool (#33), in the order clients list them: the weather's
 * (#14) only with WEATHER_ENABLED. Deferred, each for its feature:
 * plan_week (#16, the weekly auto-plan), wardrobe_stats (#17, insights),
 * "goes with my closet" for a wishlist item (#18b, the generator over the
 * closet plus the item), the rest of the shopping loop (#34b: a plan's
 * shopping list with candidate wishlist garments, "Bought it" against a
 * plan item, comparing two plans; see tools/plans.ts, which holds 34a's
 * plans and style profile), a trip's forecast (#10: get_weather for the
 * trip's destination and dates).
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
  ];
}
