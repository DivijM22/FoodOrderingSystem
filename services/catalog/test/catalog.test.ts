import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@food/common';
import { createApp } from '../src/app.js';
import { RestaurantModel } from '../src/models/restaurant.model.js';
import { menuItemSeedId, restaurantSeedId, seedCatalog } from '../src/seed/seed.js';
import { CatalogService } from '../src/services/catalog.service.js';
import { config, tokenFor } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const service = new CatalogService();
const app = createApp(config, createLogger('catalog-test', 'silent'), { service });

const biryaniHouse = restaurantSeedId('spice-route-biryani-house').toString();
const annapoorna = restaurantSeedId('annapoorna-tiffin-centre').toString();
const tandooriNights = restaurantSeedId('tandoori-nights').toString();

const newRestaurant = {
  name: 'Momo Mania',
  description: 'Steamed, fried and tandoori momos with fiery chutneys.',
  cuisines: ['Tibetan', 'Momos'],
  address: { line1: '5th Cross', area: 'Kammanahalli', city: 'Bengaluru', pincode: '560084' },
  costForTwo: 40000,
  avgDeliveryMinutes: 30,
};

beforeEach(async () => {
  await seedCatalog();
});

describe('browsing restaurants', () => {
  it('lists active restaurants with pagination meta, best rated first', async () => {
    const res = await request(app).get('/restaurants?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 5, total: 16, totalPages: 4 });
    const ratings = res.body.data.map((r: { rating: number }) => r.rating);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
  });

  it('filters by cuisine, city, pure-veg and open status', async () => {
    const byCuisine = await request(app).get('/restaurants?cuisine=biryani');
    expect(byCuisine.body.data.map((r: { id: string }) => r.id)).toContain(biryaniHouse);
    expect(byCuisine.body.data.every((r: { cuisines: string[] }) => r.cuisines.includes('Biryani'))).toBe(true);

    const bengaluru = await request(app).get('/restaurants?city=bengaluru');
    expect(bengaluru.body.data.length).toBeGreaterThanOrEqual(4);
    expect(bengaluru.body.data.every((r: { address: { city: string } }) => r.address.city === 'Bengaluru')).toBe(true);

    const veg = await request(app).get('/restaurants?pureVeg=true');
    expect(veg.body.data.every((r: { isPureVeg: boolean }) => r.isPureVeg)).toBe(true);

    const open = await request(app).get('/restaurants?isOpen=true&limit=50');
    expect(open.body.data.map((r: { id: string }) => r.id)).not.toContain(tandooriNights);
  });

  it('searches by restaurant name and by dish name', async () => {
    const byName = await request(app).get('/restaurants?search=napoli');
    expect(byName.body.data).toHaveLength(1);
    const byDish = await request(app).get('/restaurants?search=ghee roast');
    expect(byDish.body.data.map((r: { slug: string }) => r.slug)).toEqual(['coastal-curry-co']);
  });

  it('treats search input literally (no regex injection)', async () => {
    const res = await request(app).get('/restaurants?search=.*');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('sorts by delivery time and validates query params', async () => {
    const res = await request(app).get('/restaurants?sort=deliveryTime&limit=50');
    const times = res.body.data.map((r: { avgDeliveryMinutes: number }) => r.avgDeliveryMinutes);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect((await request(app).get('/restaurants?sort=bogus')).status).toBe(400);
    expect((await request(app).get('/restaurants?limit=1000')).status).toBe(400);
  });

  it('lists distinct cuisines', async () => {
    const res = await request(app).get('/restaurants/cuisines');
    expect(res.body.data).toEqual(expect.arrayContaining(['Biryani', 'Italian', 'South Indian', 'Café']));
  });

  it('returns restaurant details, 404 for unknown ids and 400 for malformed ids', async () => {
    const ok = await request(app).get(`/restaurants/${annapoorna}`);
    expect(ok.body.data).toMatchObject({ name: 'Annapoorna Tiffin Centre', isPureVeg: true, costForTwo: 25000 });
    expect((await request(app).get('/restaurants/0123456789abcdef01234567')).status).toBe(404);
    expect((await request(app).get('/restaurants/not-an-id')).status).toBe(400);
  });
});

describe('menus', () => {
  it('returns the full menu with categories and a restaurant summary', async () => {
    const res = await request(app).get(`/restaurants/${biryaniHouse}/menu`);
    expect(res.status).toBe(200);
    expect(res.body.data.restaurant).toMatchObject({ id: biryaniHouse, isOpen: true, status: 'active' });
    expect(res.body.data.items).toHaveLength(11);
    expect(res.body.data.categories).toEqual(expect.arrayContaining(['Biryani', 'Starters', 'Desserts']));
    expect(res.body.data.items.some((i: { isAvailable: boolean }) => !i.isAvailable)).toBe(true);
  });

  it('filters menus by availability, veg and category', async () => {
    const available = await request(app).get(`/restaurants/${biryaniHouse}/menu?availableOnly=true`);
    expect(available.body.data.items.every((i: { isAvailable: boolean }) => i.isAvailable)).toBe(true);
    const veg = await request(app).get(`/restaurants/${biryaniHouse}/menu?vegOnly=true&category=biryani`);
    expect(veg.body.data.items.map((i: { name: string }) => i.name)).toEqual(['Veg Dum Biryani']);
  });

  it('returns a single menu item', async () => {
    const itemId = menuItemSeedId('annapoorna-tiffin-centre', 'Filter Coffee').toString();
    const res = await request(app).get(`/restaurants/${annapoorna}/menu/${itemId}`);
    expect(res.body.data).toMatchObject({ name: 'Filter Coffee', price: 4000, isVeg: true });
    // Item exists but belongs to another restaurant.
    expect((await request(app).get(`/restaurants/${biryaniHouse}/menu/${itemId}`)).status).toBe(404);
  });
});

describe('restaurant management (RBAC)', () => {
  it('requires authentication and a manager role', async () => {
    expect((await request(app).post('/restaurants').send(newRestaurant)).status).toBe(401);
    const customer = tokenFor('customer');
    expect((await request(app).post('/restaurants').set(customer.header).send(newRestaurant)).status).toBe(403);
    const agent = tokenFor('delivery_agent');
    expect((await request(app).patch(`/restaurants/${annapoorna}/open`).set(agent.header).send({ isOpen: false })).status).toBe(403);
  });

  it('only platform admins create restaurants; assigned restaurant admins manage the menu', async () => {
    const admin = tokenFor('platform_admin');
    const owner = tokenFor('restaurant_admin');
    expect((await request(app).post('/restaurants').set(owner.header).send(newRestaurant)).status).toBe(403);
    const created = await request(app).post('/restaurants').set(admin.header).send({ ...newRestaurant, adminIds: [owner.id, owner.id] });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ slug: 'momo-mania', adminIds: [owner.id], isOpen: true, status: 'active' });
    const rid = created.body.data.id;

    const item = await request(app)
      .post(`/restaurants/${rid}/menu`)
      .set(owner.header)
      .send({ name: 'Chicken Steamed Momos', category: 'Momos', price: 18900, isVeg: false });
    expect(item.status).toBe(201);
    const dup = await request(app).post(`/restaurants/${rid}/menu`).set(owner.header).send({ name: 'Chicken Steamed Momos', category: 'Momos', price: 100, isVeg: false });
    expect(dup.status).toBe(409);

    const off = await request(app).patch(`/restaurants/${rid}/menu/${item.body.data.id}/availability`).set(owner.header).send({ isAvailable: false });
    expect(off.body.data.isAvailable).toBe(false);

    const priced = await request(app).patch(`/restaurants/${rid}/menu/${item.body.data.id}`).set(owner.header).send({ price: 19900 });
    expect(priced.body.data.price).toBe(19900);

    await request(app).patch(`/restaurants/${rid}/open`).set(owner.header).send({ isOpen: false }).expect(200);
    await request(app).delete(`/restaurants/${rid}/menu/${item.body.data.id}`).set(owner.header).expect(204);
  });

  it('prevents a restaurant admin from managing restaurants they do not own', async () => {
    const owner = tokenFor('restaurant_admin');
    const res = await request(app).patch(`/restaurants/${annapoorna}`).set(owner.header).send({ description: 'Hijacked description text' });
    expect(res.status).toBe(403);
    const itemId = menuItemSeedId('annapoorna-tiffin-centre', 'Filter Coffee').toString();
    expect((await request(app).delete(`/restaurants/${annapoorna}/menu/${itemId}`).set(owner.header)).status).toBe(403);
  });

  it('lets only platform admins assign administrators (many-to-many, no duplicates, no hierarchy)', async () => {
    const admin = tokenFor('platform_admin');
    const a = tokenFor('restaurant_admin');
    const b = tokenFor('restaurant_admin');
    expect((await request(app).post(`/restaurants/${annapoorna}/admins`).set(a.header).send({ userId: a.id })).status).toBe(403);
    expect((await request(app).patch(`/restaurants/${annapoorna}`).set(admin.header).send({ adminIds: [a.id] })).status).toBe(400);
    await request(app).post(`/restaurants/${annapoorna}/admins`).set(admin.header).send({ userId: a.id }).expect(200);
    const twice = await request(app).post(`/restaurants/${annapoorna}/admins`).set(admin.header).send({ userId: a.id }).expect(200);
    await request(app).post(`/restaurants/${annapoorna}/admins`).set(admin.header).send({ userId: b.id }).expect(200);
    expect(twice.body.data.adminIds).toEqual([a.id]);
    // Both administrators have identical rights; customers never see administrator ids.
    expect((await request(app).patch(`/restaurants/${annapoorna}`).set(a.header).send({ avgDeliveryMinutes: 20 })).body.data.avgDeliveryMinutes).toBe(20);
    expect((await request(app).patch(`/restaurants/${annapoorna}/open`).set(b.header).send({ isOpen: false })).status).toBe(200);
    expect((await request(app).patch(`/restaurants/${annapoorna}`).set(a.header).send({ status: 'inactive' })).status).toBe(403);
    expect((await request(app).get(`/restaurants/${annapoorna}`)).body.data.adminIds).toBeUndefined();
    expect((await request(app).get(`/restaurants/${annapoorna}`).set(a.header)).body.data.adminIds).toEqual([a.id, b.id]);
    expect((await request(app).get('/restaurants/mine').set(b.header)).body.data.map((r: { id: string }) => r.id)).toEqual([annapoorna]);
    // Removal is immediate in Catalog.
    await request(app).delete(`/restaurants/${annapoorna}/admins/${a.id}`).set(admin.header).expect(200);
    expect((await request(app).patch(`/restaurants/${annapoorna}`).set(a.header).send({ avgDeliveryMinutes: 25 })).status).toBe(403);
  });

  it('removes a deactivated administrator, but never an assignment made after the deactivation', async () => {
    const admin = tokenFor('platform_admin');
    const a = tokenFor('restaurant_admin');
    await request(app).post(`/restaurants/${annapoorna}/admins`).set(admin.header).send({ userId: a.id }).expect(200);
    const deactivatedAt = new Date();
    await new Promise((r) => setTimeout(r, 5));
    const other = (await request(app).get('/restaurants?limit=50')).body.data.find((r: { id: string }) => r.id !== annapoorna).id;
    await request(app).post(`/restaurants/${other}/admins`).set(admin.header).send({ userId: a.id }).expect(200); // after reactivation
    expect(await service.removeDeactivatedAdmin(a.id, deactivatedAt)).toBe(1);
    expect(await service.removeDeactivatedAdmin(a.id, deactivatedAt)).toBe(0); // duplicate event: no-op
    expect((await RestaurantModel.findById(annapoorna).lean())!.adminIds).toEqual([]);
    expect((await RestaurantModel.findById(other).lean())!.adminIds).toEqual([a.id]);
  });

  it('removes every assignment of a deleted user, publishes snapshots, and refuses re-assigning the id', async () => {
    const admin = tokenFor('platform_admin');
    const a = tokenFor('restaurant_admin');
    const keep = tokenFor('restaurant_admin');
    const other = (await request(app).get('/restaurants?limit=50')).body.data.find((r: { id: string }) => r.id !== annapoorna).id;
    for (const r of [annapoorna, other]) await request(app).post(`/restaurants/${r}/admins`).set(admin.header).send({ userId: a.id }).expect(200);
    await request(app).post(`/restaurants/${annapoorna}/admins`).set(admin.header).send({ userId: keep.id }).expect(200);
    const versionBefore = (await RestaurantModel.findById(annapoorna).lean())!.catalogVersion;
    const menuBefore = (await request(app).get(`/restaurants/${annapoorna}/menu`)).body.data.items.length;

    // No timestamp cut-off: even an assignment made "after" the deletion time is removed (ids are never reused).
    expect(await service.removeDeletedAdmin(a.id, 'restaurant_admin', new Date(Date.now() - 60_000))).toBe(2);
    expect(await service.removeDeletedAdmin(a.id, 'restaurant_admin', new Date())).toBe(0); // duplicate: no-op
    const after = (await RestaurantModel.findById(annapoorna).lean())!;
    expect(after.adminIds).toEqual([keep.id]);
    expect(after.catalogVersion).toBeGreaterThan(versionBefore);
    expect((await RestaurantModel.findById(other).lean())!.adminIds).toEqual([]);
    expect((await request(app).get(`/restaurants/${annapoorna}/menu`)).body.data.items.length).toBe(menuBefore);

    const again = await request(app).post(`/restaurants/${other}/admins`).set(admin.header).send({ userId: a.id });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('USER_DELETED');
  });

  it('enforces pure-veg menus and integer paise prices', async () => {
    const admin = tokenFor('platform_admin');
    const nonVeg = await request(app).post(`/restaurants/${annapoorna}/menu`).set(admin.header).send({ name: 'Chicken Dosa', category: 'Dosa', price: 15000, isVeg: false });
    expect(nonVeg.status).toBe(409);
    expect(nonVeg.body.error.code).toBe('PURE_VEG_VIOLATION');
    const fractional = await request(app).post(`/restaurants/${annapoorna}/menu`).set(admin.header).send({ name: 'Plain Dosa', category: 'Dosa', price: 99.5, isVeg: true });
    expect(fractional.status).toBe(400);
  });

  it('soft-deletes restaurants: hidden from customers, visible to admins', async () => {
    const admin = tokenFor('platform_admin');
    const owner = tokenFor('restaurant_admin');
    expect((await request(app).delete(`/restaurants/${annapoorna}`).set(owner.header)).status).toBe(403);
    await request(app).delete(`/restaurants/${annapoorna}`).set(admin.header).expect(200);

    expect((await request(app).get(`/restaurants/${annapoorna}`)).status).toBe(404);
    expect((await request(app).get(`/restaurants/${annapoorna}/menu`)).status).toBe(404);
    expect((await request(app).get('/restaurants?limit=50')).body.meta.total).toBe(15);
    expect((await request(app).get(`/restaurants/${annapoorna}`).set(admin.header)).body.data.status).toBe('inactive');
    expect((await request(app).get('/restaurants?includeInactive=true').set(admin.header)).body.meta.total).toBe(16);
    expect(await RestaurantModel.countDocuments()).toBe(16);
  });
});

describe('GET /health', () => {
  it('is healthy when mongo is connected', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('catalog-service');
  });
});
