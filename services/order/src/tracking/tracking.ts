import type { Response } from 'express';
import type { Logger } from '@food/common';
import { FULFILMENT_FLOW, STATUS_LABELS, type OrderStatus } from '../models/order-status.js';
import { OrderModel, toPublicOrder, type IOrder } from '../models/order.model.js';

/**
 * Progress-tracker view of an order, rendered straight from committed Order Service state.
 * Contains no customer contact data, payment secrets or OTP material (only the code's expiry time).
 */
const FINAL_PAYMENT_STATUSES: string[] = ['cancelled', 'refunded', 'refund_failed'];

export function trackingView(order: IOrder) {
  const history = toPublicOrder(order).statusHistory;
  const reachedAt = new Map(order.statusHistory.map((h) => [h.status, h.at]));
  const closed = order.status === 'cancelled' || order.status === 'expired';
  const at = (s: OrderStatus) => reachedAt.get(s) ?? null;
  return {
    orderId: order._id.toString(),
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: STATUS_LABELS[order.status] ?? order.status,
    paymentStatus: order.paymentStatus,
    /** Delivery Service status mirror; `preparing` is implied between confirmation and the first delivery event. */
    deliveryStatus: order.delivery?.status ?? (order.status === 'confirmed' ? 'preparing' : null),
    deliveryPartner: order.delivery?.agent ? { name: order.delivery.agent.name, phoneMasked: order.delivery.agent.phoneMasked ?? null } : null,
    deliveryCodeExpiresAt: order.status === 'location_reached' ? (order.delivery?.otpExpiresAt ?? null) : null,
    deliveryIssue: order.delivery?.status === 'assignment_failed' ? (order.delivery.failureReason ?? 'No delivery partner available') : null,
    terminal: closed || order.status === 'delivered',
    completed: order.status === 'delivered',
    /**
     * Nothing visible will change any more: delivered, or closed with a final payment outcome. A cancelled
     * or expired order can still move from refund_pending/pending to refunded/cancelled, so it is not settled yet.
     */
    settled: order.status === 'delivered' || (closed && FINAL_PAYMENT_STATUSES.includes(order.paymentStatus)),
    sequence: order.statusHistory.length,
    steps: (['pending_payment', ...FULFILMENT_FLOW] as OrderStatus[]).map((status) => ({
      status,
      label: STATUS_LABELS[status] ?? status,
      reached: reachedAt.has(status),
      at: at(status),
      current: order.status === status,
    })),
    timestamps: {
      placedAt: order.createdAt,
      confirmedAt: at('confirmed'),
      pickedUpAt: at('out_for_delivery'),
      deliveredAt: at('delivered'),
      cancelledAt: at('cancelled'),
      expiredAt: at('expired'),
      updatedAt: order.updatedAt,
    },
    history,
    expiresAt: order.status === 'pending_payment' ? (order.expiresAt ?? null) : null,
  };
}

type Subscriber = { res: Response; lastPayload?: string };

/**
 * Server-Sent Events fan-out for order tracking.
 *
 * Source of updates: ONE MongoDB change stream per Order Service instance (committed writes only), so
 * every instance sees every change no matter which instance (or consumer) made it — horizontal scaling
 * needs no sticky sessions or shared in-process emitter. Subscribers are held per instance.
 * Reconnection: each message carries `id: <history length>`; a reconnecting client (Last-Event-ID) always
 * receives a fresh snapshot first, so nothing committed in between can be missed.
 */
export class TrackingHub {
  private subscribers = new Map<string, Set<Subscriber>>();
  private stream?: ReturnType<typeof OrderModel.watch>;
  private heartbeat?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly logger: Logger,
    private readonly opts: { heartbeatMs?: number } = {},
  ) {}

  /** Registers an authorised subscriber and sends the current snapshot immediately. */
  subscribe(order: IOrder, res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: stream, don't buffer
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const id = order._id.toString();
    const sub: Subscriber = { res };
    const view = trackingView(order);
    this.send(sub, view);
    if (view.settled) {
      this.end(sub);
      return;
    }
    let set = this.subscribers.get(id);
    if (!set) this.subscribers.set(id, (set = new Set()));
    set.add(sub);
    res.on('close', () => {
      set!.delete(sub);
      if (!set!.size) this.subscribers.delete(id);
    });
    this.ensureStream();
  }

  subscriberCount() {
    let n = 0;
    for (const s of this.subscribers.values()) n += s.size;
    return n;
  }

  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.restartTimer);
    for (const set of this.subscribers.values()) for (const sub of set) sub.res.end();
    this.subscribers.clear();
    await this.stream?.close().catch(() => undefined);
  }

  private ensureStream() {
    if (this.stream || this.closed) return;
    this.heartbeat ??= setInterval(() => {
      for (const set of this.subscribers.values()) for (const sub of set) sub.res.write(': ping\n\n');
    }, this.opts.heartbeatMs ?? 15_000);
    this.heartbeat.unref();

    const stream = OrderModel.watch([{ $match: { operationType: { $in: ['update', 'replace'] } } }], { fullDocument: 'updateLookup' });
    this.stream = stream;
    stream.on('change', (change: { fullDocument?: IOrder }) => {
      const doc = change.fullDocument;
      if (!doc) return;
      const set = this.subscribers.get(doc._id.toString());
      if (!set) return;
      const view = trackingView(doc);
      for (const sub of set) {
        this.send(sub, view);
        if (view.settled) this.end(sub);
      }
    });
    stream.on('error', (err: Error) => {
      this.logger.warn({ err: err.message }, 'Tracking change stream failed; restarting');
      void stream.close().catch(() => undefined);
      this.stream = undefined;
      this.restartTimer = setTimeout(() => void this.resync(), 1000);
    });
  }

  /** After a stream restart, push a fresh snapshot to everyone (changes during the gap are not lost). */
  private async resync() {
    if (this.closed || !this.subscribers.size) return;
    this.ensureStream();
    for (const [id, set] of this.subscribers) {
      const order = await OrderModel.findById(id).lean().catch(() => null);
      if (order) for (const sub of set) this.send(sub, trackingView(order));
    }
  }

  private send(sub: Subscriber, view: ReturnType<typeof trackingView>) {
    const payload = JSON.stringify(view);
    if (payload === sub.lastPayload) return; // nothing visible changed
    sub.lastPayload = payload;
    sub.res.write(`id: ${view.sequence}\nevent: tracking\ndata: ${payload}\n\n`);
  }

  private end(sub: Subscriber) {
    sub.res.write('event: end\ndata: {}\n\n');
    sub.res.end();
  }
}
