import { Router } from 'express';
import { authenticate, authorize, pageMeta, sendSuccess, validate, type JwtOptions } from '@food/common';
import { createUserBody, listUsersQuery, setStatusBody, userIdParams } from '../schemas.js';
import type { AuthService } from '../services/auth.service.js';

/** Platform-admin user management: create staff accounts (restaurant admins, delivery agents), moderate and delete users. */
export function usersRouter(service: AuthService, jwt: JwtOptions): Router {
  const router = Router();
  router.use(authenticate(jwt), authorize('platform_admin'));

  router.get('/', validate({ query: listUsersQuery }), async (req, res) => {
    const { role, page, limit } = req.query as unknown as { role?: never; page: number; limit: number };
    const { users, total } = await service.listUsers({ role, page, limit });
    sendSuccess(res, users, 200, pageMeta(page, limit, total));
  });

  router.post('/', validate({ body: createUserBody }), async (req, res) => {
    sendSuccess(res, await service.createUser(req.body), 201);
  });

  router.patch('/:id/status', validate({ params: userIdParams, body: setStatusBody }), async (req, res) => {
    sendSuccess(res, await service.setActive(req.user!.id, String(req.params.id), req.body.isActive));
  });

  /** Permanent deletion of an inactive account (see AuthService.deleteUser for the rules). */
  router.delete('/:id', validate({ params: userIdParams }), async (req, res) => {
    sendSuccess(res, await service.deleteUser(req.user!.id, String(req.params.id)));
  });

  return router;
}
