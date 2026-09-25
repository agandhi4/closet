import { Garment } from '../../src/dal/entity/garment.entity';
import { createTestApp, TestApp } from './harness';

/**
 * Garment.color is a comma-joined list of GarmentColor names stored in a
 * plain text column (it used to be an item-less @Enum, which Postgres mapped
 * to smallint and rejected). The filter is a membership test on that list.
 */
describe('garment colours (AUTH_ENABLED=false)', () => {
  let t: TestApp;
  let garmentId: number;

  const listedNames = async (query: string) => {
    const res = await t.inject({ method: 'GET', url: `/wardrobe${query}` });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    t = await createTestApp();
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: {
        name: 'Two-tone scarf',
        category: 'accessories',
        color: 'red,blue',
      },
    });
    expect(res.statusCode).toBe(302);
    garmentId = Number(
      /^\/wardrobe\/(\d+)\?/.exec(res.headers.location as string)![1],
    );
    const plain = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: { name: 'Plain green tee', category: 'tops', color: 'green' },
    });
    expect(plain.statusCode).toBe(302);
  });

  afterAll(() => t?.cleanup());

  it('stores the selection as a comma-joined list', async () => {
    const garment = await t.em().findOneOrFail(Garment, garmentId);
    expect(garment.color).toBe('red,blue');
  });

  it('shows both colours on the garment page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/${garmentId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('red, blue');
  });

  it('rejects a colour that is not an enum name, so LIKE wildcards never reach the query', async () => {
    for (const value of ['%', '%25', 'red%', 'crimson']) {
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe?color=${encodeURIComponent(value)}`,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('is found by either colour and not by another', async () => {
    expect(await listedNames('?color=red')).toContain('Two-tone scarf');
    expect(await listedNames('?color=blue')).toContain('Two-tone scarf');
    const green = await listedNames('?color=green');
    expect(green).toContain('Plain green tee');
    expect(green).not.toContain('Two-tone scarf');
  });
});
