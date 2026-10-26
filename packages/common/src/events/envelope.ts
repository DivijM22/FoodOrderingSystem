import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Every event on the bus is wrapped in this envelope.
 * - eventId is globally unique and is the idempotency key for consumers.
 * - eventType + version select the contract; the RabbitMQ routing key is `${eventType}.v${version}`.
 */
export const envelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string(),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  source: z.string(),
  correlationId: z.string().optional(),
  /** Entity the event is about (usually the order id). Optional for backward compatibility. */
  aggregateId: z.string().optional(),
  data: z.unknown(),
});

export interface EventEnvelope<TType extends string = string, TData = unknown> {
  eventId: string;
  eventType: TType;
  version: number;
  occurredAt: string;
  source: string;
  correlationId?: string;
  aggregateId?: string;
  data: TData;
}

export function routingKeyFor(eventType: string, version: number): string {
  return `${eventType}.v${version}`;
}

export function createEnvelope<TType extends string, TData>(params: {
  eventType: TType;
  version: number;
  source: string;
  data: TData;
  correlationId?: string;
  aggregateId?: string;
  eventId?: string;
  occurredAt?: Date;
}): EventEnvelope<TType, TData> {
  return {
    eventId: params.eventId ?? randomUUID(),
    eventType: params.eventType,
    version: params.version,
    occurredAt: (params.occurredAt ?? new Date()).toISOString(),
    source: params.source,
    ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    ...(params.aggregateId ? { aggregateId: params.aggregateId } : {}),
    data: params.data,
  };
}
