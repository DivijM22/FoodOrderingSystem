import amqp, { type AmqpConnectionManager, type ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import { envelopeSchema, routingKeyFor, type EventEnvelope } from '../events/envelope.js';
import { RESTRICTED_EVENT_TYPES } from '../events/contracts.js';

export interface BrokerOptions {
  url: string;
  /** Topic exchange shared by all services. */
  exchange: string;
  logger: Logger;
  /** Confirmed publish fails after this long instead of buffering forever when the broker is down. */
  publishTimeoutMs?: number;
  /**
   * Pre-declared exchanges this service may publish to besides `exchange` (e.g. food.restricted).
   * They are only checked (passive declare), never created, so the service needs no configure rights on them.
   */
  publishExchanges?: string[];
}

export interface SubscribeOptions {
  /** Durable queue owned by the consuming service, e.g. `payment-service.order-events`. */
  queue: string;
  /** Routing keys to bind, e.g. ['order.created.v1']. */
  routingKeys: string[];
  handler: (event: EventEnvelope) => Promise<void>;
  maxRetries?: number;
  retryDelayMs?: number;
  prefetch?: number;
  /** Routing keys of retired contract versions to unbind from this queue (e.g. a superseded `.v1`). */
  unbindRoutingKeys?: string[];
  /**
   * Bind to this pre-declared exchange instead of the default topic exchange (checked passively,
   * never created), e.g. the restricted command exchange.
   */
  exchange?: string;
}

const RETRY_HEADER = 'x-retry-count';

/**
 * Thrown by a handler when retrying can never succeed (e.g. the payload violates its contract).
 * The message goes straight to the dead-letter queue instead of being retried.
 */
export class PermanentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEventError';
  }
}

/**
 * Thin wrapper over amqp-connection-manager:
 * - automatic reconnection with backoff, topology re-declared on every reconnect
 * - publisher confirms (publish resolves only once the broker has persisted the message)
 * - consumer helper with manual acks, bounded retries via a TTL retry queue, and a dead-letter queue
 */
export class MessageBroker {
  private connection?: AmqpConnectionManager;
  private publisher?: ChannelWrapper;
  private consumers: ChannelWrapper[] = [];

  constructor(private readonly opts: BrokerOptions) {}

  async connect(): Promise<void> {
    const { url, exchange, logger } = this.opts;
    this.connection = amqp.connect([url], { heartbeatIntervalInSeconds: 15, reconnectTimeInSeconds: 3 });
    this.connection.on('connect', () => logger.info('Connected to RabbitMQ'));
    this.connection.on('disconnect', ({ err }) => logger.warn({ err: err?.message }, 'Disconnected from RabbitMQ'));
    this.connection.on('connectFailed', ({ err }) => logger.warn({ err: err?.message }, 'RabbitMQ connection attempt failed'));

    this.publisher = this.connection.createChannel({
      json: true,
      confirm: true,
      publishTimeout: this.opts.publishTimeoutMs ?? 5000,
      setup: async (channel: ConfirmChannel) => {
        await channel.assertExchange(exchange, 'topic', { durable: true });
        for (const x of this.opts.publishExchanges ?? []) await channel.checkExchange(x);
      },
    });
  }

  isConnected(): boolean {
    return this.connection?.isConnected() ?? false;
  }

  /** Wait for the first successful connection (used at startup and in tests). */
  async waitForConnect(): Promise<void> {
    await this.publisher?.waitForConnect();
  }

  async publish(event: EventEnvelope, opts: { exchange?: string } = {}): Promise<void> {
    if (!this.publisher) throw new Error('Broker not connected');
    if (!this.isConnected()) throw new Error('RabbitMQ is not connected');
    const target = opts.exchange ?? this.opts.exchange;
    // Defence in depth: sensitive commands can never be broadcast on the general topic exchange.
    if (RESTRICTED_EVENT_TYPES.includes(event.eventType) && target === this.opts.exchange) {
      throw new Error(`${event.eventType} may only be published to a restricted exchange`);
    }
    if (target !== this.opts.exchange && !(this.opts.publishExchanges ?? []).includes(target)) {
      throw new Error(`Exchange ${target} is not configured for publishing`);
    }
    await this.publisher.publish(target, routingKeyFor(event.eventType, event.version), event, {
      persistent: true,
      messageId: event.eventId,
      type: event.eventType,
      contentType: 'application/json',
      timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
      headers: { version: event.version, source: event.source },
    });
  }

