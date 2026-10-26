import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import {
  authenticate,
  authorize,
  createBaseApp,
  createLogger,
  errorHandler,
  healthRouter,
  notFoundHandler,
  sendSuccess,
  ServiceUnavailableError,
  signAccessToken,
  validate,
} from '../src/index.js';

const jwtOpts = { secret: 's'.repeat(32), issuer: 'i', audience: 'a' };
const logger = createLogger('test', 'silent');

function buildApp() {
  const app = createBaseApp(logger);
  app.use(healthRouter('test', { db: () => true, cache: () => false }));
  app.use('/opt', healthRouter('test', { db: () => true }, { broker: () => false }));
  app.get(
    '/items',
    validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1) }) }),
    (req, res) => sendSuccess(res, { page: req.query.page }),
  );
  app.post('/items', validate({ body: z.object({ name: z.string().min(2) }) }), (req, res) => sendSuccess(res, req.body, 201));
  app.get('/admin', authenticate(jwtOpts), authorize('platform_admin'), (_req, res) => sendSuccess(res, 'ok'));
  app.get('/down', () => {
    throw new ServiceUnavailableError();
  });
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

describe('shared HTTP plumbing', () => {
  const app = buildApp();

  it('reports degraded health with 503 when a check fails', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.checks).toEqual({ db: 'up', cache: 'down' });
  });

  it('stays 200 but degraded when only an optional dependency is down', async () => {
    const res = await request(app).get('/opt/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'degraded', checks: { db: 'up', broker: 'down' } });
  });

  it('coerces query params', async () => {
    const res = await request(app).get('/items?page=3');
    expect(res.body).toEqual({ success: true, data: { page: 3 } });
  });

  it('returns structured validation errors', async () => {
    const res = await request(app).post('/items').send({ name: 'a' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('body.name');
  });

  it('handles malformed JSON', async () => {
    const res = await request(app).post('/items').set('content-type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });

  it('enforces authentication and roles', async () => {
    expect((await request(app).get('/admin')).status).toBe(401);
    const customer = signAccessToken({ id: '1', email: 'c@x.com', role: 'customer', name: 'C' }, { ...jwtOpts, expiresIn: '1m' });
    expect((await request(app).get('/admin').set('authorization', `Bearer ${customer}`)).status).toBe(403);
    const admin = signAccessToken({ id: '2', email: 'a@x.com', role: 'platform_admin', name: 'A' }, { ...jwtOpts, expiresIn: '1m' });
    expect((await request(app).get('/admin').set('authorization', `Bearer ${admin}`)).status).toBe(200);
  });

  it('maps dependency outages to 503 with their code', async () => {
    const res = await request(app).get('/down');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('hides internal error details and returns 500', async () => {
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  });

  it('returns 404 envelope for unknown routes and echoes request id', async () => {
    const res = await request(app).get('/nope').set('x-request-id', 'abc-123');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});

describe('createBaseApp({ captureRawBody })', () => {
  it('exposes the exact raw bytes alongside the parsed body', async () => {
    const app = createBaseApp(logger, { captureRawBody: true });
    app.post('/hook', (req, res) => res.json({ raw: req.rawBody?.toString('utf8'), parsed: req.body }));
    const raw = '{"b":1,  "a":"x"}';
    const res = await request(app).post('/hook').set('content-type', 'application/json').send(raw);
    expect(res.body).toEqual({ raw, parsed: { b: 1, a: 'x' } });
  });

  it('does not capture raw bodies by default', async () => {
    const app = createBaseApp(logger);
    app.post('/hook', (req, res) => res.json({ hasRaw: req.rawBody !== undefined }));
    expect((await request(app).post('/hook').send({ a: 1 })).body.hasRaw).toBe(false);
  });
});
