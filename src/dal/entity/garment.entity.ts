import {
  Entity,
  Index,
  ManyToOne,
  OneToOne,
  type Opt,
  PrimaryKey,
  Property,
  type Ref,
  type Rel,
} from '@mikro-orm/core';
import { File } from './file.entity';
import { ShareableId } from './shareableId.entity';
import { User } from './user.entity';

@Entity()
export class Garment extends ShareableId {
  @PrimaryKey()
  public id!: number;

  @Property({ nullable: true })
  public name?: string;

  // Filtered on by the wardrobe list and the outfit row picker.
  @Index()
  @Property()
  public category!: string;

  // Comma-joined GarmentColor values ("red,blue") from the colour
  // multi-select; read by the ifInArray/formatColors template helpers and
  // filtered with a LIKE match. Deliberately not an @Enum: MikroORM mapped
  // the item-less enum to smallint on Postgres, which rejected every value.
  @Property({ nullable: true })
  public color?: string;

  @Property({ nullable: true })
  public brand?: string;

  @Property({ nullable: true })
  public size?: string;

  // A 'YYYY-MM-DD' day (Postgres date), not an instant.
  @Property({ type: 'string', columnType: 'date', nullable: true })
  public acquiredOn?: string;

  @Property({ nullable: true })
  public notes?: string;

  @Property({ default: false })
  public archived: boolean & Opt = false;

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

  @Index()
  @ManyToOne({
    entity: () => User,
    deleteRule: 'cascade',
    ref: true,
  })
  public owner!: Ref<User>;

  // Which outfits wear a garment is outfit_slot's (src/db/schema.ts), read
  // through Drizzle only: no MikroORM entity maps outfits any more.
}
