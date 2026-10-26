import { EVENT_VERSION, EventTypes, parseEventData, routingKeyFor, type Logger, type MessageBroker } from '@food/common';
import type { CatalogService } from '../services/catalog.service.js';

export const SYNC_QUEUE = 'catalog-service.sync-requests';

/**
 * catalog.sync_requested.v1 → re-broadcast every restaurant snapshot. Not request/response: the
 * "answer" is the ordinary catalog.restaurant.updated broadcast that every subscriber receives.
 * Requests arriving within `debounceMs` of a broadcast are coalesced.
 */
export async function subscribeSyncRequests(broker: MessageBroker, service: CatalogService, logger: Logger, debounceMs = 5000) {
  let lastBroadcast = 0;
  await broker.subscribe({
    queue: SYNC_QUEUE,
    routingKeys: [routingKeyFor(EventTypes.CatalogSyncRequested, EVENT_VERSION)],
    prefetch: 1,
    handler: async (event) => {
      const d = parseEventData(event, EventTypes.CatalogSyncRequested);
      if (Date.now() - lastBroadcast < debounceMs) return;
      const n = await service.broadcastSnapshots();
      lastBroadcast = Date.now();
      logger.info({ requestedBy: d.requestedBy, reason: d.reason, restaurants: n }, 'Catalog snapshots re-broadcast on request');
    },
  });
}
