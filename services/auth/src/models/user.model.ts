import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { ROLES, type Role } from '@food/common';

export interface IAddress {
  _id: Types.ObjectId;
  label: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  pincode: string;
  landmark?: string;
}

export interface IUser {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  phone?: string;
  addresses: IAddress[];
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const addressSchema = new Schema<IAddress>(
  {
    label: { type: String, trim: true, default: 'Home' },
    line1: { type: String, required: true, trim: true },
    line2: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, required: true, trim: true },
    landmark: { type: String, trim: true },
  },
  { _id: true },
);

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Never returned from queries unless explicitly selected.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, default: 'customer' },
    phone: { type: String, trim: true },
    addresses: { type: [addressSchema], default: [] },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

userSchema.index({ role: 1 });

export type UserDocument = HydratedDocument<IUser>;
export const UserModel = model<IUser>('User', userSchema);

/** Public representation of a user — never includes the password hash. */
export function toPublicUser(user: UserDocument) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone ?? null,
    addresses: user.addresses.map((a) => ({
      id: a._id.toString(),
      label: a.label,
      line1: a.line1,
      line2: a.line2,
      city: a.city,
      state: a.state,
      pincode: a.pincode,
      landmark: a.landmark,
    })),
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
