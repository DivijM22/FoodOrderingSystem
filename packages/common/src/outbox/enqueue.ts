import type { ClientSession } from 'mongoose';
import { createEnvelope } from '../events/envelope.js';
import { eventDataSchemas, RESTRICTED_EXCHANGE, RESTRICTED_EVENT_TYPES, versionOf, type EventData, type EventType } from '../events/contracts.js';
import { OutboxModel } from './outbox.model.js';

/**
 * Records an event in the outbox inside the caller's transaction (transactional outbox pattern).
 * The event is validated against its contract here, so an invalid event aborts the whole business
 * transaction instead of failing later at publish time. Returns the new eventId.
 * Restricted event types are always routed to RESTRICTED_EXCHANGE (never the general topic exchange).
 * correlationId defaults to the aggregate id, so every event of one order's flow can be correlated.
 */
export async function enqueueEvent<T extends EventType>(
  session: ClientSession,
  params: { source: string; eventType: T; aggregateId: string; data: EventData<T>; correlationId?: string; eventId?: string },
): Promise<string> {
  const data = eventDataSchemas[params.eventType].parse(params.data);
  const envelope = createEnvelope({
    eventType: params.eventType,
    version: versionOf(params.eventType),
    source: params.source,
    data,
    correlationId: params.correlationId ?? params.aggregateId,
    aggregateId: params.aggregateId,
    eventId: params.eventId,
  });
  const exchange = RESTRICTED_EVENT_TYPES.includes(params.eventType) ? RESTRICTED_EXCHANGE : undefined;
  await OutboxModel.create(
    [{ _id: envelope.eventId, eventType: envelope.eventType, aggregateId: params.aggregateId, envelope, ...(exchange ? { exchange } : {}) }],
    { session },
  );
  return envelope.eventId;
}
