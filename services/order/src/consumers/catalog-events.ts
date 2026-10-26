import {
  enqueueEvent,
  EventTypes,
  versionOf,
  parseEventData,
  routingKeyFor,
  type EventEnvelope,
  type Logger,
  type MessageBroker,
} from '@food/common';
import mongoose from 'mongoose';
import { CatalogProjectionModel } from '../catalog/projection.model.js';
import { SERVICE_NAME } from '../services/lifecycle.js';

export const CATALOG_EVENTS_QUEUE = 'order-service.catalog-events';

/**
 * Applies a restaurant snapshot if it is newer than the one held (version compare-and-set via upsert:
 * an older or equal version matches nothing, the upsert collides on _id, and the snapshot is ignored).
 * Duplicates and out-of-order deliveries are therefore harmless; no processed-event marker is needed.
 */
export async function applyCatalogEvent(event: EventEnvelope): Promise<'applied' | 'stale'> {
  const d = parseEventData(event, EventTypes.CatalogRestaurantUpdated);
  try {
    const res = await CatalogProjectionModel.updateOne(
      { _id: d.restaurantId, catalogVersion: { $lt: d.catalogVersion } },
      {
        $set: {
          catalogVersion: d.catalogVersion,
          name: d.name,
          status: d.status,
          isOpen: d.isOpen,
          isPureVeg: d.isPureVeg,
          adminIds: d.adminIds,
          items: d.items,
          sourceEventId: event.eventId,
          syncedAt: new Date(),
        },
      },
      { upsert: true },
    );
    return res.modifiedCount + res.upsertedCount > 0 ? 'applied' : 'stale';
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      // Exists with version ≥ incoming — except a brand-new projection receiving version 0 twice concurrently.
      return 'stale';
    }
    throw err;
  }
}

export async function subscribeCatalogEvents(broker: MessageBroker, logger: Logger, queue = CATALOG_EVENTS_QUEUE) {
  await broker.subscribe({
    queue,
    routingKeys: [routingKeyFor(EventTypes.CatalogRestaurantUpdated, versionOf(EventTypes.CatalogRestaurantUpdated))],
    // v1 (single ownerId) is retired: stop receiving it.
    unbindRoutingKeys: [routingKeyFor(EventTypes.CatalogRestaurantUpdated, 1)],
    maxRetries: 5,
    retryDelayMs: 2000,
    handler: async (event) => {
      const outcome = await applyCatalogEvent(event);
      logger.debug({ eventId: event.eventId, outcome }, 'Catalog event processed');
    },
  });
}

/** Asks the Catalog Service to re-broadcast snapshots (bootstrap / repair). Fire-and-forget through the outbox. */
export async function requestCatalogSync(reason: string): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() =>
      enqueueEvent(session, {
        source: SERVICE_NAME,
        eventType: EventTypes.CatalogSyncRequested,
        aggregateId: 'catalog',
        data: { requestedBy: SERVICE_NAME, reason, requestedAt: new Date().toISOString() },
      }).then(() => undefined),
    );
  } finally {
    await session.endSession();
  }
}
