import mongoose from 'mongoose';
import { EventTypes, type Logger } from '@food/common';
import { EXPIRABLE_PAYMENT_STATUSES } from '../models/order-status.js';
import { OrderModel } from '../models/order.model.js';
import { newEventId, recordTransition, SERVICE_NAME } from './lifecycle.js';

export interface ExpirationOptions {
  intervalMs?: number;
  batchSize?: number;
}

/**
 * Marks unpaid orders whose payment deadline has passed as `expired`.
 *
 * - Each order is expired by a compare-and-set (`status: pending_payment` AND `paymentStatus` still
 *   unpaid AND `expiresAt <= now`) inside a transaction that also writes `order.expired.v1` to the
 *   outbox — so an order is expired at most once and the event can never be lost or duplicated,
 *   even with several replicas or after a crash/restart.
 * - If a payment.succeeded event is applied first, the filter no longer matches and nothing happens;
 *   if expiry wins, the late payment is mirrored as `refund_pending` and the Payment Service refunds.
 * - Stateless: on (re)start it simply sweeps everything overdue, including orders that expired
 *   while it was down. Orders are never deleted.
 */
export class ExpirationWorker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly logger: Logger,
    /** Called after commits that wrote outbox events (wired to OutboxRelay.kick). */
    private readonly onEventsCommitted: () => void = () => undefined,
    opts: ExpirationOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.batchSize = opts.batchSize ?? 100;
  }

  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** One pass; returns how many orders this pass expired. Overlapping calls share one run. */
  sweep(now = new Date()): Promise<number> {
    this.running ??= this.run(now)
      .catch((err) => {
        this.logger.error({ err }, 'Expiration sweep failed');
        return 0;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async run(now: Date): Promise<number> {
    const due = await OrderModel.find(
      { status: 'pending_payment', paymentStatus: { $in: EXPIRABLE_PAYMENT_STATUSES }, expiresAt: { $lte: now } },
      { _id: 1 },
    )
      .sort({ expiresAt: 1 })
      .limit(this.batchSize)
      .lean();

    let expired = 0;
    for (const { _id } of due) {
      if (await this.expireOne(_id, now)) expired++;
    }
    if (expired > 0) {
      this.logger.info({ expired }, 'Expired unpaid orders');
      this.onEventsCommitted();
    }
    return expired;
  }

  private async expireOne(id: mongoose.Types.ObjectId, now: Date): Promise<boolean> {
    const session = await mongoose.startSession();
    try {
      let done = false;
      await session.withTransaction(async () => {
        done = false;
        const order = await OrderModel.findOne({
          _id: id,
          status: 'pending_payment',
          paymentStatus: { $in: EXPIRABLE_PAYMENT_STATUSES },
          expiresAt: { $lte: now },
        })
          .session(session)
          .lean();
        if (!order) return; // paid or cancelled meanwhile, or another replica got there first
        const expiredEventId = newEventId();
        // Compare-and-set on status + still-unpaid + still-overdue, together with both outbox events.
        done = await recordTransition(session, order, 'expired', {
          cause: { eventId: expiredEventId, service: SERVICE_NAME },
          by: 'expiration-worker',
          role: 'system',
          note: 'Payment deadline passed',
          filter: { paymentStatus: { $in: EXPIRABLE_PAYMENT_STATUSES }, expiresAt: { $lte: now } },
          set: { expiredAt: now },
          domainEvent: {
            eventType: EventTypes.OrderExpired,
            eventId: expiredEventId,
            data: {
              orderId: order._id.toString(),
              orderNumber: order.orderNumber,
              customerId: order.customerId,
              restaurantId: order.restaurantId,
              paymentStatus: order.paymentStatus,
              provisionalTotal: order.provisionalTotal,
              expiresAt: order.expiresAt!.toISOString(),
              expiredAt: now.toISOString(),
            },
          },
        });
      });
      return done;
    } finally {
      await session.endSession();
    }
  }
}
