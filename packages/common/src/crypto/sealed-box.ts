import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';

/**
 * Anonymous public-key encryption ("sealed box") for small secrets such as delivery OTPs:
 * ephemeral X25519 key agreement → HKDF-SHA256 → AES-256-GCM. Only the holder of the recipient's
 * private key can open it; the sender keeps nothing that can decrypt it afterwards.
 *
 * Format: `v1.<ephemeral public key>.<iv>.<ciphertext>.<tag>` (base64url, raw 32-byte X25519 key).
 * Keys are exchanged as base64 DER (SPKI public, PKCS#8 private), e.g. via environment variables.
 */
const INFO = Buffer.from('food-platform sealed-box v1');
const b64u = (b: Buffer) => b.toString('base64url');

const rawPublic = (k: KeyObject) => Buffer.from(k.export({ format: 'jwk' }).x!, 'base64url');

export function generateSealingKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export const loadSealingPublicKey = (b64: string) => createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
export const loadSealingPrivateKey = (b64: string) => createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });

function deriveKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), INFO, 32));
}

export function seal(plaintext: string, recipientPublicKey: KeyObject): string {
  const eph = generateKeyPairSync('x25519');
  const ephRaw = rawPublic(eph.publicKey);
  const key = deriveKey(diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPublicKey }), ephRaw, rawPublic(recipientPublicKey));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', b64u(ephRaw), b64u(iv), b64u(ct), b64u(cipher.getAuthTag())].join('.');
}

/** Throws if the box is malformed, was sealed to another key, or was tampered with. */
export function open(box: string, recipientPrivateKey: KeyObject): string {
  const [version, epk, iv, ct, tag] = box.split('.');
  if (version !== 'v1' || !epk || !iv || !ct || !tag) throw new Error('Unsupported sealed box');
  const ephRaw = Buffer.from(epk, 'base64url');
  const ephPublic = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: epk }, format: 'jwk' });
  const recipientPublic = createPublicKey(recipientPrivateKey);
  const key = deriveKey(diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephPublic }), ephRaw, rawPublic(recipientPublic));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
