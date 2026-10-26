import { Router } from 'express';
import { authenticate, sendSuccess, validate, type JwtOptions } from '@food/common';
import { changePasswordBody, loginBody, registerBody, updateProfileBody } from '../schemas.js';
import type { AuthService } from '../services/auth.service.js';

export function authRouter(service: AuthService, jwt: JwtOptions): Router {
  const router = Router();
  const requireAuth = authenticate(jwt);

  /** Public self-registration always creates a customer account. */
  router.post('/register', validate({ body: registerBody }), async (req, res) => {
    sendSuccess(res, await service.register(req.body), 201);
  });

  router.post('/login', validate({ body: loginBody }), async (req, res) => {
    sendSuccess(res, await service.login(req.body.email, req.body.password));
  });

  /** Token introspection for clients and the gateway; returns the verified claims. */
  router.get('/verify', requireAuth, (req, res) => {
    sendSuccess(res, { valid: true, user: req.user });
  });

  router.get('/me', requireAuth, async (req, res) => {
    sendSuccess(res, await service.getProfile(req.user!.id));
  });

  router.patch('/me', requireAuth, validate({ body: updateProfileBody }), async (req, res) => {
    sendSuccess(res, await service.updateProfile(req.user!.id, req.body));
  });

  router.post('/me/password', requireAuth, validate({ body: changePasswordBody }), async (req, res) => {
    await service.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword);
    res.status(204).end();
  });

  return router;
}
