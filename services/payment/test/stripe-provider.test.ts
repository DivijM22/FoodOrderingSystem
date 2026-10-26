/**
 * StripeProvider tests.
 *
 * 1. Webhook verification uses the official SDK offline — always runs.
 * 2. API calls run against **stripe-mock** (Stripe's official OpenAPI-driven mock server) when
 *    STRIPE_MOCK_URL is set, e.g.:  docker run -p 12111:12111 stripe/stripe-mock
 *    stripe-mock validates request shapes/parameters but is stateless and returns fixtures —
 *    it is NOT a real Stripe test-mode transaction. Real test-mode verification needs real keys.
 */
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { loadPaymentConfig } from '../src/config.js';
import { ProviderRejectedError, ProviderUnavailableError, WebhookSignatureError } from '../src/providers/provider.js';
import { mapStripeError, StripeProvider } from '../src/providers/stripe.provider.js';
import { IntentStateError } from '../src/providers/provider.js';

const SECRET = 'whsec_offline_verification_secret';
const stripeMockUrl = process.env.STRIPE_MOCK_URL;

describe('StripeProvider: safety and webhook verification (offline)', () => {
  it('refuses live keys', () => {
    expect(() => new StripeProvider('sk_live_abc', SECRET)).toThrow(/non-test/);
  });

  it('config refuses PAYMENT_PROVIDER=stripe without test keys', () => {
    const base = { MONGO_URI: 'x', JWT_SECRET: 'x'.repeat(32), RABBITMQ_URL: 'amqp://x', ORDER_SERVICE_URL: 'http://o', PAYMENT_PROVIDER: 'stripe' };
    expect(() => loadPaymentConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_123', STRIPE_WEBHOOK_SECRET: 'whsec_x' })).toThrow(/TEST key/);
    expect(() => loadPaymentConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_123' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(loadPaymentConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_x' }).PAYMENT_PROVIDER).toBe('stripe');
  });

  it('verifies Stripe-signed payloads and normalises PaymentIntent events', () => {
    const provider = new StripeProvider('sk_test_offline', SECRET);
    const payload = JSON.stringify({
      id: 'evt_1', object: 'event', type: 'payment_intent.payment_failed', created: 1, livemode: false,
      data: { object: { id: 'pi_1', object: 'payment_intent', status: 'requires_payment_method', amount: 70700, currency: 'inr', metadata: { paymentId: 'p1' }, last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } } },
    });
    const evt = provider.constructWebhookEvent(Buffer.from(payload), Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }));
    expect(evt).toMatchObject({ id: 'evt_1', kind: 'intent', intent: { id: 'pi_1', status: 'requires_payment_method', lastError: { code: 'insufficient_funds' }, metadata: { paymentId: 'p1' } } });
  });

  it('classifies Stripe errors: transient vs state vs permanent', () => {
    const E = Stripe.errors;
    expect(mapStripeError(new E.StripeInvalidRequestError({ code: 'idempotency_key_in_use', message: 'in use' }))).toBeInstanceOf(ProviderUnavailableError);
    expect(mapStripeError(new E.StripeConnectionError({ message: 'socket hang up' }))).toBeInstanceOf(ProviderUnavailableError);
    expect(mapStripeError(new E.StripeRateLimitError({ message: 'slow down' }))).toBeInstanceOf(ProviderUnavailableError);
    expect(mapStripeError(new E.StripeInvalidRequestError({ code: 'payment_intent_unexpected_state', message: 'succeeded' }))).toBeInstanceOf(IntentStateError);
    expect(mapStripeError(new E.StripeInvalidRequestError({ code: 'parameter_invalid_integer', message: 'bad' }))).toBeInstanceOf(ProviderRejectedError);
  });

  it('rejects bad signatures', () => {
    const provider = new StripeProvider('sk_test_offline', SECRET);
    const payload = '{"id":"evt_2","object":"event","type":"refund.updated","data":{"object":{}}}';
    expect(() => provider.constructWebhookEvent(Buffer.from(payload), undefined)).toThrow(WebhookSignatureError);
    expect(() => provider.constructWebhookEvent(Buffer.from(payload), Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' }))).toThrow(WebhookSignatureError);
  });

  it('never hangs: an unreachable Stripe becomes a retryable ProviderUnavailableError', async () => {
    const provider = new StripeProvider('sk_test_offline', SECRET, { apiUrl: 'http://127.0.0.1:1', maxNetworkRetries: 0, timeoutMs: 1000 });
    const started = Date.now();
    await expect(provider.retrievePaymentIntent('pi_x')).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15_000);
});

describe.skipIf(!stripeMockUrl)('StripeProvider against stripe-mock (request-shape validation, not real Stripe)', () => {
  const provider = new StripeProvider('sk_test_123', SECRET, { apiUrl: stripeMockUrl });

  it('creates a PaymentIntent in INR minor units with an idempotency key', async () => {
    const pi = await provider.createPaymentIntent(
      { amount: 70700, currency: 'INR', description: 'Food order ORD-TEST', metadata: { paymentId: 'p1', orderId: 'o1' } },
      'pi:test-payment-1',
    );
    expect(pi.id).toMatch(/^pi_/);
    expect(pi.amount).toBe(70700);
    expect(pi.clientSecret).toBeTruthy();
  });

  it('retrieves, cancels and confirms PaymentIntents', async () => {
    expect((await provider.retrievePaymentIntent('pi_123')).id).toBeTruthy();
    expect((await provider.cancelPaymentIntent('pi_123', 'cancel:p1')).id).toBeTruthy();
    await expect(provider.simulateCustomerPayment('pi_123', 'succeed')).resolves.toBeUndefined();
    await expect(provider.simulateCustomerPayment('pi_123', 'processing')).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it('creates and retrieves refunds', async () => {
    const r = await provider.createRefund({ paymentIntentId: 'pi_123', amount: 70700, metadata: { refundId: 'r1' } }, 'refund:r1');
    expect(r.id).toMatch(/^re_/);
    expect((await provider.retrieveRefund(r.id)).id).toBe(r.id);
  });

  it('surfaces Stripe request validation errors as ProviderRejectedError', async () => {
    // stripe-mock validates against Stripe's OpenAPI spec (types/required params), not business rules.
    await expect(
      provider.createRefund({ paymentIntentId: 'pi_123', amount: 'abc' as unknown as number, metadata: {} }, 'refund:bad'),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
  });
});
