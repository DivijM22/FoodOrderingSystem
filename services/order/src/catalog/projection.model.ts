import { Schema, model } from 'mongoose';

/**
 * Local read model of the Catalog Service (authoritative owner). Fed only by
 * catalog.restaurant.updated.v2; disposable and rebuildable from catalog snapshots.
 */
export interface ICatalogRestaurant {
  _id: string; // restaurantId
  catalogVersion: number;
  name: string;
  status: 'active' | 'inactive';
  isOpen: boolean;
  isPureVeg: boolean;
  /** Restaurant administrators (Auth user ids) allowed to see this restaurant's orders. */
  adminIds: string[];
  items: { id: string; name: string; price: number; isVeg: boolean; isAvailable: boolean }[];
  sourceEventId: string;
  syncedAt: Date;
}

const schema = new Schema<ICatalogRestaurant>(
  {
    _id: { type: String, required: true },
    catalogVersion: { type: Number, required: true },
    name: { type: String, required: true },
    status: { type: String, enum: ['active', 'inactive'], required: true },
    isOpen: { type: Boolean, required: true },
    isPureVeg: { type: Boolean, required: true },
    adminIds: { type: [String], default: [] },
    items: [{ _id: false, id: String, name: String, price: Number, isVeg: Boolean, isAvailable: Boolean }],
    sourceEventId: { type: String, required: true },
    syncedAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'catalog_restaurants' },
);

export const CatalogProjectionModel = model<ICatalogRestaurant>('CatalogRestaurant', schema);

/**
 * Idempotent startup migration of projection documents written from v1 events (single `ownerId`) to `adminIds`.
 * The catalogVersion is left unchanged; the Catalog Service publishes newer v2 snapshots after its own migration.
 */
export async function migrateProjectionOwnerIds(): Promise<number> {
  const legacy = await CatalogProjectionModel.collection.find({ ownerId: { $exists: true } }, { projection: { _id: 1, ownerId: 1 } }).toArray();
  for (const doc of legacy) {
    const owner = typeof doc.ownerId === 'string' && doc.ownerId ? [doc.ownerId] : [];
    await CatalogProjectionModel.collection.updateOne({ _id: doc._id, ownerId: { $exists: true } }, { $set: { adminIds: owner }, $unset: { ownerId: '' } });
  }
  await CatalogProjectionModel.collection.updateMany({ adminIds: { $exists: false } }, { $set: { adminIds: [] } });
  return legacy.length;
}
