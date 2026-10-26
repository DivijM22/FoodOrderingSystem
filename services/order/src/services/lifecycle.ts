import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { CUSTOMER_ORDER_STATUSES, enqueueEvent, EventTypes, type EventData } from '@food/common';
import type { OrderStatus } from '../models/order-status.js';
import { OrderModel, type IOrder, type IStatusChange } from '../models/order.model.js';

export const SERVICE_NAME = 'order-service';

/** Lost a compare-and-set race; the caller (consumer/worker/API) retries with fresh state. */
export class ConcurrentUpdateError extends Error {}

type CustomerStatus = (typeof CUSTOMER_ORDER_STATUSES)[number];
const asCustomerStatus = (s: OrderStatus): CustomerStatus | null => ((CUSTOMER_ORDER_STATUSES as readonly string[]).includes(s) ? (s as CustomerStatus) : null);

export interface TransitionOptions {
  /** The event that caused this (consumed event), or the domain event this transition publishes (API actions). */
  cause: { eventId: string; service: string };
  by: string;
  role: string;
  note?: string;
  metadata?: Record<string, string>;
  /** Extra fields set atomically with the status (e.g. paymentStatus, cancellation). */
  set?: Record<string, unknown>;
  /** Extra arrays appended atomically (e.g. paymentHistory). */
  push?: Record<string, unknown>;
  /** Extra compare-and-set conditions (e.g. paymentStatus still unpaid). */
  filter?: Record<string, unknown>;
  /** Domain event published together with the customer-facing status change. */
  domainEvent?: { [K in keyof EventDataMap]: { eventType: K; data: EventDataMap[K]; eventId?: string } }[keyof EventDataMap];
}

type EventDataMap = {
  [EventTypes.OrderConfirmed]: EventData<typeof EventTypes.OrderConfirmed>;
  [EventTypes.OrderCancelled]: EventData<typeof EventTypes.OrderCancelled>;
  [EventTypes.OrderExpired]: EventData<typeof EventTypes.OrderExpired>;
};

/**
 * THE way an order changes status. In one compare-and-set it sets the status projection and appends
 * the history entry (so the last history element is always the current status), and in the same
 * transaction it writes the customer-facing `order.status_changed.v1` (and an optional domain event)
 * to the outbox. Nothing is published unless the transition commits.
 * Returns false when the compare-and-set did not match (someone else changed the order first).
 */
export async function recordTransition(session: ClientSession, order: IOrder, to: OrderStatus, opts: TransitionOptions): Promise<boolean> {
  const at = new Date();
  const entry: IStatusChange = {
    status: to,
    at,
    sourceEventId: opts.cause.eventId,
    sourceService: opts.cause.service,
    by: opts.by,
    role: opts.role,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.metadata && Object.keys(opts.metadata).length ? { metadata: opts.metadata } : {}),
  };
  const res = await OrderModel.updateOne(
    { _id: order._id, status: order.status, ...opts.filter },
    { $set: { status: to, ...opts.set }, $push: { statusHistory: entry, ...opts.push } },
    { session },
  );
  if (res.modifiedCount !== 1) return false;

  const after: IOrder = { ...order, ...(opts.set as Partial<IOrder>), status: to, statusHistory: [...order.statusHistory, entry] };
  if (opts.domainEvent) {
    await enqueueEvent(session, {
      source: SERVICE_NAME,
      eventType: opts.domainEvent.eventType,
      aggregateId: order._id.toString(),
      data: opts.domainEvent.data as never,
      eventId: opts.domainEvent.eventId,
    });
  }
  await publishStatusChanged(session, after, order.status, entry);
  return true;
}

/** Customer-facing projection of an accepted transition (consumed by the Notification Service). */
export async function publishStatusChanged(session: ClientSession, order: IOrder, previous: OrderStatus | null, entry: IStatusChange) {
  const status = asCustomerStatus(entry.status);
  if (!status) return; // legacy statuses are never published
  await enqueueEvent(session, {
    source: SERVICE_NAME,
    eventType: EventTypes.OrderStatusChanged,
    aggregateId: order._id.toString(),
    data: {
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      customerEmail: order.customerEmail,
      customerName: order.customerName,
      status,
      previousStatus: previous ? asCustomerStatus(previous) : null,
      sequence: order.statusHistory.length,
      changedAt: entry.at.toISOString(),
      ...(entry.note ? { reason: entry.note } : {}),
      cause: { eventId: entry.sourceEventId ?? 'unknown', service: entry.sourceService ?? SERVICE_NAME },
      summary: {
        restaurantName: order.restaurantName,
        items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, lineTotal: i.lineTotal })),
        currency: 'INR',
        total: order.billing?.finalAmount ?? order.provisionalTotal,
        ...(order.amountPaid !== undefined ? { amountPaid: order.amountPaid } : {}),
        deliveryCity: order.deliveryAddress.city,
      },
      metadata: entry.metadata ?? {},
    },
  });
}

export const newEventId = () => randomUUID();
