import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import type { AuthUser } from '@food/common';

export const RESTAURANT_STATUSES = ['active', 'inactive'] as const;
export type RestaurantStatus = (typeof RESTAURANT_STATUSES)[number];

export interface IRestaurant {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description: string;
  cuisines: string[];
  tags: string[];
  address: { line1: string; area: string; city: string; pincode: string };
  /**
   * Auth Service user ids of the restaurant administrators who manage it (many-to-many, no hierarchy: every listed
   * admin has the same permissions). Only platform admins change it. Empty = unassigned.
   */
  adminIds: string[];
  /** When each admin was assigned (userId → date). A deactivation only removes assignments made before it. */
  adminAssignedAt: Record<string, Date>;
  /** Operating status — whether it is accepting orders right now. */
  isOpen: boolean;
  /** Listing status — inactive restaurants are hidden from customers (soft delete). */
  status: RestaurantStatus;
  isPureVeg: boolean;
  rating: number;
  ratingCount: number;
  /** Approximate cost for two, integer paise. */
  costForTwo: number;
  avgDeliveryMinutes: number;
  openingHours: { opens: string; closes: string };
  imageUrl?: string;
  /** Incremented on every change; lets event consumers apply snapshots in order (see catalog events). */
  catalogVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const restaurantSchema = new Schema<IRestaurant>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, required: true, trim: true },
    cuisines: { type: [String], default: [], index: true },
    tags: { type: [String], default: [] },
    address: {
      line1: { type: String, required: true },
      area: { type: String, required: true },
      city: { type: String, required: true },
      pincode: { type: String, required: true },
    },
    adminIds: { type: [String], default: [], index: true },
    adminAssignedAt: { type: Schema.Types.Mixed, default: () => ({}) },
    isOpen: { type: Boolean, default: true },
    status: { type: String, enum: RESTAURANT_STATUSES, default: 'active' },
    isPureVeg: { type: Boolean, default: false },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    ratingCount: { type: Number, min: 0, default: 0 },
    costForTwo: { type: Number, required: true, min: 0 },
    avgDeliveryMinutes: { type: Number, required: true, min: 5 },
    openingHours: {
      opens: { type: String, default: '10:00' },
      closes: { type: String, default: '23:00' },
    },
    imageUrl: { type: String },
    catalogVersion: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false },
);

restaurantSchema.index({ status: 1, 'address.city': 1, rating: -1 });

export type RestaurantDocument = HydratedDocument<IRestaurant>;
export const RestaurantModel = model<IRestaurant>('Restaurant', restaurantSchema);

/** May this viewer see the restaurant's administrator ids? Platform admins and the restaurant's own admins only. */
export const canSeeAdmins = (r: Pick<IRestaurant, 'adminIds'>, viewer?: AuthUser) =>
  viewer?.role === 'platform_admin' || (viewer?.role === 'restaurant_admin' && (r.adminIds ?? []).includes(viewer.id));

export function toPublicRestaurant(r: IRestaurant, viewer?: AuthUser) {
  return {
    id: r._id.toString(),
    name: r.name,
    slug: r.slug,
    description: r.description,
    cuisines: r.cuisines,
    tags: r.tags,
    address: r.address,
    ...(canSeeAdmins(r, viewer) ? { adminIds: r.adminIds ?? [] } : {}),
    isOpen: r.isOpen,
    status: r.status,
    isPureVeg: r.isPureVeg,
    rating: r.rating,
    ratingCount: r.ratingCount,
    costForTwo: r.costForTwo,
    avgDeliveryMinutes: r.avgDeliveryMinutes,
    openingHours: r.openingHours,
    imageUrl: r.imageUrl ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
