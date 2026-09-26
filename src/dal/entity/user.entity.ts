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
import { Outfit } from './outfit.entity';
import { ShareableId } from './shareableId.entity';
import { UserDevice } from './userDevice.entity';

@Entity()
export class User extends ShareableId {
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

  @OneToMany(() => UserDevice, (userDevice) => userDevice.user)
  public userDevices = new Collection<UserDevice>(this);

  @OneToMany(() => File, (file) => file.createdBy)
  public fileUploads = new Collection<File>(this);

  @OneToMany(() => Garment, (garment) => garment.owner)
  public garments = new Collection<Garment>(this);

  @OneToMany(() => Outfit, (outfit) => outfit.owner)
  public outfits = new Collection<Outfit>(this);
}
