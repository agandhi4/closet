import {
  Collection,
  Entity,
  OneToMany,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/core';
import { File } from './file.entity';
import { Garment } from './garment.entity';

@Entity()
export class User {
  @PrimaryKey()
  public id!: number;

  @Property({ nullable: true })
  public firstName?: string;

  @Property({ nullable: true })
  public lastName?: string;

  @Unique()
  @Property({ nullable: true })
  public email?: string;

  @Property()
  public password!: string;

  @OneToMany(() => File, (file) => file.createdBy)
  public fileUploads = new Collection<File>(this);

  @OneToMany(() => Garment, (garment) => garment.owner)
  public garments = new Collection<Garment>(this);
}
