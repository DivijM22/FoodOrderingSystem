import jwt from 'jsonwebtoken';
import { UnauthorizedError } from './errors.js';

export const ROLES = ['customer', 'restaurant_admin', 'delivery_agent', 'platform_admin'] as const;
export type Role = (typeof ROLES)[number];

/** Claims carried in every access token issued by the Auth Service. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  name: string;
  /** When the token was issued (`iat`). Set by verifyAccessToken; lets a service tell a token minted after an event from an older one. */
  issuedAt?: Date;
}

export interface JwtOptions {
  secret: string;
  issuer: string;
  audience: string;
}

interface TokenClaims {
  sub: string;
  email: string;
  role: Role;
  name: string;
  iat?: number;
}

export function signAccessToken(user: AuthUser, opts: JwtOptions & { expiresIn: string }): string {
  const claims: TokenClaims = { sub: user.id, email: user.email, role: user.role, name: user.name };
  return jwt.sign(claims, opts.secret, {
    algorithm: 'HS256',
    issuer: opts.issuer,
    audience: opts.audience,
    expiresIn: opts.expiresIn as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Verifies an access token locally (no network hop to the Auth Service).
 * Throws UnauthorizedError with a specific code for expired vs invalid tokens.
 */
export function verifyAccessToken(token: string, opts: JwtOptions): AuthUser {
  try {
    const decoded = jwt.verify(token, opts.secret, {
      algorithms: ['HS256'],
      issuer: opts.issuer,
      audience: opts.audience,
    });
    if (typeof decoded === 'string') throw new UnauthorizedError('Invalid token', 'INVALID_TOKEN');
    const claims = decoded as Partial<TokenClaims>;
    if (!claims.sub || !claims.role || !ROLES.includes(claims.role)) {
      throw new UnauthorizedError('Invalid token claims', 'INVALID_TOKEN');
    }
    return {
      id: claims.sub,
      email: claims.email ?? '',
      role: claims.role,
      name: claims.name ?? '',
      ...(typeof claims.iat === 'number' ? { issuedAt: new Date(claims.iat * 1000) } : {}),
    };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    if (err instanceof jwt.TokenExpiredError) throw new UnauthorizedError('Token has expired', 'TOKEN_EXPIRED');
    throw new UnauthorizedError('Invalid token', 'INVALID_TOKEN');
  }
}
