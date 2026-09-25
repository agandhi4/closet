import { BeforeCreate, Index, Property } from '@mikro-orm/core';
import { randomUUID } from 'crypto';

// Indexes live on the entities so both migration trees (sqlite, postgres)
// emit the same DDL. SQLite's platform auto-indexes every ManyToOne; Postgres
// does not, so an FK without an explicit @Index() is unindexed in production.
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
