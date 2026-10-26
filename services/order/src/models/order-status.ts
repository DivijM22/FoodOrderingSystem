
/**
 * Order lifecycle (state machine). The Order Service is the only writer; other services publish facts.
 *
 *   pending_payment ─payment.succeeded─► confirmed ─delivery.ready_for_pickup─► assigning_delivery_partner
 *      │   └─deadline─► expired            │   ─delivery.partner_assigned─► partner_assigned
 *      └─cancel─► cancelled ◄──────────────┘   ─delivery.picked_up─► out_for_delivery
 *                                              ─delivery.location_reached─► location_reached
 *                                              ─delivery.completed─► delivered
 *
 * Legacy values (preparing, ready_for_pickup, payment_failed) exist only in historical documents.
 */
export const ORDER_STATUSES = [
  'pending_payment',
  'confirmed',
  'assigning_delivery_partner',
  'partner_assigned',
  'out_for_delivery',
  'location_reached',
  'delivered',
  'cancelled',
  'expired',
  // legacy (pre-event-driven delivery); never entered any more
  'preparing',
  'ready_for_pickup',
  'payment_failed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Post-payment progression, in order. Delivery events may only move an order forward along this list. */
export const FULFILMENT_FLOW: readonly OrderStatus[] = [
  'confirmed',
  'assigning_delivery_partner',
  'partner_assigned',
  'out_for_delivery',
  'location_reached',
  'delivered',
];

/** Statuses from which each kind of actor may cancel. Customers may cancel only before a partner is being assigned. */
export const CANCELLABLE_BY: Record<'customer' | 'restaurant' | 'platform', OrderStatus[]> = {
  customer: ['pending_payment', 'confirmed'],
  restaurant: ['pending_payment', 'confirmed', 'assigning_delivery_partner'],
  platform: ['pending_payment', 'confirmed', 'assigning_delivery_partner', 'partner_assigned'],
};

export function isTerminal(status: OrderStatus): boolean {
  return ['delivered', 'cancelled', 'expired', 'payment_failed'].includes(status);
}


/** Human labels for progress trackers and emails. */
export const STATUS_LABELS: Partial<Record<OrderStatus, string>> = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Order confirmed',
  assigning_delivery_partner: 'Assigning a delivery partner',
  partner_assigned: 'Delivery partner assigned',
  out_for_delivery: 'Out for delivery',
  location_reached: 'Delivery partner has arrived',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  expired: 'Expired (not paid in time)',
};

/** Mirror of the Payment Service's outcome, updated only from payment.* events (plus refund_pending on cancel). */
export const PAYMENT_STATUSES = [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refund_pending',
  'partially_refunded',
  'refunded',
  'refund_failed',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];



/** Mirrored payment statuses that still count as "unpaid" for expiry (a failed attempt never paid). */
export const EXPIRABLE_PAYMENT_STATUSES: PaymentStatus[] = ['pending', 'failed'];

/**
 * Allowed changes of the mirrored paymentStatus. Anything else (e.g. a late payment.failed after
 * the order was paid) is ignored, so duplicate or out-of-order payment events can never regress it.
 */
export const PAYMENT_STATUS_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ['paid', 'failed', 'cancelled', 'refund_pending'],
  failed: ['paid', 'failed', 'cancelled', 'refund_pending'],
  paid: ['refund_pending', 'partially_refunded', 'refunded', 'refund_failed'],
  refund_pending: ['partially_refunded', 'refunded', 'refund_failed'],
  partially_refunded: ['refund_pending', 'partially_refunded', 'refunded', 'refund_failed'],
  refund_failed: ['refund_pending', 'partially_refunded', 'refunded', 'refund_failed'],
  cancelled: [],
  refunded: [],
};
