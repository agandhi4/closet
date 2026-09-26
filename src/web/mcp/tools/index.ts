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
 * insights), the wishlist and the shopping loop (#18, #34;
 * add_garment_from_link then takes a destination), and occasions (#13,
 * which schedule_outfit and create_outfit then take).
 */
export const MCP_TOOLS: readonly ClosetTool<z.ZodObject>[] = [
  ...garmentTools,
  ...capsuleTools,
  ...outfitTools,
  ...calendarTools,
  ...sharingTools,
];
