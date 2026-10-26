import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Six digits from the OS CSPRNG (uniform; randomInt avoids modulo bias). */
export const generateOtp = (): string => randomInt(0, 1_000_000).toString().padStart(6, '0');

/**
 * Keyed verifier bound to the delivery and the OTP's sequence, so a stored verifier is useless for
 * another delivery or reissue, and a leaked database alone cannot be brute-forced offline (no key).
 */
export function otpVerifier(key: string, deliveryId: string, sequence: number, otp: string): string {
  return createHmac('sha256', key).update(`delivery-otp:v1:${deliveryId}:${sequence}:${otp}`).digest('hex');
}

/** Constant-time comparison of a submitted code against the stored verifier. */
export function otpMatches(key: string, deliveryId: string, sequence: number, submitted: string, verifier: string): boolean {
  const a = Buffer.from(otpVerifier(key, deliveryId, sequence, submitted), 'hex');
  const b = Buffer.from(verifier, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
