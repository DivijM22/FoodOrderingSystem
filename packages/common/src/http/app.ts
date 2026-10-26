import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Raw request body; only populated when createBaseApp({ captureRawBody: true }). */
      rawBody?: Buffer;
    }
  }
}

/**
 * Creates an Express app with the middleware every service shares:
 * JSON parsing, request IDs and structured request logging.
 * Services mount their routers, then call `finalizeApp` to add error handling.
 */
export function createBaseApp(logger: Logger, opts: { captureRawBody?: boolean } = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(
    express.json({
      limit: '100kb',
      // Webhook signature checks (e.g. Stripe) need the exact bytes that were signed.
      verify: opts.captureRawBody
        ? (req, _res, buf) => {
            (req as express.Request).rawBody = Buffer.from(buf);
          }
        : undefined,
    }),
  );
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
      // Keep access logs compact: no header dumps (which could also leak tokens).
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (res.statusCode === 503 ? 'warn' : err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  return app;
}
