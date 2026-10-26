import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope, createLogger, OutboxModel } from '@food/common';
import { createApp } from '../src/app.js';
import { ProjectionCatalog } from '../src/catalog/catalog.gateway.js';
import { CatalogProjectionModel } from '../src/catalog/projection.model.js';
import { applyCatalogEvent, requestCatalogSync } from '../src/consumers/catalog-events.js';
import { address, config, ids, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();

let brokerUp = true;
const catalog = new ProjectionCatalog(() => brokerUp);
const app = createApp(config, createLogger('order-test', 'silent'), { catalog });
const customer = userToken('customer');

const snapshot = (version: number, over: Record<string, unknown> = {}) =>
  createEnvelope({
    eventType: 'catalog.restaurant.updated',
    version: 2,
    source: 'catalog-service',
    data: {
      restaurantId: ids.restaurant,
      catalogVersion: version,
      reason: 'change',
      name: 'Spice Route Biryani House',
      status: 'active',
      isOpen: true,
      isPureVeg: false,
      adminIds: [],
      items: [
        { id: ids.biryani, name: 'Chicken Dum Biryani', price: 32900, isVeg: false, isAvailable: true },
        { id: ids.raita, name: 'Raita', price: 4900, isVeg: true, isAvailable: true },
      ],
      updatedAt: new Date().toISOString(),
      ...over,
    },
  });

const order = (items: object[]) => request(app).post('/orders').set(customer.header).send({ restaurantId: ids.restaurant, items, deliveryAddress: address });

beforeEach(() => {
  brokerUp = true;
});

describe('catalog read model', () => {
  it('refuses to price orders before the first snapshot (no stale or missing data)', async () => {
    const res = await order([{ menuItemId: ids.biryani, quantity: 1 }]);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CATALOG_SYNC_PENDING');
  });

  it('prices orders from the projection (no HTTP to the Catalog Service)', async () => {
    await applyCatalogEvent(snapshot(1));
    const res = await order([{ menuItemId: ids.biryani, quantity: 2 }]);
    expect(res.status).toBe(201);
    expect(res.body.data.subtotal).toBe(65800);
    expect(res.body.data.statusHistory[0].metadata).toEqual({ catalogVersion: '1' });
  });

  it('applies only newer versions: duplicates and out-of-order snapshots are harmless', async () => {
    expect(await applyCatalogEvent(snapshot(3, { items: [{ id: ids.biryani, name: 'Chicken Dum Biryani', price: 35000, isVeg: false, isAvailable: true }] }))).toBe('applied');
    expect(await applyCatalogEvent(snapshot(2))).toBe('stale'); // older, delivered late
    expect(await applyCatalogEvent(snapshot(3))).toBe('stale'); // duplicate
    const r = (await CatalogProjectionModel.findById(ids.restaurant).lean())!;
    expect(r.catalogVersion).toBe(3);
    expect(r.items[0]!.price).toBe(35000);
  });

  it('reflects availability and open/closed changes immediately', async () => {
    await applyCatalogEvent(snapshot(1));
    await applyCatalogEvent(snapshot(2, { items: [{ id: ids.biryani, name: 'Chicken Dum Biryani', price: 32900, isVeg: false, isAvailable: false }] }));
    expect((await order([{ menuItemId: ids.biryani, quantity: 1 }])).body.error.code).toBe('ORDER_ITEMS_INVALID');
    await applyCatalogEvent(snapshot(3, { isOpen: false }));
    expect((await order([{ menuItemId: ids.biryani, quantity: 1 }])).body.error.code).toBe('RESTAURANT_CLOSED');
  });

  it('refuses to price orders while the broker is down (freshness cannot be established)', async () => {
    await applyCatalogEvent(snapshot(1));
    brokerUp = false;
    const res = await order([{ menuItemId: ids.biryani, quantity: 1 }]);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CATALOG_SYNC_UNAVAILABLE');
  });

  it('serves restaurant administrator assignments from the projection (newer versions only)', async () => {
    await applyCatalogEvent(snapshot(1, { adminIds: ['admin-1', 'admin-2'] }));
    expect(await catalog.getRestaurant(ids.restaurant)).toMatchObject({ adminIds: ['admin-1', 'admin-2'] });
    await applyCatalogEvent(snapshot(2, { adminIds: ['admin-2'] })); // admin-1 removed
    await applyCatalogEvent(snapshot(1, { adminIds: ['admin-1', 'admin-2'] })); // late duplicate cannot restore it
    expect(await catalog.getRestaurant(ids.restaurant)).toMatchObject({ adminIds: ['admin-2'] });
  });

  it('requests a re-broadcast through the outbox (bootstrap/repair)', async () => {
    await requestCatalogSync('test');
    expect(await OutboxModel.countDocuments({ eventType: 'catalog.sync_requested' })).toBe(1);
  });
});
