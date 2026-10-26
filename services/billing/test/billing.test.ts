import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { OutboxModel, PermanentEventError, eventDataSchemas, EventTypes } from '@food/common';
import { handleBillingEvent } from '../src/consumers/events.js';
import { BillingEntryModel } from '../src/models/entry.model.js';
import { ImmutableRecordError } from '../src/models/immutable.js';
import { InvoiceModel } from '../src/models/invoice.model.js';
import { seedDiscounts } from '../src/seed/discounts.js';
import { billable, events, harness, userToken } from './helpers.js';
import { useTestDatabase } from './setup.js';

useTestDatabase();
const h = harness();
const handle = (e: Parameters<typeof handleBillingEvent>[1]) => handleBillingEvent(h.billing, e);
const view = async (c: { header: Record<string, string> }, orderId: string) => (await request(h.app).get(`/invoices/order/${orderId}`).set(c.header)).body.data;

beforeEach(async () => {
  await seedDiscounts();
});

describe('invoice issuance from order.created', () => {
  it('issues one itemised invoice and publishes billing.finalized.v1', async () => {
    const c = h.customer();
    const o = billable(c.id);
    expect(await handle(events.orderCreated(o))).toBe('processed');
    const inv = await view(c, o.orderId);
    expect(inv).toMatchObject({ orderId: o.orderId, itemsSubtotal: 70700, subtotal: 70700, discountAmount: 0, taxAmount: 0, finalAmount: 70700, status: 'open', amountDue: 70700, schemaVersion: 1 });
    expect(inv.invoiceNumber).toMatch(/^INV-\d{6}-[A-Z2-9]{6}$/);
    expect(inv.lines).toHaveLength(2);
    const evt = await OutboxModel.findOne({ eventType: 'billing.finalized' }).lean();
    const data = eventDataSchemas[EventTypes.BillingFinalized].parse(evt!.envelope.data);
    expect(data).toMatchObject({ invoiceId: inv.id, invoiceVersion: 1, finalAmount: 70700, taxAmount: 0, currency: 'INR' });
    expect(data.expiresAt).toBeTruthy(); // carried from order.created so Payment needs no Order call
    expect(await OutboxModel.countDocuments({ eventType: 'billing.invoice_generated' })).toBe(0); // old name no longer published
  });

  it('is idempotent for redelivered and duplicate order.created events', async () => {
    const o = billable(h.customer().id);
    const e = events.orderCreated(o);
    await handle(e);
    expect(await handle(e)).toBe('duplicate');
    expect(await handle(events.orderCreated(o))).toBe('processed'); // distinct event, same order
    expect(await InvoiceModel.countDocuments({ orderId: o.orderId })).toBe(1);
    expect(await OutboxModel.countDocuments({ eventType: 'billing.finalized' })).toBe(1);
  });

  it('applies a valid discount code and records why an invalid one was not applied', async () => {
    const c = h.customer();
    const good = billable(c.id, { discountCode: 'FEAST20' });
    const bad = billable(c.id, { discountCode: 'MONSOON15' });
    await handle(events.orderCreated(good));
    await handle(events.orderCreated(bad));
    expect(await view(c, good.orderId)).toMatchObject({ discountAmount: 14140, finalAmount: 56560, discount: { code: 'FEAST20' } });
    expect(await view(c, bad.orderId)).toMatchObject({ discountAmount: 0, finalAmount: 70700, discountRejection: { code: 'MONSOON15', reason: 'EXPIRED' } });
  });

  it('refuses orders whose arithmetic does not add up (no invoice, dead-lettered)', async () => {
    const o = billable(h.customer().id, { subtotal: 1 });
    await expect(handle(events.orderCreated(o))).rejects.toBeInstanceOf(PermanentEventError);
    expect(await InvoiceModel.countDocuments()).toBe(0);
  });
});

