import { Router } from 'express';
import { authenticate, authorize, pageMeta, sendSuccess, validate, ValidationError, type JwtOptions } from '@food/common';
import {
  cancelOrderBody,
  createOrderBody,
  idempotencyKeyHeader,
  listOrdersQuery,
  orderIdParams,
  type ListOrdersQuery,
} from '../schemas.js';
import type { OrderService } from '../services/order.service.js';
import type { TrackingHub } from '../tracking/tracking.js';

export function ordersRouter(service: OrderService, jwt: JwtOptions, tracking: TrackingHub): Router {
  const router = Router();
  router.use(authenticate(jwt));
  const ctx = (req: { id?: unknown; token?: string }) => ({ requestId: req.id ? String(req.id) : undefined, token: req.token });
  const id = (p: Record<string, unknown>) => String(p.id);

  /** Place an order. Optional `Idempotency-Key` header makes retries safe. */
  router.post('/', authorize('customer'), validate({ body: createOrderBody }), async (req, res) => {
    const rawKey = req.header('idempotency-key');
    let key: string | undefined;
    if (rawKey !== undefined) {
      const parsed = idempotencyKeyHeader.safeParse(rawKey);
      if (!parsed.success) throw new ValidationError('Invalid Idempotency-Key header', [{ path: 'headers.idempotency-key', message: '8–100 chars: letters, digits, - or _' }]);
      key = parsed.data;
    }
    const { order, replayed } = await service.createOrder(req.user!, req.body, key, ctx(req));
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    sendSuccess(res, order, replayed ? 200 : 201);
  });

  /** Order history: customers get their own; restaurant admins pass ?restaurantId; platform admins see all. */
  router.get('/', validate({ query: listOrdersQuery }), async (req, res) => {
    const q = req.query as unknown as ListOrdersQuery;
    const { orders, total } = await service.listOrders(req.user!, q, ctx(req));
    sendSuccess(res, orders, 200, pageMeta(q.page, q.limit, total));
  });

  router.get('/:id', validate({ params: orderIdParams }), async (req, res) => {
    sendSuccess(res, await service.getOrder(req.user!, id(req.params), ctx(req)));
  });

  router.post('/:id/cancel', validate({ params: orderIdParams, body: cancelOrderBody }), async (req, res) => {
    sendSuccess(res, await service.cancelOrder(req.user!, id(req.params), req.body.reason, ctx(req)));
  });

  /** Progress tracker: expected steps + chronological, customer-visible history (last element = current status). */
  /**
   * Live tracking over Server-Sent Events (JWT in the Authorization header; same access rules as
   * GET /:id/tracking). Sends a snapshot on connect, then one message per committed change.
   */
  router.get('/:id/tracking/stream', validate({ params: orderIdParams }), async (req, res) => {
    const order = await service.getTrackable(req.user!, id(req.params), ctx(req));
    tracking.subscribe(order, res);
  });

  router.get('/:id/tracking', validate({ params: orderIdParams }), async (req, res) => {
    sendSuccess(res, await service.getTracking(req.user!, id(req.params), ctx(req)));
  });

  return router;
}
