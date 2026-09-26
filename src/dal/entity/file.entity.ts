import {
  Entity,
  Index,
  ManyToOne,
  type Opt,
  PrimaryKey,
  Property,
  type Ref,
  Unique,
} from '@mikro-orm/core';
import { ShareableId } from './shareableId.entity';
import { User } from './user.entity';

@Entity()
export class File extends ShareableId {
  @PrimaryKey()
  public id!: number;

  @Unique()
  @Property()
  public fileName!: string;

  @Property({ nullable: true })
  public mimetype?: string;

  @Property()
  public createdOn!: string;

  // Cache-busting token for the immutable /file/** URLs (see imageUrl()).
  // Bumped by bumpPhotoVersion (src/web/files) whenever any variant's bytes are
  // rewritten in place (mask edits); a fresh upload starts at 1.
  @Property({ default: 1 })
  public version: number & Opt = 1;

  @Index()
  @ManyToOne({
    entity: () => User,
    deleteRule: 'cascade',
    ref: true,
  })
  public createdBy!: Ref<User>;
}
