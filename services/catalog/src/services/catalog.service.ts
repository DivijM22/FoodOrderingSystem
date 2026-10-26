import { ConflictError, enqueueEvent, EventTypes, ForbiddenError, NotFoundError, type AuthUser } from '@food/common';
import mongoose, { type ClientSession, type QueryFilter, type SortOrder, type Types } from 'mongoose';
import { DeletedUserModel } from '../models/deleted-user.model.js';
import { MenuItemModel, toPublicMenuItem, type IMenuItem } from '../models/menu-item.model.js';
import { RestaurantModel, toPublicRestaurant, type IRestaurant } from '../models/restaurant.model.js';
import type {
  CreateMenuItemInput,
  CreateRestaurantInput,
  ListRestaurantsQuery,
  MenuQuery,
  UpdateMenuItemInput,
  UpdateRestaurantInput,
} from '../schemas.js';

const SORTS: Record<ListRestaurantsQuery['sort'], Record<string, SortOrder>> = {
  rating: { rating: -1, ratingCount: -1, name: 1 },
  deliveryTime: { avgDeliveryMinutes: 1, rating: -1 },
  costLowToHigh: { costForTwo: 1, rating: -1 },
  costHighToLow: { costForTwo: -1, rating: -1 },
  name: { name: 1 },
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const SERVICE_NAME = 'catalog-service';

/**
 * Writes the restaurant's full snapshot (restaurant + whole menu) to the outbox inside `session`.
 * `change` bumps catalogVersion first; `snapshot` re-publishes the current version unchanged.
 */
export async function publishRestaurantSnapshot(session: ClientSession, restaurantId: Types.ObjectId, reason: 'change' | 'snapshot') {
  const restaurant =
    reason === 'change'
      ? await RestaurantModel.findByIdAndUpdate(restaurantId, { $inc: { catalogVersion: 1 } }, { returnDocument: 'after', session, timestamps: false }).lean()
      : await RestaurantModel.findById(restaurantId).session(session).lean();
  if (!restaurant) return;
  const items = await MenuItemModel.find({ restaurantId }).session(session).lean();
  await enqueueEvent(session, {
    source: SERVICE_NAME,
    eventType: EventTypes.CatalogRestaurantUpdated,
    aggregateId: restaurantId.toString(),
    data: {
      restaurantId: restaurantId.toString(),
      catalogVersion: restaurant.catalogVersion ?? 0,
      reason,
      name: restaurant.name,
      status: restaurant.status,
      isOpen: restaurant.isOpen,
      isPureVeg: restaurant.isPureVeg,
      adminIds: restaurant.adminIds ?? [],
      items: items.map((i) => ({ id: i._id.toString(), name: i.name, price: i.price, isVeg: i.isVeg, isAvailable: i.isAvailable })),
      updatedAt: new Date().toISOString(),
    },
  });
}

export class CatalogService {
  constructor(private readonly afterCommit: () => void = () => undefined) {}

  // ---------------------------------------------------------------- reads

  async listRestaurants(q: ListRestaurantsQuery, viewer?: AuthUser) {
    const filter: QueryFilter<IRestaurant> = {};
    if (!(q.includeInactive && viewer?.role === 'platform_admin')) filter.status = 'active';
    if (q.cuisine) filter.cuisines = new RegExp(`^${escapeRegex(q.cuisine)}$`, 'i');
    if (q.city) filter['address.city'] = new RegExp(`^${escapeRegex(q.city)}$`, 'i');
    if (q.isOpen !== undefined) filter.isOpen = q.isOpen;
    if (q.pureVeg) filter.isPureVeg = true;
    if (q.minRating !== undefined) filter.rating = { $gte: q.minRating };
    if (q.maxCostForTwo !== undefined) filter.costForTwo = { $lte: q.maxCostForTwo };

    if (q.search) {
      // Match restaurant name/cuisine/tags, or any restaurant serving a dish with that name.
      const rx = new RegExp(escapeRegex(q.search), 'i');
      const dishRestaurantIds = await MenuItemModel.distinct('restaurantId', { name: rx });
      filter.$or = [{ name: rx }, { cuisines: rx }, { tags: rx }, { _id: { $in: dishRestaurantIds } }];
    }

    const [items, total] = await Promise.all([
      RestaurantModel.find(filter)
        .sort(SORTS[q.sort])
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      RestaurantModel.countDocuments(filter),
    ]);
    return { restaurants: items.map((r) => toPublicRestaurant(r, viewer)), total };
  }

  async getRestaurant(id: string, viewer?: AuthUser) {
    return toPublicRestaurant(await this.findVisible(id, viewer), viewer);
  }

  /** Restaurants the signed-in restaurant administrator is assigned to (including inactive ones). */
  async listMine(admin: AuthUser) {
    const items = await RestaurantModel.find({ adminIds: admin.id }).sort({ name: 1 }).lean();
    return items.map((r) => toPublicRestaurant(r, admin));
  }

  async listCuisines() {
    const cuisines: string[] = await RestaurantModel.distinct('cuisines', { status: 'active' });
    return cuisines.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Menu with a restaurant summary. The Order Service uses this single call to validate
   * restaurant status, item availability and current prices before accepting an order.
   */
  async getMenu(restaurantId: string, q: MenuQuery, viewer?: AuthUser) {
    const restaurant = await this.findVisible(restaurantId, viewer);
    const filter: QueryFilter<IMenuItem> = { restaurantId: restaurant._id };
    if (q.category) filter.category = new RegExp(`^${escapeRegex(q.category)}$`, 'i');
    if (q.vegOnly) filter.isVeg = true;
    if (q.availableOnly) filter.isAvailable = true;

    const items = await MenuItemModel.find(filter).sort({ category: 1, isBestseller: -1, name: 1 }).lean();
    const categories = [...new Set(items.map((i) => i.category))];
    return {
      restaurant: {
        id: restaurant._id.toString(),
        name: restaurant.name,
        isOpen: restaurant.isOpen,
        status: restaurant.status,
        isPureVeg: restaurant.isPureVeg,
      },
      categories,
      items: items.map(toPublicMenuItem),
    };
  }

  async getMenuItem(restaurantId: string, itemId: string, viewer?: AuthUser) {
    const restaurant = await this.findVisible(restaurantId, viewer);
    const item = await MenuItemModel.findOne({ _id: itemId, restaurantId: restaurant._id }).lean();
    if (!item) throw new NotFoundError('Menu item not found');
    return toPublicMenuItem(item);
  }

  // ---------------------------------------------------------------- restaurant management
  // Every mutation runs in a transaction that also bumps the restaurant's catalogVersion and writes a
  // catalog.restaurant.updated.v1 snapshot to the outbox, so subscribers (the Order Service's read
  // model) can never miss or misorder a change.

  /** Platform admins only (also enforced by the route). Initial administrators are optional. */
  async createRestaurant(input: CreateRestaurantInput, actor: AuthUser) {
    if (actor.role !== 'platform_admin') throw new ForbiddenError('Only platform administrators can create restaurants');
    const adminIds = [...new Set(input.adminIds ?? [])];
    await this.assertNotDeleted(adminIds);
    const now = new Date();
    const slug = await this.uniqueSlug(input.name);
    return this.mutate(async (session) => {
      const [created] = await RestaurantModel.create(
        [{ ...input, adminIds, adminAssignedAt: Object.fromEntries(adminIds.map((id) => [id, now])), slug }],
        { session },
      );
      return { restaurantId: created!._id, result: toPublicRestaurant(created!, actor) };
    });
  }

  async updateRestaurant(id: string, changes: UpdateRestaurantInput, actor: AuthUser) {
    const restaurant = await this.findManageable(id, actor);
    if (changes.status !== undefined && actor.role !== 'platform_admin') {
      throw new ForbiddenError('Only platform administrators can change the listing status');
    }
    return this.mutate(async (session) => {
      restaurant.set(changes);
      await restaurant.save({ session });
      return { restaurantId: restaurant._id, result: toPublicRestaurant(restaurant, actor) };
    });
  }

  // ---------------------------------------------------------------- administrator assignments (platform admins)

  /** Assigns a restaurant administrator. Atomic and idempotent ($addToSet semantics: never a duplicate id). */
  async addAdmin(id: string, userId: string, actor: AuthUser) {
    const restaurant = await RestaurantModel.findById(id).lean();
    if (!restaurant) throw new NotFoundError('Restaurant not found');
    await this.assertNotDeleted([userId]);
    await this.mutateIf(async (session) => {
      const res = await RestaurantModel.updateOne(
        { _id: restaurant._id, adminIds: { $ne: userId } },
        { $addToSet: { adminIds: userId }, $set: { [`adminAssignedAt.${userId}`]: new Date() } },
        { session },
      );
      return res.modifiedCount === 1 ? restaurant._id : null;
    });
    return toPublicRestaurant((await RestaurantModel.findById(id).lean())!, actor);
  }

  /** Removes a restaurant administrator ($pull). Idempotent: removing someone not assigned changes nothing. */
  async removeAdmin(id: string, userId: string, actor: AuthUser) {
    const restaurant = await RestaurantModel.findById(id).lean();
    if (!restaurant) throw new NotFoundError('Restaurant not found');
    await this.mutateIf(async (session) => {
      const res = await RestaurantModel.updateOne(
        { _id: restaurant._id, adminIds: userId },
        { $pull: { adminIds: userId }, $unset: { [`adminAssignedAt.${userId}`]: 1 } },
        { session },
      );
      return res.modifiedCount === 1 ? restaurant._id : null;
    });
    return toPublicRestaurant((await RestaurantModel.findById(id).lean())!, actor);
  }

  /**
   * auth.user.deactivated: removes the user from every restaurant they were assigned to BEFORE `deactivatedAt`.
   * Assignments made later (after a reactivation) survive a delayed or duplicate event. Each removal publishes
   * an updated restaurant snapshot so the Order Service projection follows. Returns the number of restaurants changed.
   */
  async removeDeactivatedAdmin(userId: string, deactivatedAt: Date): Promise<number> {
    return this.removeAdminEverywhere(userId, {
      $or: [{ [`adminAssignedAt.${userId}`]: { $exists: false } }, { [`adminAssignedAt.${userId}`]: { $lt: deactivatedAt } }],
    });
  }

  /**
   * auth.user.deleted: the account is gone for good and Auth never reuses ids, so EVERY assignment of the id is
   * removed — no timestamp cut-off, unlike deactivation. The tombstone is written first, so the id cannot be assigned
   * again afterwards. Idempotent: a duplicate or delayed event finds nothing left to remove.
   */
  async removeDeletedAdmin(userId: string, role: string, deletedAt: Date): Promise<number> {
    await DeletedUserModel.updateOne({ _id: userId }, { $setOnInsert: { role, deletedAt } }, { upsert: true });
    return this.removeAdminEverywhere(userId, {});
  }

  /** Pulls `userId` from every restaurant matching `extra`, one transaction (and v2 snapshot) per restaurant. */
  private async removeAdminEverywhere(userId: string, extra: QueryFilter<IRestaurant>): Promise<number> {
    const filter: QueryFilter<IRestaurant> = { adminIds: userId, ...extra };
    const restaurants = await RestaurantModel.find(filter, { _id: 1 }).lean();
    let changed = 0;
    for (const { _id } of restaurants) {
      const did = await this.mutateIf(async (session) => {
        const res = await RestaurantModel.updateOne(
          { _id, ...filter },
          { $pull: { adminIds: userId }, $unset: { [`adminAssignedAt.${userId}`]: 1 } },
          { session },
        );
        return res.modifiedCount === 1 ? _id : null;
      });
      if (did) changed++;
    }
    return changed;
  }

  /** Deleted accounts can never be (re)assigned. 409 USER_DELETED. */
  private async assertNotDeleted(userIds: string[]) {
    if (userIds.length && (await DeletedUserModel.exists({ _id: { $in: userIds } }))) {
      throw new ConflictError('That account has been deleted and cannot be assigned', 'USER_DELETED');
    }
  }

  /**
   * One-time, idempotent migration from the single `ownerId` (≤ Stage 8.1) to `adminIds`: a non-null owner becomes
   * the first admin, null becomes []. `ownerId` is then removed and a newer catalogVersion is published (v2 event),
   * so the Order Service projection picks the assignment up. Nothing else on the restaurant is touched.
   */
  async migrateOwnerIds(): Promise<number> {
    const legacy = await RestaurantModel.collection.find({ ownerId: { $exists: true } }, { projection: { _id: 1, ownerId: 1, adminIds: 1 } }).toArray();
    let migrated = 0;
    for (const doc of legacy) {
      const owner = typeof doc.ownerId === 'string' && doc.ownerId ? doc.ownerId : null;
      const adminIds = [...new Set([...(Array.isArray(doc.adminIds) ? doc.adminIds : []), ...(owner ? [owner] : [])])];
      const did = await this.mutateIf(async (session) => {
        const res = await RestaurantModel.collection.updateOne(
          { _id: doc._id, ownerId: { $exists: true } },
          { $set: { adminIds, ...(owner ? { [`adminAssignedAt.${owner}`]: new Date() } : {}) }, $unset: { ownerId: '' } },
          { session },
        );
        return res.modifiedCount === 1 ? (doc._id as Types.ObjectId) : null;
      });
      if (did) migrated++;
    }
    // Restaurants that never had either field get an explicit empty list.
    await RestaurantModel.collection.updateMany({ adminIds: { $exists: false } }, { $set: { adminIds: [], adminAssignedAt: {} } });
    return migrated;
  }

  async setOpen(id: string, isOpen: boolean, actor: AuthUser) {
    const restaurant = await this.findManageable(id, actor);
    return this.mutate(async (session) => {
      restaurant.isOpen = isOpen;
      await restaurant.save({ session });
      return { restaurantId: restaurant._id, result: toPublicRestaurant(restaurant, actor) };
    });
  }

  /** Soft delete: hidden from listings, but existing orders keep a valid reference. */
  async deactivateRestaurant(id: string, actor?: AuthUser) {
    return this.mutate(async (session) => {
      const restaurant = await RestaurantModel.findByIdAndUpdate(id, { status: 'inactive', isOpen: false }, { returnDocument: 'after', session });
      if (!restaurant) throw new NotFoundError('Restaurant not found');
      return { restaurantId: restaurant._id, result: toPublicRestaurant(restaurant, actor) };
    });
  }

  // ---------------------------------------------------------------- menu management

  async addMenuItem(restaurantId: string, input: CreateMenuItemInput, actor: AuthUser) {
    const restaurant = await this.findManageable(restaurantId, actor);
    if (restaurant.isPureVeg && !input.isVeg) throw new ConflictError('A pure-veg restaurant cannot list non-veg items', 'PURE_VEG_VIOLATION');
    try {
      return await this.mutate(async (session) => {
        const [item] = await MenuItemModel.create([{ ...input, restaurantId: restaurant._id }], { session });
        return { restaurantId: restaurant._id, result: toPublicMenuItem(item!) };
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictError('This restaurant already has an item with that name', 'DUPLICATE_ITEM');
      throw err;
    }
  }

  async updateMenuItem(restaurantId: string, itemId: string, changes: UpdateMenuItemInput, actor: AuthUser) {
    const restaurant = await this.findManageable(restaurantId, actor);
    if (restaurant.isPureVeg && changes.isVeg === false) throw new ConflictError('A pure-veg restaurant cannot list non-veg items', 'PURE_VEG_VIOLATION');
    const item = await MenuItemModel.findOne({ _id: itemId, restaurantId: restaurant._id });
    if (!item) throw new NotFoundError('Menu item not found');
    try {
      return await this.mutate(async (session) => {
        item.set(changes);
        await item.save({ session });
        return { restaurantId: restaurant._id, result: toPublicMenuItem(item) };
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictError('This restaurant already has an item with that name', 'DUPLICATE_ITEM');
      throw err;
    }
  }

  async setAvailability(restaurantId: string, itemId: string, isAvailable: boolean, actor: AuthUser) {
    return this.updateMenuItem(restaurantId, itemId, { isAvailable }, actor);
  }

  async deleteMenuItem(restaurantId: string, itemId: string, actor: AuthUser) {
    const restaurant = await this.findManageable(restaurantId, actor);
    await this.mutate(async (session) => {
      const res = await MenuItemModel.deleteOne({ _id: itemId, restaurantId: restaurant._id }, { session });
      if (res.deletedCount === 0) throw new NotFoundError('Menu item not found');
      return { restaurantId: restaurant._id, result: undefined };
    });
  }

  // ---------------------------------------------------------------- catalog events

  /** Re-broadcasts every restaurant's current snapshot (bootstrap / anti-entropy). Versions are not bumped. */
  async broadcastSnapshots(): Promise<number> {
    const ids = await RestaurantModel.find({}, { _id: 1 }).lean();
    for (const { _id } of ids) {
      await this.tx((session) => publishRestaurantSnapshot(session, _id, 'snapshot'));
    }
    this.afterCommit();
    return ids.length;
  }

  private async mutate<T>(fn: (session: ClientSession) => Promise<{ restaurantId: Types.ObjectId; result: T }>): Promise<T> {
    const result = await this.tx(async (session) => {
      const r = await fn(session);
      await publishRestaurantSnapshot(session, r.restaurantId, 'change');
      return r.result;
    });
    this.afterCommit();
    return result;
  }

  /** Like mutate, but publishes a snapshot only when `fn` reports that it changed the restaurant. */
  private async mutateIf(fn: (session: ClientSession) => Promise<Types.ObjectId | null>): Promise<boolean> {
    const changed = await this.tx(async (session) => {
      const id = await fn(session);
      if (id) await publishRestaurantSnapshot(session, id, 'change');
      return !!id;
    });
    if (changed) this.afterCommit();
    return changed;
  }

  private async tx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Platform admins manage everything; a restaurant admin manages exactly the restaurants listing them in adminIds. */
  private canManage(r: Pick<IRestaurant, 'adminIds'>, actor?: AuthUser): boolean {
    if (!actor) return false;
    return actor.role === 'platform_admin' || (actor.role === 'restaurant_admin' && (r.adminIds ?? []).includes(actor.id));
  }

  /** Customers only see active restaurants; owners and platform admins also see inactive ones. */
  private async findVisible(id: string, viewer?: AuthUser) {
    const restaurant = await RestaurantModel.findById(id);
    if (!restaurant || (restaurant.status !== 'active' && !this.canManage(restaurant, viewer))) {
      throw new NotFoundError('Restaurant not found');
    }
    return restaurant;
  }

  private async findManageable(id: string, actor: AuthUser) {
    const restaurant = await RestaurantModel.findById(id);
    if (!restaurant) throw new NotFoundError('Restaurant not found');
    if (!this.canManage(restaurant, actor)) throw new ForbiddenError('You do not manage this restaurant');
    return restaurant;
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name) || 'restaurant';
    let slug = base;
    for (let n = 2; await RestaurantModel.exists({ slug }); n++) slug = `${base}-${n}`;
    return slug;
  }
}

