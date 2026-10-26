import { randomInt } from 'node:crypto';
import mongoose, { type ClientSession, type QueryFilter } from 'mongoose';
import {
  ConflictError,
  enqueueEvent,
  EventTypes,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  type AuthUser,
} from '@food/common';
import type { CatalogGateway } from '../catalog/catalog.gateway.js';
import { CANCELLABLE_BY } from '../models/order-status.js';
import { trackingView } from '../tracking/tracking.js';
import { OrderModel, toPublicOrder, type IOrder, type OrderDocument } from '../models/order.model.js';
import { newEventId, publishStatusChanged, recordTransition, SERVICE_NAME } from './lifecycle.js';
import type { CreateOrderInput, ListOrdersQuery } from '../schemas.js';
import { priceOrder, type PricingRules } from './pricing.js';

interface RequestContext {
  requestId?: string;
  token?: string;
}

export { SERVICE_NAME };

const ORDER_NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newOrderNumber(now = new Date()): string {
  const date = now.toISOString().slice(2, 10).replaceAll('-', '');
  const suffix = Array.from({ length: 6 }, () => ORDER_NUMBER_ALPHABET[randomInt(ORDER_NUMBER_ALPHABET.length)]).join('');
  return `ORD-${date}-${suffix}`;
}

async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

export class OrderService {
  constructor(
    private readonly catalog: CatalogGateway,
    private readonly pricing: PricingRules,
    /** Called after a transaction that wrote outbox events commits. */
    private readonly onEventsCommitted: () => void = () => undefined,
    /** Unpaid orders expire this long after creation. */
    private readonly paymentDeadlineSeconds = 900,
  ) {}

  // ---------------------------------------------------------------- create

