import {
  Collection,
  Entity,
  Enum,
  ManyToMany,
  ManyToOne,
  OneToOne,
  PrimaryKey,
  Property,
  type Ref,
  type Rel,
} from '@mikro-orm/core';
import { File } from './file.entity';
import { Outfit } from './outfit.entity';
import { ShareableId } from './shareableId.entity';
import { User } from './user.entity';
import { GarmentColor } from '../../wardrobe/garment-color.enum';

export { GarmentColor };

@Entity()
export class Garment extends ShareableId {
  @PrimaryKey()
  public id!: number;

  @Property({ nullable: true })
  public name?: string;

  @Property()
  public category!: string;

  @Enum({ nullable: true })
  public color?: GarmentColor;

  @Property({ nullable: true })
  public brand?: string;

  @Property({ nullable: true })
  public size?: string;

  @Property({ type: Date, nullable: true })
  public dateAquired?: Date;

  @Property({ nullable: true })
  public notes?: string;

  @Property({ default: false })
  public archived = false;
  @Property({ nullable: true, columnType: 'text' })
  public washingDetails?: string;

  // Not `ref: true`, so this is the populated File itself, not a Reference.
  // Rel<> keeps emitDecoratorMetadata from emitting `File` as design:type,
  // which the garment <-> file <-> user import cycle cannot satisfy under the
  // MikroORM CLI's ts-node loader.
  @OneToOne({
    entity: () => File,
    nullable: true,
  })
  public photo?: Rel<File>;

  @ManyToOne({
    entity: () => User,
    deleteRule: 'cascade',
    ref: true,
    nullable: true,
  })
  public owner?: Ref<User>;

  @ManyToMany(() => Outfit, (outfit) => outfit.garments)
  public outfits = new Collection<Outfit>(this);
}
