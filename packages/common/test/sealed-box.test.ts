import { describe, expect, it } from 'vitest';
import { sealedBox } from '../src/index.js';

describe('sealed box', () => {
  const keys = sealedBox.generateSealingKeyPair();
  const pub = sealedBox.loadSealingPublicKey(keys.publicKey);
  const priv = sealedBox.loadSealingPrivateKey(keys.privateKey);

  it('round-trips and never contains the plaintext', () => {
    const box = sealedBox.seal('482913', pub);
    expect(box).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(box).not.toContain('482913');
    expect(sealedBox.open(box, priv)).toBe('482913');
  });

  it('uses a fresh ephemeral key per box', () => {
    expect(sealedBox.seal('482913', pub)).not.toBe(sealedBox.seal('482913', pub));
  });

  it('cannot be opened with another key', () => {
    const other = sealedBox.loadSealingPrivateKey(sealedBox.generateSealingKeyPair().privateKey);
    expect(() => sealedBox.open(sealedBox.seal('482913', pub), other)).toThrow();
  });

  it('detects tampering', () => {
    const parts = sealedBox.seal('482913', pub).split('.');
    parts[3] = Buffer.from('999999').toString('base64url');
    expect(() => sealedBox.open(parts.join('.'), priv)).toThrow();
  });
});
