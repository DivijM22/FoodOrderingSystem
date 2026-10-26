import { EventTypes, parseEventData, PermanentEventError, routingKeyFor, versionOf, type Logger, type MessageBroker } from '@food/common';
import type { DeliveryService } from '../services/delivery.service.js';

export const DELIVERY_AUTH_QUEUE = 'delivery-service.auth-events';

/**
 * auth.user.deactivated.v1 / auth.user.deleted.v1 for a delivery agent → block new assignments (see blockAgent).
 * Other roles are ignored. Idempotent, so duplicates are harmless. Delivery history is never touched.
 */
export async function subscribeAuthEvents(broker: MessageBroker, delivery: DeliveryService, logger: Logger, queue = DELIVERY_AUTH_QUEUE) {
  await broker.subscribe({
    queue,
    routingKeys: [EventTypes.AuthUserDeactivated, EventTypes.AuthUserDeleted].map((t) => routingKeyFor(t, versionOf(t))),
    maxRetries: 5,
    retryDelayMs: 3000,
    handler: async (event) => {
      let userId: string, role: string, held: string | null;
      if (event.eventType === EventTypes.AuthUserDeleted) {
        const d = parseEventData(event, EventTypes.AuthUserDeleted);
        ({ userId, role } = d);
        if (role !== 'delivery_agent') return;
        held = await delivery.blockAgent(userId, new Date(d.deletedAt), 'deleted');
      } else if (event.eventType === EventTypes.AuthUserDeactivated) {
        const d = parseEventData(event, EventTypes.AuthUserDeactivated);
        ({ userId, role } = d);
        if (role !== 'delivery_agent') return;
        held = await delivery.blockAgent(userId, new Date(d.deactivatedAt), 'disabled');
      } else {
        throw new PermanentEventError(`Unexpected event type ${event.eventType}`);
      }
      if (held) logger.warn({ eventId: event.eventId, userId, deliveryId: held }, 'Blocked agent still holds a delivery; it stays assigned to them');
      else logger.info({ eventId: event.eventId, eventType: event.eventType, userId }, 'Delivery agent blocked from new assignments');
    },
  });
}