  async createOrder(customer: AuthUser, input: CreateOrderInput, idempotencyKey?: string, ctx: RequestContext = {}) {
    if (idempotencyKey) {
      const existing = await OrderModel.findOne({ customerId: customer.id, idempotencyKey });
      if (existing) return { order: toPublicOrder(existing), replayed: true };
    }

    const menu = await this.catalog.getMenu(input.restaurantId);
    if (!menu) throw new UnprocessableError('Restaurant not found', 'RESTAURANT_NOT_FOUND');
    const priced = priceOrder(menu, input.items, this.pricing);

    const now = new Date();
    const createdEventId = newEventId();
    try {
      const order = await inTransaction(async (session) => {
        const [created] = await OrderModel.create(
          [
            {
              orderNumber: newOrderNumber(now),
              customerId: customer.id,
              customerEmail: customer.email,
              customerName: customer.name,
              restaurantId: menu.restaurant.id,
              restaurantName: menu.restaurant.name,
              ...priced,
              currency: 'INR',
              status: 'pending_payment',
              paymentStatus: 'pending',
              statusHistory: [
                {
                  status: 'pending_payment',
                  at: now,
                  sourceEventId: createdEventId,
                  sourceService: SERVICE_NAME,
                  by: customer.id,
                  role: customer.role,
                  ...(menu.restaurant.catalogVersion !== undefined ? { metadata: { catalogVersion: String(menu.restaurant.catalogVersion) } } : {}),
                },
              ],
              // Same clock reading for both, so expiresAt is exactly createdAt + deadline.
              createdAt: now,
              expiresAt: new Date(now.getTime() + this.paymentDeadlineSeconds * 1000),
              deliveryAddress: input.deliveryAddress,
              notes: input.notes,
              discountCode: input.discountCode,
              idempotencyKey,
            },
          ],
          { session },
        );
        const o = created!;
        await enqueueEvent(session, {
          source: SERVICE_NAME,
          eventId: createdEventId,
          eventType: EventTypes.OrderCreated,
          aggregateId: o._id.toString(),
          correlationId: ctx.requestId,
          data: {
            orderId: o._id.toString(),
            orderNumber: o.orderNumber,
            customerId: o.customerId,
            customerEmail: o.customerEmail,
            restaurantId: o.restaurantId,
            restaurantName: o.restaurantName,
            items: o.items.map(({ menuItemId, name, unitPrice, quantity, lineTotal }) => ({ menuItemId, name, unitPrice, quantity, lineTotal })),
            subtotal: o.subtotal,
            deliveryFee: o.deliveryFee,
            provisionalTotal: o.provisionalTotal,
            currency: 'INR',
            deliveryAddress: input.deliveryAddress,
            createdAt: o.createdAt.toISOString(),
            expiresAt: o.expiresAt!.toISOString(),
            ...(o.discountCode ? { discountCode: o.discountCode } : {}),
          },
        });
        const placed = o.toObject();
        await publishStatusChanged(session, placed, null, placed.statusHistory[0]!);
        return o;
      });
      this.onEventsCommitted();
      return { order: toPublicOrder(order), replayed: false };
    } catch (err) {
      // A concurrent request with the same Idempotency-Key won the race: return its order.
      if (idempotencyKey && isDuplicateKey(err)) {
        const existing = await OrderModel.findOne({ customerId: customer.id, idempotencyKey });
        if (existing) return { order: toPublicOrder(existing), replayed: true };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- read

  async listOrders(user: AuthUser, q: ListOrdersQuery, ctx: RequestContext = {}) {
    const filter: QueryFilter<IOrder> = {};
    if (q.status) filter.status = q.status;

    switch (user.role) {
      case 'customer':
        // Customers always see only their own history, whatever filters they pass.
        filter.customerId = user.id;
        if (q.restaurantId) filter.restaurantId = q.restaurantId;
        break;
      case 'restaurant_admin':
        if (!q.restaurantId) throw new UnprocessableError('restaurantId is required for restaurant administrators', 'RESTAURANT_ID_REQUIRED');
        await this.assertOwnsRestaurant(user, q.restaurantId, ctx);
        filter.restaurantId = q.restaurantId;
        break;
      case 'platform_admin':
        if (q.restaurantId) filter.restaurantId = q.restaurantId;
        if (q.customerId) filter.customerId = q.customerId;
        break;
      default:
        throw new ForbiddenError();
    }

    const [orders, total] = await Promise.all([
      OrderModel.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      OrderModel.countDocuments(filter),
    ]);
    return { orders: orders.map(toPublicOrder), total };
  }

  async getOrder(user: AuthUser, id: string, ctx: RequestContext = {}) {
    return toPublicOrder(await this.findAccessible(user, id, ctx));
  }

  // ---------------------------------------------------------------- cancel

  async cancelOrder(user: AuthUser, id: string, reason: string, ctx: RequestContext = {}) {
    const order = await this.findAccessible(user, id, ctx);
    const actor = user.role === 'customer' ? 'customer' : user.role === 'restaurant_admin' ? 'restaurant' : user.role === 'platform_admin' ? 'platform' : null;
    if (!actor) throw new ForbiddenError();

    const from = order.status;
    if (!CANCELLABLE_BY[actor].includes(from)) {
      throw new ConflictError(`An order that is ${from.replaceAll('_', ' ')} cannot be cancelled`, 'ORDER_NOT_CANCELLABLE');
    }

    // A paid order needs a refund; the Payment Service reacts to OrderCancelled.
    const paymentStatus = order.paymentStatus === 'paid' ? 'refund_pending' : order.paymentStatus;
    const now = new Date();

    const cancelledEventId = newEventId();
    const updated = await inTransaction(async (session) => {
      const ok = await recordTransition(session, order.toObject(), 'cancelled', {
        cause: { eventId: cancelledEventId, service: SERVICE_NAME },
        by: user.id,
        role: user.role,
        note: reason,
        set: { paymentStatus, cancellation: { reason, by: user.id, role: user.role, at: now } },
        domainEvent: {
          eventType: EventTypes.OrderCancelled,
          eventId: cancelledEventId,
          data: {
            orderId: order._id.toString(),
            orderNumber: order.orderNumber,
            customerId: order.customerId,
            restaurantId: order.restaurantId,
            reason,
            cancelledBy: actor,
            previousStatus: from,
            paymentStatus: order.paymentStatus,
            provisionalTotal: order.provisionalTotal,
            cancelledAt: now.toISOString(),
          },
        },
      });
      if (!ok) throw new ConflictError('Order was modified concurrently; please retry', 'CONCURRENT_UPDATE');
      return (await OrderModel.findById(order._id).session(session))!;
    });
    this.onEventsCommitted();
    return toPublicOrder(updated);
  }

  // ---------------------------------------------------------------- tracking

  /** Progress-tracker view (also streamed over SSE): steps, delivery status, partner, history. */
  async getTracking(user: AuthUser, id: string, ctx: RequestContext = {}) {
    return trackingView((await this.findAccessible(user, id, ctx)).toObject());
  }

  /** The order (plain object) if the user may track it; used by the SSE stream. */
  async getTrackable(user: AuthUser, id: string, ctx: RequestContext = {}) {
    return (await this.findAccessible(user, id, ctx)).toObject();
  }

  // ---------------------------------------------------------------- access control

  /**
   * Loads an order the user may see. Foreign orders return 404 (not 403) so their existence is not leaked.
   * - customer: own orders
   * - restaurant_admin: orders for restaurants listing them in adminIds (from the local catalog read model)
   * - delivery_agent: only orders whose delivery is assigned to them (from the delivery mirror)
   * - platform_admin: everything
   */
  private async findAccessible(user: AuthUser, id: string, ctx: RequestContext): Promise<OrderDocument> {
    const order = await OrderModel.findById(id);
    if (!order) throw new NotFoundError('Order not found');

    switch (user.role) {
      case 'platform_admin':
        return order;
      case 'customer':
        if (order.customerId === user.id) return order;
        break;
      case 'restaurant_admin': {
        const restaurant = await this.catalog.getRestaurant(order.restaurantId);
        if (restaurant?.adminIds.includes(user.id)) return order;
        break;
      }
      case 'delivery_agent':
        if (order.delivery?.agent?.id === user.id) return order;
        break;
    }
    throw new NotFoundError('Order not found');
  }

  private async assertOwnsRestaurant(user: AuthUser, restaurantId: string, ctx: RequestContext) {
    void ctx;
    const restaurant = await this.catalog.getRestaurant(restaurantId);
    if (!restaurant || !restaurant.adminIds.includes(user.id)) throw new ForbiddenError('You do not manage this restaurant');
  }
}
