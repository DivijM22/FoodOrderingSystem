import type { NotificationContext } from '../models/notification.model.js';

/**
 * Customer-facing order status → email template. Statuses without a template (e.g. pending_payment)
 * produce no email. "Payment confirmed" is part of ORDER_CONFIRMED: the order is confirmed exactly
 * when its payment is verified, so one email covers both (no duplicate for the same transition).
 */
export const TEMPLATE_FOR_STATUS: Record<string, TemplateName | undefined> = {
  confirmed: 'ORDER_CONFIRMED',
  cancelled: 'ORDER_CANCELLED',
  expired: 'ORDER_EXPIRED',
  assigning_delivery_partner: 'DELIVERY_ASSIGNING',
  partner_assigned: 'DELIVERY_PARTNER_ASSIGNED',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  location_reached: 'AGENT_ARRIVED',
  delivered: 'ORDER_DELIVERED',
};

export type TemplateName =
  | 'ORDER_CONFIRMED'
  | 'ORDER_CANCELLED'
  | 'ORDER_EXPIRED'
  | 'DELIVERY_ASSIGNING'
  | 'DELIVERY_PARTNER_ASSIGNED'
  | 'OUT_FOR_DELIVERY'
  | 'AGENT_ARRIVED'
  | 'ORDER_DELIVERED';

/**
 * Delivery code email (restricted workflow). The code is passed in only at render time, in memory;
 * it is never stored, logged or included in any other template.
 */
