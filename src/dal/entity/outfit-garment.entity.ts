import {
  Entity,
  Index,
  ManyToOne,
  PrimaryKeyProp,
  type Rel,
} from '@mikro-orm/core';
import { Garment } from './garment.entity';
import { Outfit } from './outfit.entity';

/**
 * Explicit pivot for Outfit.garments so the pivot's indexes come from
 * metadata on both drivers (an implicit pivot gets none on Postgres, and a
 * hand-added index is dropped by the next migration:create). Table and
 * column names match the implicit pivot MikroORM created before, so no data
 * moves. Not used directly: outfits still go through the Collection.
 */
@Entity({ tableName: 'outfit_garments' })
export class OutfitGarment {
  @Index()
  @ManyToOne({ entity: () => Outfit, primary: true, deleteRule: 'cascade' })
  public outfit!: Rel<Outfit>;

  @Index()
  @ManyToOne({ entity: () => Garment, primary: true, deleteRule: 'cascade' })
  public garment!: Rel<Garment>;

  [PrimaryKeyProp]?: ['outfit', 'garment'];
}
