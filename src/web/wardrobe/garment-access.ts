import type { FastifyRequest } from 'fastify';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import {
  type AuthorizedWardrobe,
  authorizeWardrobe,
  type WardrobeNeed,
} from '../sharing/access';
import { findGarment, type GarmentDetail } from './queries';

export const GARMENT_NOT_FOUND = 'Garment not found';

export function garmentNotFound(): HttpError {
  return new HttpError(404, GARMENT_NOT_FOUND);
}

/**
 * Who may do what (authorizeWardrobe, src/web/sharing/access.ts): a
 * wardrobe the requester cannot see is a 404 like an unknown id, and so is
 * a garment outside the wardrobe the request addresses; one they can see
 * but not change is a 403. Reads need a view, writes a MANAGE share (or
 * ownership), archive and delete ownership, and a clone only a view: it
 * lands in the requester's own wardrobe and only reads the source.
 *
 * Every route that addresses a garment's wardrobe goes through this, so the
 * refusal (and its message) is the same wherever a garment is reached.
 */
export function authorizeGarmentWardrobe(
  db: WebOptions['db'],
  request: FastifyRequest,
  ownerId: number | '' | undefined,
  need: WardrobeNeed,
): Promise<AuthorizedWardrobe> {
  return authorizeWardrobe(db, request, ownerId, need, GARMENT_NOT_FOUND);
}

/** Garment `id` in the wardrobe `ownerId`, or the 404 of an unknown id. */
export async function requireGarment(
  db: WebOptions['db'],
  id: number,
  ownerId: number,
): Promise<GarmentDetail> {
  const garment = await findGarment(db, id, ownerId);
  if (!garment) throw garmentNotFound();
  return garment;
}
