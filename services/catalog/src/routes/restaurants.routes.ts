import { Router } from 'express';
import {
  authenticate,
  authorize,
  optionalAuthenticate,
  pageMeta,
  sendSuccess,
  validate,
  type JwtOptions,
} from '@food/common';
import {
  createMenuItemBody,
  createRestaurantBody,
  listRestaurantsQuery,
  menuItemParams,
  menuQuery,
  restaurantIdParams,
  setAvailabilityBody,
  setOpenBody,
  updateMenuItemBody,
  updateRestaurantBody,
  type ListRestaurantsQuery,
  type MenuQuery,
  addAdminBody,
  adminParams,
} from '../schemas.js';
import type { CatalogService } from '../services/catalog.service.js';

export function restaurantsRouter(service: CatalogService, jwt: JwtOptions): Router {
  const router = Router();
  // Browsing is public; a token (if present) lets owners/admins see inactive restaurants.
  const viewer = optionalAuthenticate(jwt);
  // Restaurant admins manage only restaurants listing them in adminIds (checked in the service); platform admins manage all.
  const managers = [authenticate(jwt), authorize('restaurant_admin', 'platform_admin')];
  const platformAdmin = [authenticate(jwt), authorize('platform_admin')];
  const id = (p: Record<string, unknown>) => String(p.id);
  const itemId = (p: Record<string, unknown>) => String(p.itemId);

  // ---------------------------------------------------------------- public browsing
  router.get('/', viewer, validate({ query: listRestaurantsQuery }), async (req, res) => {
    const q = req.query as unknown as ListRestaurantsQuery;
    const { restaurants, total } = await service.listRestaurants(q, req.user);
    sendSuccess(res, restaurants, 200, pageMeta(q.page, q.limit, total));
  });

  router.get('/cuisines', async (_req, res) => {
    sendSuccess(res, await service.listCuisines());
  });

  /** The signed-in restaurant administrator's assigned restaurants (declared before /:id). */
  router.get('/mine', authenticate(jwt), authorize('restaurant_admin'), async (req, res) => {
    sendSuccess(res, await service.listMine(req.user!));
  });

  router.get('/:id', viewer, validate({ params: restaurantIdParams }), async (req, res) => {
    sendSuccess(res, await service.getRestaurant(id(req.params), req.user));
  });

  router.get('/:id/menu', viewer, validate({ params: restaurantIdParams, query: menuQuery }), async (req, res) => {
    sendSuccess(res, await service.getMenu(id(req.params), req.query as unknown as MenuQuery, req.user));
  });

  router.get('/:id/menu/:itemId', viewer, validate({ params: menuItemParams }), async (req, res) => {
    sendSuccess(res, await service.getMenuItem(id(req.params), itemId(req.params), req.user));
  });

  // ---------------------------------------------------------------- restaurant management
  router.post('/', ...platformAdmin, validate({ body: createRestaurantBody }), async (req, res) => {
    sendSuccess(res, await service.createRestaurant(req.body, req.user!), 201);
  });

  router.patch('/:id', ...managers, validate({ params: restaurantIdParams, body: updateRestaurantBody }), async (req, res) => {
    sendSuccess(res, await service.updateRestaurant(id(req.params), req.body, req.user!));
  });

  router.patch('/:id/open', ...managers, validate({ params: restaurantIdParams, body: setOpenBody }), async (req, res) => {
    sendSuccess(res, await service.setOpen(id(req.params), req.body.isOpen, req.user!));
  });

  router.delete('/:id', ...platformAdmin, validate({ params: restaurantIdParams }), async (req, res) => {
    sendSuccess(res, await service.deactivateRestaurant(id(req.params), req.user));
  });

  // ---------------------------------------------------------------- administrator assignments (platform admins only)
  router.post('/:id/admins', ...platformAdmin, validate({ params: restaurantIdParams, body: addAdminBody }), async (req, res) => {
    sendSuccess(res, await service.addAdmin(id(req.params), req.body.userId, req.user!));
  });

  router.delete('/:id/admins/:userId', ...platformAdmin, validate({ params: adminParams }), async (req, res) => {
    sendSuccess(res, await service.removeAdmin(id(req.params), String(req.params.userId), req.user!));
  });

  // ---------------------------------------------------------------- menu management
  router.post('/:id/menu', ...managers, validate({ params: restaurantIdParams, body: createMenuItemBody }), async (req, res) => {
    sendSuccess(res, await service.addMenuItem(id(req.params), req.body, req.user!), 201);
  });

  router.patch('/:id/menu/:itemId', ...managers, validate({ params: menuItemParams, body: updateMenuItemBody }), async (req, res) => {
    sendSuccess(res, await service.updateMenuItem(id(req.params), itemId(req.params), req.body, req.user!));
  });

  router.patch(
    '/:id/menu/:itemId/availability',
    ...managers,
    validate({ params: menuItemParams, body: setAvailabilityBody }),
    async (req, res) => {
      sendSuccess(res, await service.setAvailability(id(req.params), itemId(req.params), req.body.isAvailable, req.user!));
    },
  );

  router.delete('/:id/menu/:itemId', ...managers, validate({ params: menuItemParams }), async (req, res) => {
    await service.deleteMenuItem(id(req.params), itemId(req.params), req.user!);
    res.status(204).end();
  });

  return router;
}
