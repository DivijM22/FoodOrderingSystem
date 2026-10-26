import { Router } from 'express';
import {
  authenticate,
  authorize,
  pageMeta,
  processOnce,
  sendSuccess,
  validate,
  ValidationError,
  type JwtOptions,
  type Logger,
} from '@food/common';
import { WebhookSignatureError } from '../providers/provider.js';
import {
  idempotencyKeyHeader,
  initiateBody,
  listQuery,
  orderIdParams,
  paymentIdParams,
  refundBody,
  simulateBody,
} from '../schemas.js';
import { BillingPendingError, type PaymentService } from '../services/payment.service.js';
import type { PaymentWorkflow } from '../services/workflow.js';

export function paymentsRouter(deps: {
  service: PaymentService;
  workflow: PaymentWorkflow;
  jwt: JwtOptions;
  logger: Logger;
  enableTestEndpoints: boolean;
}): Router {
  const { service, workflow, jwt, logger } = deps;
  const router = Router();
  const auth = authenticate(jwt);
  const id = (p: Record<string, unknown>) => String(p.id);
  const ctx = (req: { id?: unknown; token?: string }) => ({ token: req.token!, requestId: req.id ? String(req.id) : undefined });

  /**
   * Stripe webhook. Authenticated by the Stripe-Signature header over the raw body — not by a JWT.
   * 400 on a bad signature (Stripe will not be fooled into retrying forgeries as valid);
   * 200 for verified events, including duplicates and ones we deliberately ignore;
   * 5xx only for our own transient failures, so Stripe retries them.
   */
  router.post('/webhook', async (req, res) => {
    let evt;
    try {
      if (!req.rawBody) throw new WebhookSignatureError('Webhook body must be application/json');
      evt = workflow.provider.constructWebhookEvent(req.rawBody, req.header('stripe-signature'));
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        logger.warn({ err: err.message }, 'Rejected webhook with invalid signature');
        res.status(400).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed' } });
        return;
      }
      throw err;
    }
    let result: string = 'duplicate';
    const fresh = await processOnce('payment-service.webhooks', evt.id, async (session) => {
      result = await workflow.handleProviderEvent(session, evt);
    });
    workflow.notify();
    if (result === 'unknown' || result === 'anomaly') logger.warn({ eventId: evt.id, type: evt.type, result }, 'Webhook did not match a payment');
    logger.info({ eventId: evt.id, type: evt.type, result: fresh ? result : 'duplicate' }, 'Webhook processed');
    sendSuccess(res, { received: true, eventId: evt.id, result: fresh ? result : 'duplicate' });
  });

  router.post('/initiate', auth, authorize('customer'), validate({ body: initiateBody }), async (req, res) => {
    try {
      const { created, result } = await service.initiate(req.user!, req.body.orderId, ctx(req));
      sendSuccess(res, result, created ? 201 : 200);
    } catch (err) {
      if (err instanceof BillingPendingError) res.setHeader('Retry-After', '2');
      throw err;
    }
  });

  router.get('/', auth, authorize('customer', 'platform_admin'), validate({ query: listQuery }), async (req, res) => {
    const q = req.query as unknown as { page: number; limit: number };
    const { payments, total } = await service.list(req.user!, req.query as never);
    sendSuccess(res, payments, 200, pageMeta(q.page, q.limit, total));
  });

  router.get('/order/:orderId', auth, validate({ params: orderIdParams }), async (req, res) => {
    sendSuccess(res, await service.getByOrder(req.user!, String(req.params.orderId)));
  });

  router.get('/:id', auth, validate({ params: paymentIdParams }), async (req, res) => {
    sendSuccess(res, await service.get(req.user!, id(req.params)));
  });

  /** Manual refund (full or partial). Customers cancel the order instead; refunds then happen automatically. */
  router.post('/:id/refund', auth, authorize('platform_admin'), validate({ params: paymentIdParams, body: refundBody }), async (req, res) => {
    const parsed = idempotencyKeyHeader.safeParse(req.header('idempotency-key'));
    if (!parsed.success) {
      throw new ValidationError('Idempotency-Key header is required', [{ path: 'headers.idempotency-key', message: '8–100 chars: letters, digits, - or _' }]);
    }
    const { refund, replayed } = await service.refund(req.user!, id(req.params), req.body, parsed.data);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendSuccess(res, refund, replayed ? 200 : 202);
  });

  if (deps.enableTestEndpoints) {
    router.post('/:id/simulate', auth, validate({ params: paymentIdParams, body: simulateBody }), async (req, res) => {
      sendSuccess(res, await service.simulate(req.user!, id(req.params), req.body.outcome, req.body.deliveries), 202);
    });
  }

  return router;
}
