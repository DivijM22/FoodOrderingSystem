import { createHash } from 'node:crypto';
import { Types, type AnyBulkWriteOperation } from 'mongoose';
import { MenuItemModel, type IMenuItem } from '../models/menu-item.model.js';
import { RestaurantModel, type IRestaurant } from '../models/restaurant.model.js';
import { SEED_RESTAURANTS, type SeedRestaurant } from './data.js';

/**
 * Deterministic ObjectId derived from a stable key, so the same restaurant/menu item
 * always gets the same id on every machine. Postman collections, tests and the Order
 * Service can rely on these ids.
 */
export function stableId(key: string): Types.ObjectId {
  return new Types.ObjectId(createHash('sha1').update(key).digest('hex').slice(0, 24));
}

export const restaurantSeedId = (slug: string) => stableId(`restaurant:${slug}`);
export const menuItemSeedId = (slug: string, itemName: string) => stableId(`menu-item:${slug}:${itemName}`);

const rupeesToPaise = (rupees: number) => Math.round(rupees * 100);
const isRestaurant = (doc: object) => 'slug' in doc;

export interface SeedResult {
  restaurants: { inserted: number; updated: number };
  menuItems: { inserted: number; updated: number };
  /** Restaurants that gained a document (restaurant or menu item) in this run. */
  insertedRestaurantIds: Types.ObjectId[];
}

/**
 * Idempotent seed.
 * - default mode: inserts missing documents only ($setOnInsert), so re-running never
 *   creates duplicates and never overwrites edits made through the API.
 * - reset mode: additionally restores seeded fields (price, availability, …) to the seed values.
 * `restaurants` defaults to the full demo catalog; the CLI's --sample passes the small manual-testing set.
 */
export async function seedCatalog({ reset = false, restaurants = SEED_RESTAURANTS }: { reset?: boolean; restaurants?: SeedRestaurant[] } = {}): Promise<SeedResult> {
  const now = new Date();
  // Timestamps are handled here (not by the Mongoose plugin) so a no-op re-run touches nothing.
  const upsert = <T extends object>(doc: T) =>
    reset
      ? { $set: { ...doc, updatedAt: now }, $setOnInsert: { createdAt: now }, ...(isRestaurant(doc) ? { $inc: { catalogVersion: 1 } } : {}) }
      : { $setOnInsert: { ...doc, createdAt: now, updatedAt: now } };
  const restaurantOps: AnyBulkWriteOperation<IRestaurant>[] = [];
  const menuOps: AnyBulkWriteOperation<IMenuItem>[] = [];
  const menuRestaurantIds: Types.ObjectId[] = []; // parallel to menuOps

  for (const r of restaurants) {
    const restaurantId = restaurantSeedId(r.slug);
    const { items, costForTwo, ...rest } = r;
    const doc = { ...rest, costForTwo: rupeesToPaise(costForTwo), status: 'active' as const, adminIds: [] as string[], adminAssignedAt: {} };
    restaurantOps.push({
      updateOne: {
        filter: { _id: restaurantId },
        update: upsert(doc),
        upsert: true,
        timestamps: false,
      },
    });

    for (const [name, category, price, isVeg, description, flags = ''] of items) {
      const spice = /s([0-3])/.exec(flags)?.[1];
      const item = {
        restaurantId,
        name,
        category,
        description,
        price: rupeesToPaise(price),
        isVeg,
        isBestseller: /\bb\b/.test(flags),
        isAvailable: !/\bx\b/.test(flags),
        spiceLevel: spice ? Number(spice) : 0,
      };
      menuRestaurantIds.push(restaurantId);
      menuOps.push({
        updateOne: {
          filter: { _id: menuItemSeedId(r.slug, name) },
          update: upsert(item),
          upsert: true,
          timestamps: false,
        },
      });
    }
  }

  // Ensure unique indexes exist before upserting so duplicates are impossible even under concurrency.
  await Promise.all([RestaurantModel.init(), MenuItemModel.init()]);
  const [rRes, mRes] = await Promise.all([
    RestaurantModel.bulkWrite(restaurantOps, { ordered: false }),
    MenuItemModel.bulkWrite(menuOps, { ordered: false }),
  ]);

  const inserted = new Map<string, Types.ObjectId>();
  for (const id of Object.values(rRes.upsertedIds)) inserted.set(String(id), id as Types.ObjectId);
  for (const i of Object.keys(mRes.upsertedIds)) {
    const restaurantId = menuRestaurantIds[Number(i)]!;
    inserted.set(String(restaurantId), restaurantId);
  }

  return {
    insertedRestaurantIds: [...inserted.values()],
    restaurants: { inserted: rRes.upsertedCount, updated: rRes.modifiedCount },
    menuItems: { inserted: mRes.upsertedCount, updated: mRes.modifiedCount },
  };
}
