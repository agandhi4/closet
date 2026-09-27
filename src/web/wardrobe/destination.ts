import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import { findGarment, type GarmentDetail } from './queries';
import { TO_CLOSET, type Destination } from './urls';
import {
  BLANK_CARE,
  BLANK_GARMENT_VALUES,
  type DestinationQuery,
  type GarmentFormValues,
  storedPropertyValues,
} from './validation';
import { splitColors } from './garment';

/**
 * Where a new garment's form lands, from its URL (DestinationQuery): the
 * closet, the wishlist, or the wishlist as a replacement for a garment of
 * the addressed wardrobe (a garment's "Find a replacement"; any other id is
 * a 404 like an unknown garment). Shared by GET /wardrobe/new and the link
 * import's routes, which carry it through to the form.
 */
export async function resolveDestination(
  db: Db,
  query: DestinationQuery,
  ownerId: number,
): Promise<{ destination: Destination; replaced?: GarmentDetail }> {
  if (query.to !== 'wishlist') return { destination: TO_CLOSET };
  if (!query.replaces) return { destination: { to: 'wishlist' } };
  const replaced = await findGarment(db, query.replaces, ownerId);
  if (!replaced) throw new HttpError(404, 'Garment not found');
  return { destination: { to: 'wishlist', replaces: replaced.id }, replaced };
}

/**
 * A new garment form's values: blank (the closet's, or a wishlist item's),
 * or for a replacement what describes
 * the kind of garment (category, type and the other properties, brand,
 * colours, size), never what belonged to the old one (its name, notes,
 * dates, price, link, care).
 */
export function destinationValues(
  destination: Destination,
  replaced: GarmentDetail | undefined,
): GarmentFormValues {
  const replaces =
    destination.replaces === undefined ? '' : String(destination.replaces);
  if (!replaced) return { ...BLANK_GARMENT_VALUES, replaces };
  return {
    ...BLANK_GARMENT_VALUES,
    category: replaced.category,
    brand: replaced.brand ?? '',
    colors: splitColors(replaced.color),
    size: replaced.size ?? '',
    properties: storedPropertyValues(replaced),
    care: BLANK_CARE,
    replaces,
  };
}
