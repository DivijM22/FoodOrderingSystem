import { Router } from 'express';
import { authenticate, authorize, pageMeta, sendSuccess, validate, type JwtOptions } from '@food/common';
import { agentsQuery, deliveryIdParams, listQuery, orderIdParams, upsertAgentBody, verifyOtpBody } from '../schemas.js';
import type { DeliveryService } from '../services/delivery.service.js';

/**
 * Delivery partners act on their assigned deliveries; platform admins observe and unblock.
 * Customers never call this service: they track orders through the Order Service.
 */
export function deliveriesRouter(delivery: DeliveryService, jwt: JwtOptions): Router {
  const router = Router();
  router.use(authenticate(jwt));
  const agent = authorize('delivery_agent');
  const admin = authorize('platform_admin');
  const id = (req: { params: Record<string, unknown> }) => String(req.params.id);

  // ---- partner profile (identity from the verified JWT)
  router.get('/agents/me', agent, async (req, res) => sendSuccess(res, await delivery.getMe(req.user!)));
  router.put('/agents/me', agent, validate({ body: upsertAgentBody }), async (req, res) => sendSuccess(res, await delivery.upsertMe(req.user!, req.body)));
  router.get('/agents', admin, validate({ query: agentsQuery }), async (req, res) => sendSuccess(res, await delivery.listAgents(req.query.status as never)));

  // ---- reads
  router.get('/', authorize('delivery_agent', 'platform_admin'), validate({ query: listQuery }), async (req, res) => {
    const q = req.query as unknown as { status?: never; page: number; limit: number };
    const { deliveries, total } = await delivery.list(req.user!, q);
    sendSuccess(res, deliveries, 200, pageMeta(q.page, q.limit, total));
  });
  router.get('/order/:orderId', admin, validate({ params: orderIdParams }), async (req, res) => sendSuccess(res, await delivery.getByOrder(String(req.params.orderId))));
  router.get('/:id', authorize('delivery_agent', 'platform_admin'), validate({ params: deliveryIdParams }), async (req, res) => sendSuccess(res, await delivery.get(req.user!, id(req))));

  // ---- partner actions (assigned partner only)
  router.post('/:id/pickup', agent, validate({ params: deliveryIdParams }), async (req, res) => sendSuccess(res, await delivery.pickup(req.user!, id(req))));
  router.post('/:id/arrived', agent, validate({ params: deliveryIdParams }), async (req, res) => sendSuccess(res, await delivery.arrive(req.user!, id(req))));
  router.post('/:id/verify-otp', agent, validate({ params: deliveryIdParams, body: verifyOtpBody }), async (req, res) =>
    sendSuccess(res, await delivery.verifyOtp(req.user!, id(req), req.body.otp)),
  );
  router.post('/:id/resend-otp', agent, validate({ params: deliveryIdParams }), async (req, res) => sendSuccess(res, await delivery.resendOtp(req.user!, id(req))));

  // ---- operator
  router.post('/:id/retry-assignment', admin, validate({ params: deliveryIdParams }), async (req, res) => sendSuccess(res, await delivery.retryAssignment(id(req))));

  return router;
}
