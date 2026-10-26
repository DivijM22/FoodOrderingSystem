import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, eventDataSchemas, EventTypes, OutboxModel } from '@food/common';
import { createApp } from '../src/app.js';
import { RestaurantModel } from '../src/models/restaurant.model.js';
import { menuItemSeedId, restaurantSeedId, seedCatalog } from '../src/seed/seed.js';
import { CatalogService } from '../src/services/catalog.service.js';
import { config, tokenFor } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const service = new CatalogService();
const app = createApp(config, createLogger('catalog-test', 'silent'), { service });
const rid = restaurantSeedId('annapoorna-tiffin-centre').toString();
const admin = tokenFor('platform_admin');

const events = async (restaurantId = rid) =>
  (await OutboxModel.find({ aggregateId: restaurantId, eventType: 'catalog.restaurant.updated' }).sort({ createdAt: 1 }).lean()).map((e) =>
    eventDataSchemas[EventTypes.CatalogRestaurantUpdated].parse(e.envelope.data),
  );

beforeEach(async () => {
  await seedCatalog();
});

describe('catalog.restaurant.updated.v1', () => {
  it('publishes a full snapshot with a bumped version in the same transaction as each change', async () => {
    const coffee = menuItemSeedId('annapoorna-tiffin-centre', 'Filter Coffee').toString();
    await request(app).patch(`/restaurants/${rid}/menu/${coffee}/availability`).set(admin.header).send({ isAvailable: false }).expect(200);
    await request(app).patch(`/restaurants/${rid}/open`).set(admin.header).send({ isOpen: false }).expect(200);
    const [first, second] = await events();
    expect(first).toMatchObject({ restaurantId: rid, reason: 'change', catalogVersion: 1, isOpen: true });
    expect(first!.items).toHaveLength(10);
    expect(first!.items.find((i) => i.id === coffee)).toMatchObject({ isAvailable: false, price: 4000 });
    expect(second).toMatchObject({ catalogVersion: 2, isOpen: false });
    expect((await RestaurantModel.findById(rid).lean())!.catalogVersion).toBe(2);
  });

  it('covers create, item add/update/delete and deactivation', async () => {
    const owner = tokenFor('restaurant_admin');
    const created = await request(app).post('/restaurants').set(admin.header).send({
      adminIds: [owner.id],
      name: 'Momo Mania', description: 'Steamed and fried momos with chutneys.', cuisines: ['Tibetan'],
      address: { line1: '5th Cross', area: 'Kammanahalli', city: 'Bengaluru', pincode: '560084' }, costForTwo: 40000, avgDeliveryMinutes: 30,
    });
    const id = created.body.data.id;
    const item = await request(app).post(`/restaurants/${id}/menu`).set(owner.header).send({ name: 'Veg Momos', category: 'Momos', price: 14900, isVeg: true });
    await request(app).patch(`/restaurants/${id}/menu/${item.body.data.id}`).set(owner.header).send({ price: 15900 }).expect(200);
    await request(app).delete(`/restaurants/${id}/menu/${item.body.data.id}`).set(owner.header).expect(204);
    await request(app).delete(`/restaurants/${id}`).set(admin.header).expect(200);
    const evts = await events(id);
    expect(evts.map((e) => e.catalogVersion)).toEqual([1, 2, 3, 4, 5]);
    expect(evts.map((e) => e.items.length)).toEqual([0, 1, 1, 0, 0]);
    expect(evts[2]!.items[0]!.price).toBe(15900);
    expect(evts.at(-1)).toMatchObject({ status: 'inactive', isOpen: false, adminIds: [owner.id] });
  });

  it('does not publish when a change is rejected', async () => {
    const owner = tokenFor('restaurant_admin');
    await request(app).patch(`/restaurants/${rid}`).set(owner.header).send({ description: 'Not my restaurant to edit' }).expect(403);
    await request(app).post(`/restaurants/${rid}/menu`).set(admin.header).send({ name: 'Chicken Dosa', category: 'Dosa', price: 15000, isVeg: false }).expect(409);
    expect(await events()).toHaveLength(0);
  });

  it('broadcasts snapshots of every restaurant without bumping versions', async () => {
    expect(await service.broadcastSnapshots()).toBe(16);
    const snaps = await OutboxModel.countDocuments({ eventType: 'catalog.restaurant.updated', 'envelope.data.reason': 'snapshot' });
    expect(snaps).toBe(16);
    expect((await events())[0]).toMatchObject({ reason: 'snapshot', catalogVersion: 0 });
  });

  it('seed --reset bumps versions so read models pick up restored values', async () => {
    await seedCatalog({ reset: true });
    expect((await RestaurantModel.findById(rid).lean())!.catalogVersion).toBe(1);
  });
});
