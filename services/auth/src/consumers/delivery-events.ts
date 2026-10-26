import { EventTypes, parseEventData, PermanentEventError, routingKeyFor, versionOf, type Logger, type MessageBroker } from '@food/common';
import type { AuthService } from '../services/auth.service.js';

export const AUTH_DELIVERY_QUEUE = 'auth-service.delivery-events';
const SUBSCRIPTIONS = [EventTypes.DeliveryPartnerAssigned, EventTypes.DeliveryCompleted, EventTypes.DeliveryCancelled] as const;

/**
 * Keeps the agent → active delivery projection used to refuse deleting an agent mid-delivery. Every write is an
 * idempotent upsert keyed by delivery id and "closed" is terminal, so duplicates and reordering are harmless.
 */
export async function subscribeDeliveryEvents(broker: MessageBroker, service: AuthService, logger: Logger, queue = AUTH_DELIVERY_QUEUE) {
  await broker.subscribe({
    queue,
    routingKeys: SUBSCRIPTIONS.map((t) => routingKeyFor(t, versionOf(t))),
    maxRetries: 5,
    retryDelayMs: 3000,
    handler: async (event) => {
      switch (event.eventType) {
        case EventTypes.DeliveryPartnerAssigned: {
          const d = parseEventData(event, EventTypes.DeliveryPartnerAssigned);
          await service.recordAgentDelivery(d.deliveryId, d.agentId);
          break;
        }
        case EventTypes.DeliveryCompleted: {
          const d = parseEventData(event, EventTypes.DeliveryCompleted);
          await service.closeAgentDelivery(d.deliveryId, d.agentId);
          break;
        }
        case EventTypes.DeliveryCancelled: {
          const d = parseEventData(event, EventTypes.DeliveryCancelled);
          if (d.agentId) await service.closeAgentDelivery(d.deliveryId, d.agentId); // never assigned: nothing to track
          break;
        }
        default:
          throw new PermanentEventError(`Unexpected event type ${event.eventType}`);
      }
      logger.debug({ eventId: event.eventId, eventType: event.eventType }, 'Agent delivery projection updated');
    },
  });
}
