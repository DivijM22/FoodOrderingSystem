import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const paise = z.number().int('Amounts are integer paise').min(0).max(10_000_000);
const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

export const restaurantIdParams = z.object({ id: objectId });
export const menuItemParams = z.object({ id: objectId, itemId: objectId });

export const listRestaurantsQuery = z.object({
  search: z.string().trim().min(1).max(60).optional(),
  cuisine: z.string().trim().min(1).max(40).optional(),
  city: z.string().trim().min(1).max(60).optional(),
  isOpen: boolString.optional(),
  pureVeg: boolString.optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  maxCostForTwo: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['rating', 'deliveryTime', 'costLowToHigh', 'costHighToLow', 'name']).default('rating'),
  includeInactive: boolString.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListRestaurantsQuery = z.infer<typeof listRestaurantsQuery>;

export const menuQuery = z.object({
  category: z.string().trim().min(1).max(60).optional(),
  vegOnly: boolString.optional(),
  availableOnly: boolString.optional(),
});
export type MenuQuery = z.infer<typeof menuQuery>;

const address = z.object({
  line1: z.string().trim().min(3).max(200),
  area: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(60),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Invalid PIN code'),
});

export const createRestaurantBody = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().min(10).max(500),
    cuisines: z.array(z.string().trim().min(2).max(40)).min(1).max(8),
    tags: z.array(z.string().trim().min(2).max(30)).max(10).default([]),
    address,
    isPureVeg: z.boolean().default(false),
    costForTwo: paise,
    avgDeliveryMinutes: z.number().int().min(5).max(180),
    openingHours: z.object({ opens: time, closes: time }).default({ opens: '10:00', closes: '23:00' }),
    imageUrl: z.url().optional(),
    /** Optional initial restaurant administrators (Auth user ids); duplicates are ignored. Platform admins only. */
    adminIds: z.array(objectId).max(50).default([]),
  })
  .strict();
export type CreateRestaurantInput = z.infer<typeof createRestaurantBody>;

/** Assignments are not editable here: use POST/DELETE /restaurants/:id/admins (platform admins only). */
export const updateRestaurantBody = createRestaurantBody
  .omit({ adminIds: true })
  .partial()
  .extend({ status: z.enum(['active', 'inactive']).optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'At least one field is required');
export type UpdateRestaurantInput = z.infer<typeof updateRestaurantBody>;

export const setOpenBody = z.object({ isOpen: z.boolean() }).strict();
export const addAdminBody = z.object({ userId: objectId }).strict();
export const adminParams = z.object({ id: objectId, userId: objectId });

export const createMenuItemBody = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(300).default(''),
    category: z.string().trim().min(2).max(60),
    price: paise.min(100, 'Minimum price is ₹1 (100 paise)'),
    isVeg: z.boolean(),
    isAvailable: z.boolean().default(true),
    isBestseller: z.boolean().default(false),
    spiceLevel: z.number().int().min(0).max(3).default(0),
    imageUrl: z.url().optional(),
  })
  .strict();
export type CreateMenuItemInput = z.infer<typeof createMenuItemBody>;

export const updateMenuItemBody = createMenuItemBody
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'At least one field is required');
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemBody>;

export const setAvailabilityBody = z.object({ isAvailable: z.boolean() }).strict();
