import { Schema, model } from 'mongoose';

/**
 * Tombstone of a permanently deleted Auth account (from auth.user.deleted.v1). Auth never reuses ids, so a
 * tombstoned id can never be assigned as a restaurant administrator again.
 */
export interface IDeletedUser {
  _id: string;
  role: string;
  deletedAt: Date;
}

const deletedUserSchema = new Schema<IDeletedUser>(
  {
    _id: { type: String, required: true },
    role: { type: String, required: true },
    deletedAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'deleted_users' },
);

export const DeletedUserModel = model<IDeletedUser>('DeletedUser', deletedUserSchema);
