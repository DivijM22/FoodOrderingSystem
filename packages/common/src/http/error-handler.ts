import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { AppError, NotFoundError } from '../errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
};

/** Translates any thrown error into the standard error envelope. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let appErr: AppError;

    if (err instanceof AppError) {
      appErr = err;
    } else if (err instanceof mongoose.Error.CastError) {
      appErr = new AppError(400, 'INVALID_ID', `Invalid value for ${err.path}`);
    } else if (err instanceof mongoose.Error.ValidationError) {
      appErr = new AppError(
        400,
        'VALIDATION_ERROR',
        'Data validation failed',
        Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
      );
    } else if (isDuplicateKey(err)) {
      appErr = new AppError(409, 'CONFLICT', 'A resource with the same unique value already exists');
    } else if (err?.type === 'entity.parse.failed') {
      appErr = new AppError(400, 'MALFORMED_JSON', 'Request body is not valid JSON');
    } else if (err?.type === 'entity.too.large') {
      appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    } else {
      appErr = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    if (appErr.statusCode === 503) {
      // An expected, handled condition (a dependency is down): worth a warning, not an error alert.
      logger.warn({ code: appErr.code, reqId: req.id, path: req.path, reason: appErr.message }, 'Dependency unavailable');
    } else if (appErr.statusCode >= 500) {
      logger.error({ err, reqId: req.id, path: req.path }, 'Unhandled error');
    } else {
      logger.debug({ code: appErr.code, reqId: req.id, path: req.path }, appErr.message);
    }

    res.status(appErr.statusCode).json({
      success: false,
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.details ? { details: appErr.details } : {}),
      },
    });
  };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
