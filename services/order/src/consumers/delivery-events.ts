import {
  EVENT_VERSION,
  EventTypes,
  parseEventData,
  PermanentEventError,
  processOnce,
  routingKeyFor,
  type EventEnvelope,
  type Logger,
  type MessageBroker,
} from '@food/common';
import { FULFILMENT_FLOW, type OrderStatus } from '../models/order-status.js';
import { OrderModel } from '../models/order.model.js';
import { ConcurrentUpdateError, recordTransition } from '../services/lifecycle.js';

export const DELIVERY_EVENTS_QUEUE = 'order-service.delivery-events';
const CONSUMER = 'order-service.delivery-events';

/** Delivery facts (published by the Delivery Service) → the order status they move to, and the mirrored delivery status. */
const STEPS = {
  [EventTypes.DeliveryReadyForPickup]: { to: 'assigning_delivery_partner', delivery: 'awaiting_partner' },
  [EventTypes.DeliveryPartnerAssigned]: { to: 'partner_assigned', delivery: 'partner_assigned' },
  [EventTypes.DeliveryPickedUp]: { to: 'out_for_delivery', delivery: 'picked_up' },
  [EventTypes.DeliveryLocationReached]: { to: 'location_reached', delivery: 'arrived' },
  [EventTypes.DeliveryCompleted]: { to: 'delivered', delivery: 'delivered' },
} as const satisfies Record<string, { to: OrderStatus; delivery: string }>;
type DeliveryEventType = keyof typeof STEPS;

/** Delivery facts that are not order transitions: only the delivery mirror changes (no customer email). */
const MIRROR_ONLY = [EventTypes.DeliveryCancelled, EventTypes.DeliveryAssignmentFailed] as const;

/** Arrived before its predecessor step was applied (out of order) → retried by the broker. */
export class StepNotYetApplicableError extends Error {}

const rank = (s: OrderStatus) => FULFILMENT_FLOW.indexOf(s);

/**
 * Applies a delivery fact to the order. The Order Service decides legality:
 * - exactly the next step  → transition + order.status_changed
 * - an earlier/equal step  → ignored (duplicate or stale)
 * - a step too far ahead   → retried later (its predecessor is still on its way)
 * - cancelled/expired order→ ignored (no email, no history entry)
 */
