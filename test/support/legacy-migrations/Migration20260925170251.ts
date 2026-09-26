import { Migration } from '@mikro-orm/migrations';

export class Migration20260925170251 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "file" add column "version" int not null default 1;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "file" drop column "version";`);
  }
}
