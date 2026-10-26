import mongoose, { Schema, type Model } from 'mongoose';

export const AGENT_STATUSES = ['available', 'busy', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** A delivery partner. `_id` is the Auth Service user id (from the agent's verified JWT). */
export interface IAgent {
  _id: string;
  name: string;
  email: string;
  phone: string;
  status: AgentStatus;
  /** Set exactly while the agent is reserved for a delivery. */
  activeDeliveryId?: string;
  lastAssignedAt?: Date;
  lastReleasedAt?: Date;
  completedDeliveries: number;
  createdAt: Date;
  updatedAt: Date;
}

const agentSchema = new Schema<IAgent>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    status: { type: String, enum: AGENT_STATUSES, default: 'offline' },
    activeDeliveryId: String,
    lastAssignedAt: Date,
    lastReleasedAt: Date,
    completedDeliveries: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'delivery_agents' },
);
agentSchema.index({ status: 1 });
// One agent per delivery, enforced by the database as well as by the compare-and-set reservation.
agentSchema.index({ activeDeliveryId: 1 }, { unique: true, partialFilterExpression: { activeDeliveryId: { $type: 'string' } } });

export const AgentModel = (mongoose.models.DeliveryAgent as Model<IAgent> | undefined) ?? mongoose.model<IAgent>('DeliveryAgent', agentSchema);

/** "+91 98XXXXXX10": enough for the customer to recognise the call, never the full number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const national = digits.slice(-10);
  const cc = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : '';
  return `${cc}${national.slice(0, 2)}${'X'.repeat(Math.max(0, national.length - 4))}${national.slice(-2)}`;
}

export function toAgentProfile(a: IAgent) {
  return {
    id: a._id,
    name: a.name,
    email: a.email,
    phone: a.phone,
    status: a.status,
    activeDeliveryId: a.activeDeliveryId ?? null,
    completedDeliveries: a.completedDeliveries,
    lastAssignedAt: a.lastAssignedAt ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
