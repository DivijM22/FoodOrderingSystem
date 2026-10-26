import { describe, expect, it } from 'vitest';
import { MenuItemModel } from '../src/models/menu-item.model.js';
import { RestaurantModel } from '../src/models/restaurant.model.js';
import { SEED_RESTAURANTS } from '../src/seed/data.js';
import { menuItemSeedId, restaurantSeedId, seedCatalog } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';

describe('seed data (static checks)', () => {
  it('has at least 15 restaurants with 8–15 uniquely named items each', () => {
    expect(SEED_RESTAURANTS.length).toBeGreaterThanOrEqual(15);
    for (const r of SEED_RESTAURANTS) {
      expect(r.items.length, r.name).toBeGreaterThanOrEqual(8);
      expect(r.items.length, r.name).toBeLessThanOrEqual(15);
      expect(new Set(r.items.map((i) => i[0])).size, `${r.name} has duplicate dish names`).toBe(r.items.length);
      if (r.isPureVeg) expect(r.items.every((i) => i[3]), `${r.name} is pure veg`).toBe(true);
    }
    expect(new Set(SEED_RESTAURANTS.map((r) => r.slug)).size).toBe(SEED_RESTAURANTS.length);
  });

  it('includes a mix of veg/non-veg, unavailable items and a closed restaurant', () => {
    const items = SEED_RESTAURANTS.flatMap((r) => r.items);
    expect(items.some((i) => i[3])).toBe(true);
    expect(items.some((i) => !i[3])).toBe(true);
    expect(items.some((i) => i[5]?.includes('x'))).toBe(true);
    expect(SEED_RESTAURANTS.some((r) => !r.isOpen)).toBe(true);
  });

  it('derives stable ids', () => {
    expect(restaurantSeedId('dragon-wok').equals(restaurantSeedId('dragon-wok'))).toBe(true);
    expect(menuItemSeedId('dragon-wok', 'a').equals(menuItemSeedId('dragon-wok', 'b'))).toBe(false);
  });
});

describe('seedCatalog (database)', () => {
  useTestDatabase();

  const expectedItems = SEED_RESTAURANTS.reduce((n, r) => n + r.items.length, 0);

  it('inserts everything with paise prices and valid relationships', async () => {
    const result = await seedCatalog();
    expect(result.restaurants.inserted).toBe(SEED_RESTAURANTS.length);
    expect(result.menuItems.inserted).toBe(expectedItems);

    const biryani = await MenuItemModel.findById(menuItemSeedId('spice-route-biryani-house', 'Chicken Dum Biryani')).lean();
    expect(biryani).toMatchObject({ price: 32900, isVeg: false, isBestseller: true, spiceLevel: 2, isAvailable: true });
    expect(biryani!.restaurantId.equals(restaurantSeedId('spice-route-biryani-house'))).toBe(true);

    const orphanCount = await MenuItemModel.countDocuments({
      restaurantId: { $nin: SEED_RESTAURANTS.map((r) => restaurantSeedId(r.slug)) },
    });
    expect(orphanCount).toBe(0);
  });

  it('is idempotent and does not overwrite API edits unless reset', async () => {
    await seedCatalog();
    const id = menuItemSeedId('dragon-wok', 'Chilli Chicken (Dry)');
    await MenuItemModel.updateOne({ _id: id }, { price: 99900, isAvailable: false });

    const second = await seedCatalog();
    expect(second.restaurants.updated).toBe(0);
    expect(second.menuItems.updated).toBe(0);
    expect(second.restaurants.inserted).toBe(0);
    expect(second.menuItems.inserted).toBe(0);
    expect(await RestaurantModel.countDocuments()).toBe(SEED_RESTAURANTS.length);
    expect(await MenuItemModel.countDocuments()).toBe(expectedItems);
    expect((await MenuItemModel.findById(id).lean())!.price).toBe(99900);

    await seedCatalog({ reset: true });
    expect(await MenuItemModel.findById(id).lean()).toMatchObject({ price: 29900, isAvailable: true });
    expect(await MenuItemModel.countDocuments()).toBe(expectedItems);
  });
});