describe('immutability', () => {
  it('rejects every update and delete of invoices and ledger entries', async () => {
    const o = billable(h.customer().id);
    await handle(events.orderCreated(o));
    await handle(events.paymentSucceeded(o, 70700));
    await expect(InvoiceModel.updateOne({ orderId: o.orderId }, { $set: { finalAmount: 1 } })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(InvoiceModel.findOneAndUpdate({ orderId: o.orderId }, { $set: { finalAmount: 1 } })).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(InvoiceModel.deleteOne({ orderId: o.orderId })).rejects.toBeInstanceOf(ImmutableRecordError);
    const doc = (await InvoiceModel.findOne({ orderId: o.orderId }))!;
    doc.finalAmount = 1;
    await expect(doc.save()).rejects.toBeInstanceOf(ImmutableRecordError);
    await expect(BillingEntryModel.deleteMany({})).rejects.toBeInstanceOf(ImmutableRecordError);
    expect((await InvoiceModel.findOne({ orderId: o.orderId }).lean())!.finalAmount).toBe(70700);
  });
});

describe('ledger adjustments (derived invoice status)', () => {
  it('payment → paid; duplicates never double-count', async () => {
    const c = h.customer();
    const o = billable(c.id);
    await handle(events.orderCreated(o));
    const paid = events.paymentSucceeded(o, 70700);
    await handle(paid);
    await handle(paid);
    await handle(events.paymentSucceeded(o, 70700)); // same paymentId, new event id
    expect(await view(c, o.orderId)).toMatchObject({ status: 'paid', amountPaid: 70700, amountDue: 0 });
    expect(await BillingEntryModel.countDocuments({ kind: 'payment' })).toBe(1);
  });

  it('refunds create credit notes; partial then full; reversal restores', async () => {
    const c = h.customer();
    const o = billable(c.id);
    await handle(events.orderCreated(o));
    await handle(events.paymentSucceeded(o, 70700));
    await handle(events.refundCompleted(o, 20000, 20000, false, 'ref_a'));
    expect(await view(c, o.orderId)).toMatchObject({ status: 'partially_refunded', amountRefunded: 20000, netCollected: 50700 });
    await handle(events.refundCompleted(o, 50700, 70700, true, 'ref_b'));
    const inv = await view(c, o.orderId);
    expect(inv).toMatchObject({ status: 'refunded', amountRefunded: 70700, netCollected: 0 });
    expect(inv.adjustments.filter((a: { kind: string }) => a.kind === 'refund').every((a: { documentNumber: string }) => /^CN-/.test(a.documentNumber))).toBe(true);
    await handle(events.refundFailed(o, 50700, 'ref_b')); // Stripe reversed the second refund
    expect(await view(c, o.orderId)).toMatchObject({ status: 'partially_refunded', amountRefunded: 20000 });
    await handle(events.refundFailed(o, 999, 'ref_never_completed'));
    expect(await BillingEntryModel.countDocuments({ kind: 'refund_reversal' })).toBe(1);
  });

  it('cancellation or expiry before payment voids the invoice (once, whichever arrives first)', async () => {
    const c = h.customer();
    const a = billable(c.id);
    const b = billable(c.id);
    await handle(events.orderCreated(a));
    await handle(events.orderCreated(b));
    await handle(events.orderCancelled(a));
    await handle(events.orderExpired(b));
    await handle(events.orderCancelled(b));
    expect(await view(c, a.orderId)).toMatchObject({ status: 'void', amountDue: 0 });
    expect(await view(c, b.orderId)).toMatchObject({ status: 'void' });
    expect(await BillingEntryModel.countDocuments({ kind: 'closure', orderId: b.orderId })).toBe(1);
  });

  it('cancellation after payment keeps the money on the books until the refund lands', async () => {
    const c = h.customer();
    const o = billable(c.id);
    await handle(events.orderCreated(o));
    await handle(events.paymentSucceeded(o, 70700));
    await handle(events.orderCancelled(o));
    expect((await view(c, o.orderId)).status).toBe('paid');
    await handle(events.refundCompleted(o, 70700, 70700, true));
    expect((await view(c, o.orderId)).status).toBe('refunded');
  });

  it('handles delayed / out-of-order events: closure before the invoice, then the invoice', async () => {
    const c = h.customer();
    const o = billable(c.id);
    await handle(events.orderExpired(o)); // order.created delayed
    await handle(events.orderCreated(o));
    expect(await view(c, o.orderId)).toMatchObject({ status: 'void', amountDue: 0 });
  });

  it('flags payments that do not match the invoice amount', async () => {
    const c = h.customer();
    const o = billable(c.id);
    await handle(events.orderCreated(o));
    await handle(events.paymentSucceeded(o, 1234));
    const inv = await view(c, o.orderId);
    expect(inv.adjustments[0].anomaly).toMatch(/≠ invoice finalAmount 70700/);
  });
});

describe('REST access control', () => {
  it('has no issue-on-demand endpoint any more (Payment waits for billing.finalized)', async () => {
    const c = h.customer();
    const o = billable(c.id);
    expect((await request(h.app).post(`/invoices/order/${o.orderId}/issue`).set(c.header)).status).toBe(404);
  });

  it('hides other customers’ invoices and requires authentication', async () => {
    const owner = h.customer();
    const other = h.customer();
    const o = billable(owner.id);
    await handle(events.orderCreated(o));
    expect((await request(h.app).get(`/invoices/order/${o.orderId}`).set(other.header)).status).toBe(404);
    expect((await request(h.app).get(`/invoices/order/${o.orderId}`)).status).toBe(401);
    expect((await request(h.app).get('/invoices').set(owner.header)).body.meta.total).toBe(1);
    expect((await request(h.app).get('/invoices').set(userToken('platform_admin').header)).body.meta.total).toBe(1);
  });
});

describe('discounts API', () => {
  it('lists only usable codes publicly; admins manage codes', async () => {
    const pub = await request(h.app).get('/discounts');
    const codes = pub.body.data.map((d: { code: string }) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['WELCOME50', 'FEAST20', 'FLAT100']));
    expect(codes).not.toContain('MONSOON15');
    expect(codes).not.toContain('PAUSED25');

    const admin = userToken('platform_admin');
    const created = await request(h.app).post('/discounts').set(admin.header).send({ code: 'diwali30', description: '30% off Diwali', type: 'percent', value: 30, maxDiscount: 20000 });
    expect(created.status).toBe(201);
    expect(created.body.data.code).toBe('DIWALI30');
    expect((await request(h.app).post('/discounts').set(admin.header).send({ code: 'DIWALI30', description: 'dup', type: 'flat', value: 100 })).status).toBe(409);
    expect((await request(h.app).post('/discounts').set(admin.header).send({ code: 'BAD', description: 'too much', type: 'percent', value: 150 })).status).toBe(400);
    expect((await request(h.app).patch('/discounts/DIWALI30').set(admin.header).send({ active: false })).body.data.active).toBe(false);
    expect((await request(h.app).post('/discounts').set(h.customer().header).send({ code: 'FREE', description: 'x', type: 'flat', value: 1 })).status).toBe(403);
  });

  it('seeding is idempotent', async () => {
    expect(await seedDiscounts()).toBe(0);
  });
});
