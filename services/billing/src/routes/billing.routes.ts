import { Router } from 'express';
import { authenticate, authorize, optionalAuthenticate, pageMeta, sendSuccess, validate, type JwtOptions } from '@food/common';
import { codeParams, createDiscountBody, invoiceIdParams, listQuery, orderIdParams, setActiveBody } from '../schemas.js';
import type { BillingService } from '../services/billing.service.js';

export function invoicesRouter(billing: BillingService, jwt: JwtOptions): Router {
  const router = Router();
  router.use(authenticate(jwt), authorize('customer', 'platform_admin'));

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const q = req.query as unknown as { page: number; limit: number };
    const { invoices, total } = await billing.list(req.user!, req.query as never);
    sendSuccess(res, invoices, 200, pageMeta(q.page, q.limit, total));
  });

  router.get('/order/:orderId', validate({ params: orderIdParams }), async (req, res) => {
    sendSuccess(res, await billing.getByOrder(req.user!, String(req.params.orderId)));
  });

  router.get('/:id', validate({ params: invoiceIdParams }), async (req, res) => {
    sendSuccess(res, await billing.get(req.user!, String(req.params.id)));
  });

  return router;
}

export function discountsRouter(billing: BillingService, jwt: JwtOptions): Router {
  const router = Router();
  const admin = [authenticate(jwt), authorize('platform_admin')];

  /** Public: currently usable promo codes. Admins may add ?all=true. */
  router.get('/', optionalAuthenticate(jwt), async (req, res) => {
    sendSuccess(res, await billing.listDiscounts(req.query.all === 'true' && req.user?.role === 'platform_admin'));
  });

  router.post('/', ...admin, validate({ body: createDiscountBody }), async (req, res) => {
    sendSuccess(res, await billing.createDiscount(req.body), 201);
  });

  router.patch('/:code', ...admin, validate({ params: codeParams, body: setActiveBody }), async (req, res) => {
    sendSuccess(res, await billing.setDiscountActive(String(req.params.code), req.body.active));
  });

  return router;
}
