import mongoose, { Schema, type ClientSession } from 'mongoose';

interface ProcessedEventDoc {
  _id: string; // `${consumer}:${eventId}`
  consumer: string;
  eventId: string;
  processedAt: Date;
}

const processedEventSchema = new Schema<ProcessedEventDoc>(
  {
    _id: { type: String, required: true },
    consumer: { type: String, required: true },
    eventId: { type: String, required: true },
    processedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false, collection: 'processed_events' },
);

function model() {
  return (
    (mongoose.models.ProcessedEvent as mongoose.Model<ProcessedEventDoc> | undefined) ??
    mongoose.model<ProcessedEventDoc>('ProcessedEvent', processedEventSchema)
  );
}

/**
 * Runs `fn` at most once per (consumer, eventId). The marker insert and the handler's
 * writes share one transaction, so a crash can never leave "marked but not applied".
 * Returns false when the event was already processed (duplicate delivery).
 */
export async function processOnce(
  consumer: string,
  eventId: string,
  fn: (session: ClientSession) => Promise<void>,
): Promise<boolean> {
  const ProcessedEvent = model();
  const session = await mongoose.startSession();
  try {
    let applied = false;
    await session.withTransaction(async () => {
      applied = false;
      const existing = await ProcessedEvent.findById(`${consumer}:${eventId}`).session(session);
      if (existing) return;
      await ProcessedEvent.create([{ _id: `${consumer}:${eventId}`, consumer, eventId }], { session });
      await fn(session);
      applied = true;
    });
    return applied;
  } finally {
    await session.endSession();
  }
}