export async function applyDeliveryEvent(event: EventEnvelope): Promise<'applied' | 'ignored' | 'duplicate'> {
  if ((MIRROR_ONLY as readonly string[]).includes(event.eventType)) return applyMirrorOnly(event);
  if (!(event.eventType in STEPS)) throw new PermanentEventError(`Unexpected event type ${event.eventType}`);
  const type = event.eventType as DeliveryEventType;
  const data = parseEventData(event, type) as {
    orderId: string;
    deliveryId: string;
    agentId?: string;
    agentName?: string;
    agentPhoneMasked?: string;
    otpExpiresAt?: string;
    otpVerified?: boolean;
  };
  // Defence in depth: completion is only meaningful after the Delivery Service verified the OTP.
  if (type === EventTypes.DeliveryCompleted && data.otpVerified !== true) throw new PermanentEventError('delivery.completed without OTP verification');
  const target: OrderStatus = STEPS[type].to;

  for (let attempt = 1; ; attempt++) {
    try {
      let outcome: 'applied' | 'ignored' = 'ignored';
      const fresh = await processOnce(CONSUMER, event.eventId, async (session) => {
        const order = await OrderModel.findById(data.orderId).session(session).lean();
        if (!order) throw new PermanentEventError(`Order ${data.orderId} not found for ${type}`);
        if (order.status === 'cancelled' || order.status === 'expired') return;
        // One delivery per order: facts about any other delivery id are forged or misrouted.
        if (order.delivery?.deliveryId && order.delivery.deliveryId !== data.deliveryId) {
          throw new PermanentEventError(`${type} for delivery ${data.deliveryId} conflicts with delivery ${order.delivery.deliveryId}`);
        }
        const current = rank(order.status);
        const wanted = rank(target);
        if (current >= wanted) return; // duplicate-by-meaning or stale
        if (current !== wanted - 1) throw new StepNotYetApplicableError(`${type} arrived while order is ${order.status}`);
        // Later steps carry only agentId; keep the display name from the assignment for customer messages.
        const agentName = data.agentName ?? order.statusHistory.findLast((h) => h.metadata?.agentName)?.metadata?.agentName;
        const agentPhoneMasked = data.agentPhoneMasked ?? order.delivery?.agent?.phoneMasked;
        const now = new Date();
        const ok = await recordTransition(session, order, target, {
          cause: { eventId: event.eventId, service: event.source },
          by: 'delivery-service',
          role: 'system',
          metadata: {
            deliveryId: data.deliveryId,
            ...(data.agentId ? { agentId: data.agentId } : {}),
            ...(agentName ? { agentName } : {}),
            ...(agentPhoneMasked ? { agentPhoneMasked } : {}),
          },
          // The delivery mirror changes in the same compare-and-set as the status and history.
          set: {
            delivery: {
              deliveryId: data.deliveryId,
              status: STEPS[type].delivery,
              ...(data.agentId && agentName ? { agent: { id: data.agentId, name: agentName, ...(agentPhoneMasked ? { phoneMasked: agentPhoneMasked } : {}) } } : {}),
              ...(data.otpExpiresAt ? { otpExpiresAt: new Date(data.otpExpiresAt) } : {}),
              updatedAt: now,
            },
          },
        });
        if (!ok) throw new ConcurrentUpdateError(`Order ${data.orderId} changed concurrently`);
        outcome = 'applied';
      });
      return fresh ? outcome : 'duplicate';
    } catch (err) {
      if (!(err instanceof ConcurrentUpdateError) || attempt >= 3) throw err;
    }
  }
}

/** delivery.cancelled / delivery.assignment_failed: update the mirror only; never a status transition or refund. */
async function applyMirrorOnly(event: EventEnvelope): Promise<'applied' | 'ignored' | 'duplicate'> {
  const data =
    event.eventType === EventTypes.DeliveryCancelled
      ? { ...parseEventData(event, EventTypes.DeliveryCancelled), status: 'cancelled' as const, failureReason: undefined }
      : { ...parseEventData(event, EventTypes.DeliveryAssignmentFailed), status: 'assignment_failed' as const, failureReason: parseEventData(event, EventTypes.DeliveryAssignmentFailed).reason };
  let outcome: 'applied' | 'ignored' = 'ignored';
  const fresh = await processOnce(CONSUMER, event.eventId, async (session) => {
    const order = await OrderModel.findById(data.orderId).session(session).lean();
    if (!order) throw new PermanentEventError(`Order ${data.orderId} not found for ${event.eventType}`);
    if (order.status === 'delivered') return;
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          'delivery.deliveryId': data.deliveryId,
          'delivery.status': data.status,
          'delivery.updatedAt': new Date(),
          ...(data.failureReason ? { 'delivery.failureReason': data.failureReason } : {}),
        },
      },
      { session },
    );
    outcome = 'applied';
  });
  return fresh ? outcome : 'duplicate';
}

export async function subscribeDeliveryEvents(broker: MessageBroker, logger: Logger, onCommitted: () => void = () => undefined, queue = DELIVERY_EVENTS_QUEUE) {
  await broker.subscribe({
    queue,
    routingKeys: [...Object.keys(STEPS), ...MIRROR_ONLY].map((t) => routingKeyFor(t, EVENT_VERSION)),
    maxRetries: 8,
    retryDelayMs: 3000,
    handler: async (event) => {
      const outcome = await applyDeliveryEvent(event);
      if (outcome === 'applied') onCommitted();
      logger.info({ eventId: event.eventId, eventType: event.eventType, outcome }, 'Delivery event processed');
    },
  });
}
