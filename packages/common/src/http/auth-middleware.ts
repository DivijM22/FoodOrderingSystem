import type { RequestHandler } from 'express';
import { verifyAccessToken, type AuthUser, type JwtOptions, type Role } from '../auth.js';
import { ForbiddenError, UnauthorizedError } from '../errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Raw bearer token, kept so services can forward it on synchronous calls. */
      token?: string;
    }
  }
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/** Requires a valid access token and attaches `req.user`. */
export function authenticate(opts: JwtOptions): RequestHandler {
  return (req, _res, next) => {
    const token = extractBearer(req.headers.authorization);
    if (!token) return next(new UnauthorizedError('Missing bearer token', 'MISSING_TOKEN'));
    try {
      req.user = verifyAccessToken(token, opts);
      req.token = token;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Attaches `req.user` when a valid token is present but never rejects anonymous requests. */
export function optionalAuthenticate(opts: JwtOptions): RequestHandler {
  return (req, _res, next) => {
    const token = extractBearer(req.headers.authorization);
    if (!token) return next();
    try {
      req.user = verifyAccessToken(token, opts);
      req.token = token;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Role-based access control. Must run after `authenticate`. */
export function authorize(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role)) return next(new ForbiddenError());
    next();
  };
}