export function renderOtp(c: { orderNumber: string; customerName: string; agentName: string; otpExpiresAt: string }, otp: string, appName = 'FoodApp'): RenderedEmail {
  const expires = new Date(c.otpExpiresAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const subject = `Your delivery code for order ${c.orderNumber}`;
  const text = [
    `Hi ${c.customerName},`,
    '',
    `${c.agentName} has arrived with your order ${c.orderNumber}.`,
    `Your delivery code is: ${otp}`,
    `It expires at ${expires} IST. Share it with your delivery partner only once you have your order.`,
    'Never share this code on the phone or with anyone else.',
    '',
    `— ${appName}`,
  ].join('\n');
  const html = `<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:560px;margin:auto">
  <h2 style="color:#e23744">Your delivery code</h2>
  <p>Hi ${esc(c.customerName)},</p>
  <p>${esc(c.agentName)} has arrived with your order <strong>${esc(c.orderNumber)}</strong>.</p>
  <p style="font-size:32px;letter-spacing:8px;font-weight:bold;text-align:center">${esc(otp)}</p>
  <p>It expires at ${esc(expires)} IST. Share it with your delivery partner only once you have your order.</p>
  <p style="color:#666">Never share this code on the phone or with anyone else.</p>
  <p style="color:#999;font-size:12px">${esc(appName)} · This is an automated message.</p>
</body></html>`;
  return { subject, text, html };
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Copy {
  subject: (c: NotificationContext) => string;
  headline: string;
  body: (c: NotificationContext) => string[];
  showItems?: boolean;
}

const COPY: Record<TemplateName, Copy> = {
  ORDER_CONFIRMED: {
    subject: (c) => `Payment received: order ${c.orderNumber} is confirmed`,
    headline: 'Your order is confirmed',
    body: (c) => [
      `We've received your payment of ${inr(c.summary.amountPaid ?? c.summary.total)} and ${c.summary.restaurantName} has your order.`,
      `We'll let you know as soon as a delivery partner is on the way.`,
    ],
    showItems: true,
  },
  ORDER_CANCELLED: {
    subject: (c) => `Order ${c.orderNumber} has been cancelled`,
    headline: 'Your order was cancelled',
    body: (c) => [
      c.reason ? `Reason: ${c.reason}` : 'Your order was cancelled.',
      c.previousStatus === 'pending_payment' ? 'You were not charged.' : 'If you paid, your refund is processed automatically to the original payment method.',
    ],
    showItems: true,
  },
  ORDER_EXPIRED: {
    subject: (c) => `Order ${c.orderNumber} expired: payment not completed`,
    headline: 'Your order expired',
    body: () => ['We did not receive payment in time, so the order was released. You have not been charged.', 'You can place a new order at any time.'],
    showItems: true,
  },
  DELIVERY_ASSIGNING: {
    subject: (c) => `Finding a delivery partner for order ${c.orderNumber}`,
    headline: 'Your food is ready',
    body: (c) => [`${c.summary.restaurantName} has prepared your order. We're assigning a delivery partner now.`],
  },
  DELIVERY_PARTNER_ASSIGNED: {
    subject: (c) => `${c.metadata.agentName ?? 'A delivery partner'} will deliver order ${c.orderNumber}`,
    headline: 'Delivery partner assigned',
    body: (c) => [`${c.metadata.agentName ?? 'Your delivery partner'} is heading to ${c.summary.restaurantName} to pick up your order.`],
  },
  OUT_FOR_DELIVERY: {
    subject: (c) => `Order ${c.orderNumber} is out for delivery`,
    headline: 'On the way!',
    body: (c) => [`${c.metadata.agentName ?? 'Your delivery partner'} has picked up your order and is on the way to ${c.summary.deliveryCity}.`],
  },
  AGENT_ARRIVED: {
    subject: (c) => `Your delivery partner has arrived (order ${c.orderNumber})`,
    headline: 'Your delivery partner has arrived',
    body: () => [
      'Please meet your delivery partner. You will receive your one-time delivery code in a separate message.',
      'Only share the code with the delivery partner when you receive your order.',
    ],
  },
  ORDER_DELIVERED: {
    subject: (c) => `Delivered: order ${c.orderNumber}`,
    headline: 'Enjoy your meal!',
    body: (c) => [`Your order from ${c.summary.restaurantName} has been delivered. Thank you for ordering with us.`],
    showItems: true,
  },
};

/** Renders the HTML and plain-text versions of a template. All dynamic values are HTML-escaped. */
export function render(template: TemplateName, c: NotificationContext, appName = 'FoodApp'): RenderedEmail {
  const copy = COPY[template];
  const lines = copy.body(c);
  const items = copy.showItems ? c.summary.items : [];
  const subject = copy.subject(c);

  const text = [
    `Hi ${c.customerName},`,
    '',
    copy.headline,
    ...lines,
    '',
    ...(items.length ? [`Order ${c.orderNumber} — ${c.summary.restaurantName}`, ...items.map((i) => `  ${i.quantity} × ${i.name}  ${inr(i.lineTotal)}`), `  Total: ${inr(c.summary.total)}`, ''] : [`Order ${c.orderNumber}`, '']),
    `— ${appName}`,
  ].join('\n');

  const itemRows = items
    .map((i) => `<tr><td style="padding:4px 8px">${i.quantity} × ${esc(i.name)}</td><td style="padding:4px 8px;text-align:right">${inr(i.lineTotal)}</td></tr>`)
    .join('');
  const html = `<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:560px;margin:auto">
  <h2 style="color:#e23744">${esc(copy.headline)}</h2>
  <p>Hi ${esc(c.customerName)},</p>
  ${lines.map((l) => `<p>${esc(l)}</p>`).join('\n  ')}
  <p style="color:#666">Order <strong>${esc(c.orderNumber)}</strong> · ${esc(c.summary.restaurantName)}</p>
  ${items.length ? `<table style="border-collapse:collapse;width:100%">${itemRows}<tr><td style="padding:4px 8px"><strong>Total</strong></td><td style="padding:4px 8px;text-align:right"><strong>${inr(c.summary.total)}</strong></td></tr></table>` : ''}
  <p style="color:#999;font-size:12px">${esc(appName)} · This is an automated message.</p>
</body></html>`;
  return { subject, text, html };
}
