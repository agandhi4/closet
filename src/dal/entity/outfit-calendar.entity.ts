import {
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  type Ref,
  Unique,
} from '@mikro-orm/core';
import { Outfit } from './outfit.entity';
import { User } from './user.entity';

/**
 * Mirror of outfit_calendar in src/db/schema.ts, which owns the table. The
 * calendar itself is ported (src/web/calendar/, Drizzle); this entity remains
 * for OutfitService.schedule, the outfit form's scheduling, until the outfits
 * port.
 */
@Entity()
@Unique({
  name: 'outfit_calendar_owner_id_day_outfit_id_unique',
  properties: ['owner', 'day', 'outfit'],
})
export class OutfitCalendar {
  @PrimaryKey()
  public id!: number;

  /** The planned day, 'YYYY-MM-DD' (a Postgres date; MikroORM reads it as a string). */
  @Property({ type: 'date' })
  public day!: string;

  @Index()
  @ManyToOne({
    entity: () => Outfit,
    deleteRule: 'cascade',
    ref: true,
  })
  public outfit!: Ref<Outfit>;

  @ManyToOne({
    entity: () => User,
    deleteRule: 'cascade',
    ref: true,
  })
  public owner!: Ref<User>;

  /** Null until the user marks this entry as worn. */
  @Property({ nullable: true })
  public wornAt?: Date;
}
