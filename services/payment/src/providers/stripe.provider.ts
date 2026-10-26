import Stripe from 'stripe';
import {
  IntentStateError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type PaymentProvider,
  type ProviderEvent,
  type ProviderIntent,
  type ProviderRefund,
  type SimulatedOutcome,
} from './provider.js';
import { toProviderIntent, toProviderRefund, verifyAndNormalise } from './stripe-events.js';

/** Stripe's test-mode PaymentMethods. Only usable with test keys — Stripe rejects them in live mode. */
const TEST_PAYMENT_METHODS: Partial<Record<SimulatedOutcome, string>> = {
  succeed: 'pm_card_visa',
  fail: 'pm_card_chargeDeclined',
  succeed_refund_fails: 'pm_card_refundFail',
};

export function mapStripeError(err: unknown): Error {
  if (err instanceof Stripe.errors.StripeConnectionError || err instanceof Stripe.errors.StripeAPIError || err instanceof Stripe.errors.StripeRateLimitError) {
    return new ProviderUnavailableError(`Stripe unavailable: ${(err as Error).message}`);
  }
  // Another request with the same idempotency key is still in flight at Stripe: transient, retry.
  if (err instanceof Stripe.errors.StripeError && err.code === 'idempotency_key_in_use') {
    return new ProviderUnavailableError(`Stripe: concurrent request with the same idempotency key (${err.message})`);
  }
  if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'payment_intent_unexpected_state') {
    return new IntentStateError(err.message);
  }
  if (err instanceof Stripe.errors.StripeError) return new ProviderRejectedError(err.message, err.code);
  return err as Error;
}

/**
 * Runs a Stripe call with a hard deadline. The SDK's own timeout does not cover every failure mode
 * (observed: requests to an unreachable host never settling), and a hung call would stall the
 * reconciler or a customer's request. Timing out is safe: retries reuse the same idempotency key.
 */
async function call<T>(fn: () => Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderUnavailableError(`Stripe did not respond within ${deadlineMs} ms`)), deadlineMs);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } catch (err) {
    throw mapStripeError(err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real Stripe integration (official SDK). Config validation guarantees a *test* key, so no real
 * money can move. Every mutating request carries an idempotency key derived from our own ids,
 * so retries (ours or the SDK's automatic network retries) never create a second charge/refund.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;
  private readonly deadlineMs: number;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    opts: { apiUrl?: string; maxNetworkRetries?: number; timeoutMs?: number } = {},
  ) {
    if (!/^(sk|rk)_test_/.test(secretKey)) throw new Error('StripeProvider refuses non-test keys');
    const url = opts.apiUrl ? new URL(opts.apiUrl) : undefined;
    const retries = opts.maxNetworkRetries ?? 2;
    // Covers the SDK timeout for every attempt plus retry backoff.
    this.deadlineMs = (opts.timeoutMs ?? 10_000) * (retries + 1) + 2_000 * retries;
    this.stripe = new Stripe(secretKey, {
      maxNetworkRetries: opts.maxNetworkRetries ?? 2,
      timeout: opts.timeoutMs ?? 10_000,
      appInfo: { name: 'food-platform-payment-service' },
      ...(url ? { host: url.hostname, port: url.port, protocol: url.protocol.replace(':', '') as 'http' | 'https' } : {}),
    });
  }

  createPaymentIntent(
    params: { amount: number; currency: 'INR'; description: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<ProviderIntent> {
    return call(
      async () =>
      toProviderIntent(
        await this.stripe.paymentIntents.create(
          {
            amount: params.amount, // INR minor units (paise)
            currency: params.currency.toLowerCase(),
            description: params.description,
            metadata: params.metadata,
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          },
          { idempotencyKey },
        ),
      ),
      this.deadlineMs,
    );
  }

  retrievePaymentIntent(id: string): Promise<ProviderIntent> {
    return call(async () => toProviderIntent(await this.stripe.paymentIntents.retrieve(id)), this.deadlineMs);
  }

  cancelPaymentIntent(id: string, idempotencyKey: string): Promise<ProviderIntent> {
    return call(
      async () =>
      toProviderIntent(await this.stripe.paymentIntents.cancel(id, { cancellation_reason: 'requested_by_customer' }, { idempotencyKey })),
      this.deadlineMs,
    );
  }

  createRefund(params: { paymentIntentId: string; amount: number; metadata: Record<string, string> }, idempotencyKey: string): Promise<ProviderRefund> {
    return call(
      async () =>
      toProviderRefund(
        await this.stripe.refunds.create(
          { payment_intent: params.paymentIntentId, amount: params.amount, reason: 'requested_by_customer', metadata: params.metadata },
          { idempotencyKey },
        ),
      ),
      this.deadlineMs,
    );
  }

  retrieveRefund(id: string): Promise<ProviderRefund> {
    return call(async () => toProviderRefund(await this.stripe.refunds.retrieve(id)), this.deadlineMs);
  }

  constructWebhookEvent(rawBody: Buffer, signature: string | undefined): ProviderEvent {
    return verifyAndNormalise(rawBody, signature, this.webhookSecret);
  }

  async simulateCustomerPayment(intentId: string, outcome: SimulatedOutcome): Promise<void> {
    const paymentMethod = TEST_PAYMENT_METHODS[outcome];
    if (!paymentMethod) throw new ProviderRejectedError(`Outcome "${outcome}" cannot be simulated with Stripe`);
    await call(async () => {
      try {
        await this.stripe.paymentIntents.confirm(intentId, { payment_method: paymentMethod });
      } catch (err) {
        // A declined test card is the expected result for "fail"; the outcome still arrives via webhook.
        if (outcome === 'fail' && err instanceof Stripe.errors.StripeCardError) return;
        throw err;
      }
    }, this.deadlineMs);
  }
}
