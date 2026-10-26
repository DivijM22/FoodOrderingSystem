import { EventTypes, parseEventData, routingKeyFor, versionOf, type Logger, type MessageBroker } from '@food/common';
import type { CatalogService } from '../services/catalog.service.js';

export const AUTH_EVENTS_QUEUE = 'catalog-service.auth-events';

/**
 * auth.user.deactivated.v1 → remove the user from every restaurant's adminIds (assignments made before the
 * deactivation only), publishing updated restaurant snapshots. Idempotent: a duplicate finds nothing left to remove,
 * and a delayed event never removes an assignment made after a later reactivation.
 * auth.user.deleted.v1 → tombstone the id and remove ALL its assignments (ids are never reused). Also idempotent.
 */
export async function subscribeAuthEvents(broker: MessageBroker, service: CatalogService, logger: Logger, queue = AUTH_EVENTS_QUEUE) {
  await broker.subscribe({
    queue,
    routingKeys: [EventTypes.AuthUserDeactivated, EventTypes.AuthUserDeleted].map((t) => routingKeyFor(t, versionOf(t))),
    maxRetries: 5,
    retryDelayMs: 3000,
    handler: async (event) => {
      if (event.eventType === EventTypes.AuthUserDeleted) {
        const d = parseEventData(event, EventTypes.AuthUserDeleted);
        const removed = await service.removeDeletedAdmin(d.userId, d.role, new Date(d.deletedAt));
        logger.info({ eventId: event.eventId, userId: d.userId, role: d.role, restaurantsUpdated: removed }, 'Deleted user removed from restaurant administrators');
        return;
      }
      const d = parseEventData(event, EventTypes.AuthUserDeactivated);
      const removed = await service.removeDeactivatedAdmin(d.userId, new Date(d.deactivatedAt));
      logger.info({ eventId: event.eventId, userId: d.userId, role: d.role, restaurantsUpdated: removed }, 'Deactivated user removed from restaurant administrators');
    },
  });
}
