import { createTestApp, TestApp } from './harness';

/**
 * Booting the app runs migrator.up(); the schema it leaves behind must carry
 * every index the entities declare. The Postgres migration's shape (CONCURRENTLY, non-transactional)
 * is checked statically in src/dal/migrations/postgres-indexes.spec.ts.
 */
describe('migrations', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  const indexNames = async (): Promise<string[]> => {
    const rows: { name: string }[] = await t
      .em()
      .getConnection()
      .execute(
        'select indexname as name from pg_indexes where schemaname = current_schema()',
      );
    return rows.map((row) => row.name);
  };

  it('creates the lookup and foreign-key indexes', async () => {
    expect(await indexNames()).toEqual(
      expect.arrayContaining([
        'user_shareable_id_index',
        'file_shareable_id_index',
        'file_created_by_id_index',
        'garment_shareable_id_index',
        'garment_owner_id_index',
        'garment_category_index',
        'outfit_shareable_id_index',
        'outfit_owner_id_index',
        'outfit_garments_outfit_id_index',
        'outfit_garments_garment_id_index',
        'outfit_calendar_date_index',
        'outfit_calendar_outfit_id_index',
        'outfit_calendar_owner_id_index',
        'user_device_user_id_index',
        'wardrobe_share_grantor_id_index',
        'wardrobe_share_grantee_id_index',
        'wardrobe_share_invite_token_unique',
      ]),
    );
  });
});
