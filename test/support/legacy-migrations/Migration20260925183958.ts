import { Migration } from '@mikro-orm/migrations';

// Outfit.garments now goes through the explicit OutfitGarment pivot entity,
// whose two ManyToOnes carry @Index(); the implicit pivot only had the
// composite primary key on Postgres. Same table and columns, no data moves.
// CONCURRENTLY + non-transactional for the same reason as
// Migration20260925181256 (live homelab database, no write lock).
export class Migration20260925183958 extends Migration {
  override isTransactional(): boolean {
    return false;
  }

  override async up(): Promise<void> {
    this.addSql(
      `create index concurrently if not exists "outfit_garments_outfit_id_index" on "outfit_garments" ("outfit_id");`,
    );
    this.addSql(
      `create index concurrently if not exists "outfit_garments_garment_id_index" on "outfit_garments" ("garment_id");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index concurrently if exists "outfit_garments_outfit_id_index";`,
    );
    this.addSql(
      `drop index concurrently if exists "outfit_garments_garment_id_index";`,
    );
  }
}
