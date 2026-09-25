import { Migration } from '@mikro-orm/migrations';

export class Migration20260925181253 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create index \`user_shareable_id_index\` on \`user\` (\`shareable_id\`);`);

    this.addSql(`create index \`outfit_shareable_id_index\` on \`outfit\` (\`shareable_id\`);`);

    this.addSql(`create index \`outfit_calendar_date_index\` on \`outfit_calendar\` (\`date\`);`);

    this.addSql(`create index \`file_shareable_id_index\` on \`file\` (\`shareable_id\`);`);

    this.addSql(`create index \`garment_shareable_id_index\` on \`garment\` (\`shareable_id\`);`);
    this.addSql(`create index \`garment_category_index\` on \`garment\` (\`category\`);`);
  }

}
