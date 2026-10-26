import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { ValidationError } from '../errors.js';

interface Schemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Validates and coerces request parts. Parsed values replace the raw ones,
 * so handlers can trust `req.body`, `req.query` and `req.params`.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((i) => ({
          path: [part, ...i.path.map(String)].join('.'),
          message: i.message,
        }));
        return next(new ValidationError('Request validation failed', details));
      }
      // Express 5 exposes req.query as a getter, so redefine instead of assigning.
      Object.defineProperty(req, part, { value: result.data, writable: true, enumerable: true, configurable: true });
    }
    next();
  };
}
