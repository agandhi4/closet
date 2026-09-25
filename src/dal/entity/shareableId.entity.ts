import { BeforeCreate, Index, Property } from '@mikro-orm/core';
import { randomUUID } from 'crypto';

// Indexes live on the entities so migration:create emits them. Postgres does
// not index foreign keys on its own, so an FK without an explicit @Index() is
// unindexed.
export abstract class ShareableId {
  // Share-link lookups (findOneByShareableId, getByShareableId) hit this column.
  @Index()
  @Property()
  shareableId?: string;

  // Runs from the UnitOfWork on insert, whichever way the entity was built.
  @BeforeCreate()
  private addId() {
    this.shareableId = randomUUID();
  }

  // Intended to be used to indicate that it's been reported
  @Property({ nullable: true })
  public flagged?: boolean;

  @Property({ nullable: true })
  public banned?: boolean;
}
