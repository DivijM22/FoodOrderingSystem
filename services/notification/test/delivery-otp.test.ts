import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createEnvelope, EventTypes, PermanentEventError, sealedBox } from '@food/common';
import { NotificationModel } from '../src/models/notification.model.js';
import { handleOtpCommand, Sender } from '../src/services/notifier.js';
import { FakeMailer, oid } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();

const keys = sealedBox.generateSealingKeyPair();
const pub = sealedBox.loadSealingPublicKey(keys.publicKey);
const privateKey = sealedBox.loadSealingPrivateKey(keys.privateKey);
const opts = { maxAttempts: 8, privateKey };

/** Captures every log line so tests can prove the code never reaches the logs. */
function capturingLogger() {
  const lines: string[] = [];
  const logger = pino({ level: 'trace' }, new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } }));
  return { logger, lines };
}

function otpCommand(deliveryId: string, code: string, overrides: { sequence?: number; expiresInMs?: number; key?: typeof pub } = {}) {
  return createEnvelope({
    eventType: EventTypes.DeliveryOtpNotification,
    version: 1,
    source: 'delivery-service',
    data: {
      deliveryId,
      orderId: oid(),
      orderNumber: 'ORD-261017-ABC123',
      customerId: 'cust-1',
      customerEmail: 'asha@example.com',
      customerName: 'Asha',
      agentName: 'Ravi K.',
      otpSequence: overrides.sequence ?? 1,
      otpCiphertext: sealedBox.seal(code, overrides.key ?? pub),
      otpExpiresAt: new Date(Date.now() + (overrides.expiresInMs ?? 300_000)).toISOString(),
    },
  });
}

const sender = (mailer: FakeMailer, logger = capturingLogger().logger) => new Sender(mailer, logger, { intervalMs: 60_000, leaseMs: 60_000, appName: 'FoodApp', otpPrivateKey: privateKey });

describe('delivery code emails (restricted workflow)', () => {
  it('stores only the sealed code, emails the code once, then deletes the sealed copy', async () => {
    const deliveryId = oid();
    const cmd = otpCommand(deliveryId, '482913');
    expect(await handleOtpCommand(cmd, opts)).toBe('queued');
    expect(await handleOtpCommand(cmd, opts)).toBe('duplicate');
    const stored = (await NotificationModel.findOne({ template: 'DELIVERY_OTP' }).select('+secretCiphertext').lean())!;
    expect(stored.secretCiphertext).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain('482913');

    const mailer = new FakeMailer();
    const { logger, lines } = capturingLogger();
    await sender(mailer, logger).run();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: 'asha@example.com', subject: expect.stringContaining('delivery code') });
    expect(mailer.sent[0]!.text).toContain('482913');
    expect(mailer.sent[0]!.html).toContain('482913');
    const after = (await NotificationModel.findOne({ template: 'DELIVERY_OTP' }).select('+secretCiphertext').lean())!;
    expect(after.status).toBe('sent');
    expect(after.secretCiphertext).toBeUndefined();
    expect(lines.join('\n')).not.toContain('482913');
  });

  it('rejects codes sealed to another key (dead-letter, nothing stored)', async () => {
    const other = sealedBox.loadSealingPublicKey(sealedBox.generateSealingKeyPair().publicKey);
    await expect(handleOtpCommand(otpCommand(oid(), '111111', { key: other }), opts)).rejects.toBeInstanceOf(PermanentEventError);
    expect(await NotificationModel.countDocuments()).toBe(0);
  });

  it('never sends an expired code', async () => {
    await handleOtpCommand(otpCommand(oid(), '222222', { expiresInMs: 1 }), opts);
    await new Promise((r) => setTimeout(r, 10));
    const mailer = new FakeMailer();
    await sender(mailer).run();
    expect(mailer.sent).toHaveLength(0);
    const n = (await NotificationModel.findOne().select('+secretCiphertext').lean())!;
    expect(n).toMatchObject({ status: 'failed', lastError: expect.stringContaining('expired') });
    expect(n.secretCiphertext).toBeUndefined();
  });

  it('a reissued code supersedes an unsent older one', async () => {
    const deliveryId = oid();
    await handleOtpCommand(otpCommand(deliveryId, '333333', { sequence: 1 }), opts);
    await handleOtpCommand(otpCommand(deliveryId, '444444', { sequence: 2 }), opts);
    const mailer = new FakeMailer();
    await sender(mailer).run();
    expect(mailer.sent.map((m) => m.text.includes('444444'))).toEqual([true]);
    expect((await NotificationModel.findOne({ 'context.otpSequence': 1 }).lean())!.status).toBe('failed');
  });

  it('SMTP outage: retried quickly while the code is valid, delivered after recovery', async () => {
    await handleOtpCommand(otpCommand(oid(), '555555'), opts);
    const mailer = new FakeMailer();
    mailer.failWith = new Error('connect ECONNREFUSED mailpit:1025');
    const s = sender(mailer);
    await s.run();
    const n = (await NotificationModel.findOne().lean())!;
    expect(n).toMatchObject({ status: 'pending', attempts: 1 });
    expect(n.nextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(15_000);
    mailer.failWith = undefined;
    await NotificationModel.updateOne({}, { $set: { nextAttemptAt: new Date() } });
    await s.run();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.text).toContain('555555');
  });

  it('without the private key the code stays sealed and pending (no plaintext fallback)', async () => {
    await handleOtpCommand(otpCommand(oid(), '666666'), opts);
    const mailer = new FakeMailer();
    await new Sender(mailer, capturingLogger().logger, { intervalMs: 60_000, leaseMs: 60_000, appName: 'FoodApp' }).run();
    expect(mailer.sent).toHaveLength(0);
    expect((await NotificationModel.findOne().lean())!.status).toBe('pending');
  });
});
