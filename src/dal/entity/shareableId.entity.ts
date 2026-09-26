import { BeforeCreate, Opt, Property, Unique } from '@mikro-orm/core';
import { randomUUID } from 'crypto';

// Indexes live on the entities so migration:create emits them. Postgres does
// not index foreign keys on its own, so an FK without an explicit @Index() is
// unindexed.
export abstract class ShareableId {
  // Share-link lookups (findOneByShareableId, getByShareableId) hit this column.
  // NOT NULL in the schema; addId() fills it on insert, so it is optional
  // only when creating (Opt) and always present on a loaded row. The explicit
  // type: an intersection type reaches decorator metadata as Object.
  @Unique()
  @Property({ type: 'string' })
  shareableId!: Opt<string>;

  // Runs from the UnitOfWork on insert, whichever way the entity was built.
  @BeforeCreate()
  private addId() {
    this.shareableId = randomUUID();
  }
}
