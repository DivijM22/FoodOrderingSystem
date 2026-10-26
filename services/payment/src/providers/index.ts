import type { Logger } from '@food/common';
import type { PaymentConfig } from '../config.js';
import { MockPaymentProvider } from './mock.provider.js';
import type { PaymentProvider } from './provider.js';
import { StripeProvider } from './stripe.provider.js';

export function createProvider(config: PaymentConfig, logger: Logger): PaymentProvider {
  if (config.PAYMENT_PROVIDER === 'stripe') {
    logger.info({ provider: 'stripe', mode: 'test' }, 'Payment provider: Stripe (TEST MODE)');
    return new StripeProvider(config.STRIPE_SECRET_KEY!, config.STRIPE_WEBHOOK_SECRET!, { apiUrl: config.STRIPE_API_URL });
  }
  logger.warn(
    { provider: 'mock' },
    'Payment provider: MOCK — payments are simulated locally; no Stripe API calls are made and nothing here is a Stripe transaction',
  );
  const url = config.MOCK_WEBHOOK_URL ?? `http://127.0.0.1:${config.PORT}/payments/webhook`;
  return new MockPaymentProvider(config.MOCK_WEBHOOK_SECRET, MockPaymentProvider.httpDeliverer(url, logger), logger);
}
