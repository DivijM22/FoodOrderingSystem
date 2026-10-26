import { randomUUID } from 'node:crypto';
import { createEnvelope, EventTypes, type EventEnvelope } from '@food/common';
import type { Mailer, MailResult, OutgoingEmail } from '../src/services/mailer.js';

export const oid = () => randomUUID().replaceAll('-', '').slice(0, 24);

let seq = 0;

/** An order.status_changed.v1 envelope as the Order Service publishes it. */
export function statusChanged(
  orderId: string,
  status: string,
  overrides: { previousStatus?: string | null; reason?: string; email?: string; metadata?: Record<string, string> } = {},
): EventEnvelope {
  return createEnvelope({
    eventType: EventTypes.OrderStatusChanged,
    version: 1,
    source: 'order-service',
    data: {
      orderId,
      orderNumber: `ORD-261016-${orderId.slice(-6).toUpperCase()}`,
      customerId: 'cust-1',
      customerEmail: overrides.email ?? 'asha@example.com',
      customerName: 'Asha <Rao>',
      status,
      previousStatus: overrides.previousStatus === undefined ? 'pending_payment' : overrides.previousStatus,
      sequence: ++seq,
      changedAt: new Date().toISOString(),
      ...(overrides.reason ? { reason: overrides.reason } : {}),
      cause: { eventId: randomUUID(), service: 'order-service' },
      summary: {
        restaurantName: 'Spice & Co',
        items: [
          { name: 'Paneer Tikka', quantity: 2, lineTotal: 49800 },
          { name: 'Naan', quantity: 3, lineTotal: 13500 },
        ],
        currency: 'INR',
        total: 67300,
        amountPaid: 67300,
        deliveryCity: 'Manipal',
      },
      metadata: overrides.metadata ?? {},
    },
  });
}

/** In-memory mailer whose availability can be toggled to simulate SMTP outages. */
export class FakeMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  failWith?: Error;
  hang = false;

  async send(email: OutgoingEmail): Promise<MailResult> {
    if (this.hang) return new Promise(() => undefined);
    if (this.failWith) throw this.failWith;
    this.sent.push(email);
    return { messageId: email.messageId, response: '250 OK' };
  }

  async verify() {
    return !this.failWith;
  }
}
