import { Schema, model } from 'mongoose';

/**
 * Event-fed projection (from the Delivery Service's delivery.partner_assigned / completed / cancelled events) of the
 * deliveries each agent holds. Auth uses it only to refuse deleting an agent who still has an active delivery.
 * A closed delivery never reopens, so `active: false` is terminal: a delayed or duplicate assignment event cannot
 * resurrect it. Eventually consistent with the Delivery Service.
 */
export interface IAgentDelivery {
  _id: string; // delivery id
  agentId: string;
  active: boolean;
  updatedAt: Date;
}

const agentDeliverySchema = new Schema<IAgentDelivery>(
  {
    _id: { type: String, required: true },
    agentId: { type: String, required: true },
    active: { type: Boolean, required: true },
    updatedAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'agent_deliveries' },
);
agentDeliverySchema.index({ agentId: 1, active: 1 });

export const AgentDeliveryModel = model<IAgentDelivery>('AgentDelivery', agentDeliverySchema);

/**
 * One document all platform-admin deactivations write to inside their transaction. Two concurrent deactivations
 * therefore conflict (MongoDB write conflict → the transaction retries) instead of each counting the other admin as
 * still active and together leaving none.
 */
const lockSchema = new Schema<{ _id: string; version: number }>(
  { _id: { type: String, required: true }, version: { type: Number, default: 0 } },
  { versionKey: false, collection: 'locks' },
);
export const LockModel = model('Lock', lockSchema);
