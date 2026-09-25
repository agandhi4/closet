import { Migration } from '@mikro-orm/migrations';

export class Migration20260925183003 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`pragma foreign_keys = off;`);
    this.addSql(`create table \`garment__temp_alter\` (\`id\` integer not null primary key autoincrement, \`shareable_id\` text not null, \`flagged\` integer null, \`banned\` integer null, \`name\` text null, \`category\` text not null, \`color\` text null, \`brand\` text null, \`size\` text null, \`date_aquired\` datetime null, \`notes\` text null, \`archived\` integer not null default false, \`washing_details\` text null, \`photo_id\` integer null, \`owner_id\` integer null, constraint \`garment_photo_id_foreign\` foreign key(\`photo_id\`) references \`file\`(\`id\`) on delete set null on update cascade, constraint \`garment_owner_id_foreign\` foreign key(\`owner_id\`) references \`user\`(\`id\`) on delete cascade on update cascade);`);
    this.addSql(`insert into \`garment__temp_alter\` select \`id\`, \`shareable_id\`, \`flagged\`, \`banned\`, \`name\`, \`category\`, \`color\`, \`brand\`, \`size\`, \`date_aquired\`, \`notes\`, \`archived\`, \`washing_details\`, \`photo_id\`, \`owner_id\` from \`garment\`;`);
    this.addSql(`drop table \`garment\`;`);
    this.addSql(`alter table \`garment__temp_alter\` rename to \`garment\`;`);
    this.addSql(`create index \`garment_shareable_id_index\` on \`garment\` (\`shareable_id\`);`);
    this.addSql(`create index \`garment_category_index\` on \`garment\` (\`category\`);`);
    this.addSql(`create unique index \`garment_photo_id_unique\` on \`garment\` (\`photo_id\`);`);
    this.addSql(`create index \`garment_owner_id_index\` on \`garment\` (\`owner_id\`);`);
    this.addSql(`pragma foreign_keys = on;`);
  }

}
