import mongoose, { Schema, type Model } from 'mongoose';

/**
 * Account state learned from Auth events (auth.user.deactivated.v1 / auth.user.deleted.v1) for delivery agents.
 * A blocked agent is never assigned a new delivery and cannot go available; a delivery they already hold stays
 * with them (it is not orphaned) and the agent goes offline when it is released.
 * - deleted: permanent (Auth never reuses ids).
 * - disabled: until the agent presents a JWT issued after `disabledAt` — only possible after a reactivation, since
 *   Auth refuses to log in an inactive account. `reenabledAt` stops a delayed deactivation event re-blocking them.
 */
export interface IAccountBlock {
  _id: string; // Auth user id
  disabledAt?: Date;
  reenabledAt?: Date;
  deletedAt?: Date;
}

const accountBlockSchema = new Schema<IAccountBlock>(
  { _id: { type: String, required: true }, disabledAt: Date, reenabledAt: Date, deletedAt: Date },
  { versionKey: false, collection: 'account_blocks' },
);

export const AccountBlockModel =
  (mongoose.models.AccountBlock as Model<IAccountBlock> | undefined) ?? mongoose.model<IAccountBlock>('AccountBlock', accountBlockSchema);

export const isBlocked = (b: IAccountBlock | null | undefined): boolean =>
  !!b && (!!b.deletedAt || (!!b.disabledAt && !(b.reenabledAt && b.reenabledAt > b.disabledAt)));
