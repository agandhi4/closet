import { Migration } from '@mikro-orm/migrations';

// Password reset by email was removed (the in-app change-password page
// replaces it). Dropping user.password_reset_id also removes the ON DELETE
// CASCADE that let deleting a password_reset row delete its user.
export class Migration20260926021506 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "user" drop constraint "user_password_reset_id_foreign";`,
    );

    this.addSql(`drop table if exists "password_reset" cascade;`);

    this.addSql(
      `alter table "user" drop constraint "user_password_reset_id_unique";`,
    );
    this.addSql(`alter table "user" drop column "password_reset_id";`);
  }

  override async down(): Promise<void> {
    this.addSql(
      `create table "password_reset" ("id" serial primary key, "pin" varchar(255) not null);`,
    );

    this.addSql(`alter table "user" add column "password_reset_id" int null;`);
    this.addSql(
      `alter table "user" add constraint "user_password_reset_id_foreign" foreign key ("password_reset_id") references "password_reset" ("id") on update cascade on delete cascade;`,
    );
    this.addSql(
      `alter table "user" add constraint "user_password_reset_id_unique" unique ("password_reset_id");`,
    );
  }
}
