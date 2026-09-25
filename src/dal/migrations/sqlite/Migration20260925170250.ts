import { Migration } from '@mikro-orm/migrations';

export class Migration20260925170250 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table \`file\` add column \`version\` integer not null default 1;`);
  }

}
