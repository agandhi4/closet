import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  resolveWardrobeAccess,
  sharedWardrobesOf,
  type SharedWardrobe,
  type WardrobeAccess,
} from '../web/sharing/access';

/**
 * Nest's handle on the sharing queries for the garment routes, which are
 * still Nest controllers (WardrobeController, GarmentService). Sharing itself
 * lives in src/web/sharing; this wrapper goes when garments are ported and
 * call resolveWardrobeAccess directly.
 */
@Injectable()
export class WardrobeShareService {
  constructor(@Inject(DB) private readonly db: Db) {}

  resolveAccess(
    userId: number,
    ownerId: number | undefined,
  ): Promise<WardrobeAccess> {
    return resolveWardrobeAccess(this.db, userId, ownerId);
  }

  sharedWardrobesOf(userId: number): Promise<SharedWardrobe[]> {
    return sharedWardrobesOf(this.db, userId);
  }
}
