import Stripe from 'stripe';
import { WebhookSignatureError, type IntentStatus, type ProviderEvent, type ProviderIntent, type ProviderRefund, type ProviderRefundStatus } from './provider.js';

/** Stripe events this service acts on; everything else is acknowledged and ignored. */
export const HANDLED_EVENT_TYPES = [
  'payment_intent.processing',
  'payment_intent.requires_action',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'refund.created',
  'refund.updated',
  'refund.failed',
] as const;

const meta = (m: unknown): Record<string, string> => (m && typeof m === 'object' ? (m as Record<string, string>) : {});

export function toProviderIntent(pi: Stripe.PaymentIntent): ProviderIntent {
  return {
    id: pi.id,
    status: pi.status as IntentStatus,
    amount: pi.amount,
    currency: pi.currency,
    metadata: meta(pi.metadata),
    clientSecret: pi.client_secret ?? undefined,
    lastError: pi.last_payment_error
      ? { code: pi.last_payment_error.decline_code ?? pi.last_payment_error.code ?? undefined, message: pi.last_payment_error.message ?? 'Payment failed' }
      : undefined,
  };
}

export function toProviderRefund(r: Stripe.Refund): ProviderRefund {
  const pi = typeof r.payment_intent === 'string' ? r.payment_intent : (r.payment_intent?.id ?? '');
  return {
    id: r.id,
    status: (r.status ?? 'pending') as ProviderRefundStatus,
    amount: r.amount,
    paymentIntentId: pi,
    metadata: meta(r.metadata),
    failureReason: r.failure_reason ?? undefined,
  };
}

/**
 * Verifies a Stripe-Signature header against the exact raw body (official SDK implementation,
 * including the timestamp tolerance that defeats replays) and normalises the event.
 */
export function verifyAndNormalise(rawBody: Buffer, signature: string | undefined, secret: string): ProviderEvent {
  if (!signature) throw new WebhookSignatureError('Missing Stripe-Signature header');
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    throw new WebhookSignatureError((err as Error).message);
  }
  const base = { id: event.id, created: event.created, type: event.type };
  if (event.type.startsWith('payment_intent.') && (HANDLED_EVENT_TYPES as readonly string[]).includes(event.type)) {
    return { ...base, kind: 'intent', intent: toProviderIntent(event.data.object as Stripe.PaymentIntent) };
  }
  if (event.type.startsWith('refund.') && (HANDLED_EVENT_TYPES as readonly string[]).includes(event.type)) {
    return { ...base, kind: 'refund', refund: toProviderRefund(event.data.object as Stripe.Refund) };
  }
  return { ...base, kind: 'ignored' };
}
