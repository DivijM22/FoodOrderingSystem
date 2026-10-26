import mongoose, { Schema, type Model } from 'mongoose';
import type { EventEnvelope } from '../events/envelope.js';

export interface IOutboxEvent {
  _id: string; // = envelope.eventId
  eventType: string;
  aggregateId: string;
  envelope: EventEnvelope;
  /** Target exchange when not the service's default topic exchange (restricted commands). */
  exchange?: string;
  status: 'pending' | 'published';
  attempts: number;
  lastError?: string;
  lockedUntil?: Date;
  publishedAt?: Date;
  createdAt: Date;
}

const outboxSchema = new Schema<IOutboxEvent>(
  {
    _id: { type: String, required: true },
    eventType: { type: String, required: true },
    aggregateId: { type: String, required: true },
    envelope: { type: Schema.Types.Mixed, required: true },
    exchange: String,
    status: { type: String, enum: ['pending', 'published'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    lastError: String,
    lockedUntil: Date,
    publishedAt: Date,
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false, collection: 'outbox_events' },
);

outboxSchema.index({ status: 1, createdAt: 1 });
// Published events are kept for a week for debugging, then removed automatically.
outboxSchema.index({ publishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

// Default import: mongoose is CommonJS, and Node's ESM loader cannot see `models` as a named export.
export const OutboxModel =
  (mongoose.models.OutboxEvent as Model<IOutboxEvent> | undefined) ?? mongoose.model<IOutboxEvent>('OutboxEvent', outboxSchema);
