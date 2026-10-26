import { z } from 'zod';
import { ROLES } from '@food/common';

const email = z.email().trim().toLowerCase().max(254);
// Strong-enough passwords without being hostile: 8+ chars with a letter and a digit.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters') // bcrypt truncates beyond 72 bytes
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a digit');
const name = z.string().trim().min(2).max(80);
const phone = z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'Phone must be 10–15 digits');

export const addressInput = z.object({
  label: z.string().trim().max(30).optional(),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Pincode must be a valid 6-digit Indian PIN'),
  landmark: z.string().trim().max(120).optional(),
});

export const registerBody = z.object({ name, email, password, phone: phone.optional() }).strict();

export const loginBody = z.object({ email, password: z.string().min(1).max(72) }).strict();

export const updateProfileBody = z
  .object({ name: name.optional(), phone: phone.optional(), addresses: z.array(addressInput).max(10).optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'At least one field is required');

export const changePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: password }).strict();

export const createUserBody = z.object({ name, email, password, phone: phone.optional(), role: z.enum(ROLES) }).strict();

export const listUsersQuery = z.object({
  role: z.enum(ROLES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const userIdParams = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid user id') });

export const setStatusBody = z.object({ isActive: z.boolean() }).strict();
