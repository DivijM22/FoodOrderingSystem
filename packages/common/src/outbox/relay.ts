import type { Logger } from 'pino';
import type { EventEnvelope } from '../events/envelope.js';
import { OutboxModel } from './outbox.model.js';

export interface EventPublisher {
  publish(event: EventEnvelope, opts?: { exchange?: string }): Promise<void>;
  isConnected(): boolean;
}

export interface RelayOptions {
  pollIntervalMs?: number;
  /** How long a claimed event stays locked to this instance (protects against multi-replica double publish). */
  lockMs?: number;
  maxBackoffMs?: number;
}

/**
 * Transactional-outbox relay: publishes pending outbox events to RabbitMQ, oldest first.
 *
 * Guarantees at-least-once delivery: an event is marked published only after the broker
 * confirms it. If publishing fails (e.g. broker down) the relay backs off and retries;
 * nothing is lost because the event is still in MongoDB. Consumers deduplicate by eventId.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  private failures = 0;
  private resumeAt = 0;
  private readonly pollIntervalMs: number;
  private readonly lockMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    opts: RelayOptions = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.lockMs = opts.lockMs ?? 30_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  start(): void {
    this.timer = setInterval(() => void this.drain(), this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.draining;
  }

  /** Trigger an immediate drain (called right after a transaction commits) without waiting for it. */
  kick(): void {
    void this.drain();
  }

  /** Publishes everything currently pending. Safe to call concurrently; overlapping calls share one run. */
  drain(): Promise<void> {
    this.draining ??= this.run().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  async pendingCount(): Promise<number> {
    return OutboxModel.countDocuments({ status: 'pending' });
  }

  private async run(): Promise<void> {
    if (Date.now() < this.resumeAt || !this.publisher.isConnected()) return;

    for (;;) {
      const now = new Date();
      const event = await OutboxModel.findOneAndUpdate(
        { status: 'pending', $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }] },
        { $set: { lockedUntil: new Date(now.getTime() + this.lockMs) }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      ).lean();
      if (!event) return;

      try {
        await this.publisher.publish(event.envelope, event.exchange ? { exchange: event.exchange } : undefined);
        await OutboxModel.updateOne(
          { _id: event._id },
          { $set: { status: 'published', publishedAt: new Date() }, $unset: { lockedUntil: 1, lastError: 1 } },
        );
        this.failures = 0;
        this.logger.info({ eventId: event._id, eventType: event.eventType, aggregateId: event.aggregateId }, 'Event published');
      } catch (err) {
        this.failures++;
        const backoff = Math.min(this.pollIntervalMs * 2 ** this.failures, this.maxBackoffMs);
        this.resumeAt = Date.now() + backoff;
        await OutboxModel.updateOne(
          { _id: event._id },
          { $set: { lastError: (err as Error).message }, $unset: { lockedUntil: 1 } },
        );
        this.logger.warn({ eventId: event._id, attempts: event.attempts, backoffMs: backoff, err: (err as Error).message }, 'Event publish failed; will retry');
        // Stop here to preserve ordering: later events wait until this one succeeds.
        return;
      }
    }
  }
}