  async subscribe(options: SubscribeOptions): Promise<void> {
    if (!this.connection) throw new Error('Broker not connected');
    const { queue, routingKeys, handler, maxRetries = 3, retryDelayMs = 5000, prefetch = 10 } = options;
    const { logger } = this.opts;
    const exchange = options.exchange ?? this.opts.exchange;
    const retryQueue = `${queue}.retry`;
    const deadLetterQueue = `${queue}.dlq`;
    // Retries and dead-letters go through an exchange owned by this consumer, never the default exchange:
    // a broker user with write access to amq.default could inject messages into ANY queue, including
    // the restricted OTP queue. (RabbitMQ also checks that permission for a queue's dead-letter exchange.)
    const parkingExchange = `${queue}.parking`;

    const channel = this.connection.createChannel({
      json: false,
      setup: async (ch: ConfirmChannel) => {
        if (options.exchange) await ch.checkExchange(exchange);
        else await ch.assertExchange(exchange, 'topic', { durable: true });
        await ch.assertExchange(parkingExchange, 'direct', { durable: true });
        await ch.assertQueue(deadLetterQueue, { durable: true });
        // Messages wait here for retryDelayMs, then dead-letter back into the main queue (via the parking exchange).
        await ch.assertQueue(retryQueue, {
          durable: true,
          arguments: {
            'x-message-ttl': retryDelayMs,
            'x-dead-letter-exchange': parkingExchange,
            'x-dead-letter-routing-key': 'requeue',
          },
        });
        // Rejected (malformed) messages dead-letter to the DLQ, also via the parking exchange.
        await ch.assertQueue(queue, {
          durable: true,
          arguments: { 'x-dead-letter-exchange': parkingExchange, 'x-dead-letter-routing-key': 'dlq' },
        });
        await ch.bindQueue(retryQueue, parkingExchange, 'retry');
        await ch.bindQueue(deadLetterQueue, parkingExchange, 'dlq');
        await ch.bindQueue(queue, parkingExchange, 'requeue');
        for (const key of routingKeys) await ch.bindQueue(queue, exchange, key);
        for (const key of options.unbindRoutingKeys ?? []) await ch.unbindQueue(queue, exchange, key);
        await ch.prefetch(prefetch);
      },
    });
    this.consumers.push(channel);
    // Resolve only once the queue is declared and bound, so events published afterwards are routed to it.
    await channel.waitForConnect();

    await channel.consume(queue, async (msg: ConsumeMessage) => {
      let event: EventEnvelope;
      try {
        event = envelopeSchema.parse(JSON.parse(msg.content.toString())) as EventEnvelope;
      } catch (err) {
        logger.error({ err, queue }, 'Malformed message; dead-lettering');
        channel.nack(msg, false, false);
        return;
      }

      try {
        await handler(event);
        channel.ack(msg);
      } catch (err) {
        const permanent = err instanceof PermanentEventError;
        const attempt = Number(msg.properties.headers?.[RETRY_HEADER] ?? 0) + 1;
        const toDlq = permanent || attempt > maxRetries;
        const target = toDlq ? deadLetterQueue : retryQueue;
        logger[permanent ? 'error' : 'warn'](
          { err, eventId: event.eventId, eventType: event.eventType, attempt, target, permanent },
          permanent ? 'Event rejected permanently; dead-lettering' : 'Event handler failed; scheduling retry',
        );
        try {
          await channel.publish(parkingExchange, toDlq ? 'dlq' : 'retry', msg.content, {
            persistent: true,
            messageId: msg.properties.messageId,
            type: msg.properties.type,
            contentType: msg.properties.contentType,
            headers: {
              ...msg.properties.headers,
              [RETRY_HEADER]: attempt,
              'x-last-error': String((err as Error)?.message ?? err).slice(0, 500),
            },
          });
          channel.ack(msg);
        } catch (sendErr) {
          // Could not park the message; requeue so it is not lost.
          logger.error({ err: sendErr }, 'Failed to schedule retry; requeueing');
          channel.nack(msg, false, true);
        }
      }
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.consumers.map((c) => c.close()));
    await this.publisher?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
