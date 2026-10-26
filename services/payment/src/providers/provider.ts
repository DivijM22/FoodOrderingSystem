/**
 * Provider abstraction. The payment workflow depends only on this interface;
 * `StripeProvider` talks to Stripe (test mode only), `MockPaymentProvider` simulates it locally.
 */

/** Stripe PaymentIntent statuses (subset we act on). */
export type IntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'succeeded'
  | 'canceled';

export interface ProviderIntent {
  id: string;
  status: IntentStatus;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  /** Only returned to the paying customer; never persisted. */
  clientSecret?: string;
  lastError?: { code?: string; message: string };
}

export type ProviderRefundStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';

export interface ProviderRefund {
  id: string;
  status: ProviderRefundStatus;
  amount: number;
  paymentIntentId: string;
  metadata: Record<string, string>;
  failureReason?: string;
}

/** A verified webhook, normalised from Stripe's event shape. */
export type ProviderEvent =
  | { id: string; created: number; type: string; kind: 'intent'; intent: ProviderIntent }
  | { id: string; created: number; type: string; kind: 'refund'; refund: ProviderRefund }
  | { id: string; created: number; type: string; kind: 'ignored' };

export type SimulatedOutcome = 'succeed' | 'fail' | 'succeed_refund_fails' | 'processing';

export interface PaymentProvider {
  readonly name: 'stripe' | 'mock';
  createPaymentIntent(
    params: { amount: number; currency: 'INR'; description: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<ProviderIntent>;
  retrievePaymentIntent(id: string): Promise<ProviderIntent>;
  /** Throws IntentStateError if the intent can no longer be cancelled (e.g. it already succeeded). */
  cancelPaymentIntent(id: string, idempotencyKey: string): Promise<ProviderIntent>;
  createRefund(params: { paymentIntentId: string; amount: number; metadata: Record<string, string> }, idempotencyKey: string): Promise<ProviderRefund>;
  retrieveRefund(id: string): Promise<ProviderRefund>;
  /** Verifies the signature over the raw body and normalises the event. Throws WebhookSignatureError. */
  constructWebhookEvent(rawBody: Buffer, signature: string | undefined): ProviderEvent;
  /** Test-only: plays the customer's part (confirm with a test card / simulate). Outcome arrives via webhook. */
  simulateCustomerPayment(intentId: string, outcome: SimulatedOutcome): Promise<void>;
}

/** Network/5xx/rate-limit problems: safe to retry with the same idempotency key. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** The provider refused the request permanently (bad parameters, auth, …). */
export class ProviderRejectedError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

/** The PaymentIntent is in a state that does not allow the operation (e.g. cancel after success). */
export class IntentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentStateError';
  }
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}
