import { signAccessToken, type Role } from '@food/common';
import { Types } from 'mongoose';
import { loadCatalogConfig } from '../src/config.js';

export const config = loadCatalogConfig({
  NODE_ENV: 'test',
  MONGO_URI: 'unused-in-tests',
  JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
});

export function tokenFor(role: Role, id = new Types.ObjectId().toString()) {
  const token = signAccessToken(
    { id, role, email: `${role}@test.local`, name: role },
    { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, expiresIn: '5m' },
  );
  return { id, header: { authorization: `Bearer ${token}` } };
}
