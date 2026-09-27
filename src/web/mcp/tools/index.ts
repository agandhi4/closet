import type * as z from 'zod/v4';
import type { ClosetTool } from '../tool';
import { calendarTools } from './calendar';
import { capsuleTools } from './capsules';
import { garmentTools } from './garments';
import { outfitTools } from './outfits';
import { sharingTools } from './sharing';

/**
 * Every MCP tool (#33), in the order clients list them. Deferred, each for
 * its feature: plan_week (#16, the weekly auto-plan), wardrobe_stats (#17,
 * insights), "goes with my closet" for a wishlist item (#18b, the generator
 * over the closet plus the item), the shopping loop (#34, through
 * add_garment_from_link's wishlist destination).
 */
export const MCP_TOOLS: readonly ClosetTool<z.ZodObject>[] = [
  ...garmentTools,
  ...capsuleTools,
  ...outfitTools,
  ...calendarTools,
  ...sharingTools,
];
