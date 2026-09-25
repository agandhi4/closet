import {
  Collection,
  Entity,
  Index,
  ManyToMany,
  ManyToOne,
  PrimaryKey,
  Property,
  type Ref,
} from '@mikro-orm/core';
import { Garment } from './garment.entity';
import { OutfitGarment } from './outfit-garment.entity';
import { ShareableId } from './shareableId.entity';
import { User } from './user.entity';

export interface OutfitSlot {
  category: string;
  garmentId: number | null;
}

@Entity()
export class Outfit extends ShareableId {
  @PrimaryKey()
  public id!: number;

  @Property({ nullable: true })
  public name?: string;

  @Property({ nullable: true })
  public notes?: string;

  @Property({ type: 'json', nullable: true })
  public slots?: OutfitSlot[];

  @ManyToMany({
    entity: () => Garment,
    inversedBy: (garment) => garment.outfits,
    owner: true,
    pivotEntity: () => OutfitGarment,
  })
  public garments = new Collection<Garment>(this);

  @Index()
  @ManyToOne({
    entity: () => User,
    deleteRule: 'cascade',
    ref: true,
    nullable: true,
  })
  public owner?: Ref<User>;
}
