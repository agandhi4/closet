import * as z from 'zod/v4';
import { inUnit, MEASUREMENTS } from '../../../wardrobe/measurements';
import { BRAND_MAX } from '../../wardrobe/garment-input';
import {
  brandSizeFor,
  brandSizesOf,
  findMeasurements,
} from '../../sizes/queries';
import { defineTool } from '../tool';

/**
 * Sizes as data (#24; plan section 16): the caller's own measurements and
 * brand notes, as Profile › Sizes shows them, for shopping. Private like
 * the style profile: no ownerId, the token's user only. Read only: sizes
 * are edited in the app.
 */
export const sizeTools = [
  defineTool({
    name: 'get_sizes',
    title: 'Get my sizes',
    description:
      'Your body measurements and the size you wear in each brand, for choosing a size when shopping (add_garment_from_link, the wishlist). Measurements (height, neck, shoulders, chest, sleeve, waist, hips, inseam; only those you set) in centimetres and in your unit (in or cm), with the unit you read them in. Brands: each brand\'s size and a note on how it runs ("runs small, size up"); either may be null. With `brand`, only that brand\'s note (matched whatever the case and spacing: "UNIQLO" is Uniqlo), or none when you have no note on it.',
    input: z.object({
      brand: z
        .string()
        .max(BRAND_MAX)
        .optional()
        .describe('A brand to look up; omit for every brand.'),
    }),
    writes: false,
    async run({ brand }, ctx) {
      const [measurements, brands] = await Promise.all([
        findMeasurements(ctx.db, ctx.userId),
        brand === undefined
          ? brandSizesOf(ctx.db, ctx.userId)
          : brandSizeFor(ctx.db, ctx.userId, brand).then((row) =>
              row ? [row] : [],
            ),
      ]);
      const { unit, lengths } = measurements;
      return {
        unit,
        measurements: MEASUREMENTS.flatMap((name) => {
          const cm = lengths[name];
          return cm === null ? [] : [{ name, cm, value: inUnit(cm, unit) }];
        }),
        brands: brands.map(({ brand, size, note }) => ({ brand, size, note })),
      };
    },
  }),
];
