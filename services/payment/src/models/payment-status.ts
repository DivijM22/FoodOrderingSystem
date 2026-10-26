/**
 * Payment state machine (adapted to Stripe's PaymentIntent lifecycle).
 *
 *   pending ──initiate──► requires_action ──► processing ──► succeeded ──► refund_pending ──► refunded
 *      │                    │    ▲    │           │                  ▲         │
 *      │                    ▼    │    ▼           ▼                  │         └──► partially_refunded
 *      │                  failed ┘  (retry with the same PaymentIntent)          │
 *      └──────────► cancelled ◄── (PaymentIntent cancelled, confirmed by Stripe)  └──► refund_pending …
 *
 * - Captured states never change because of PaymentIntent updates (late/replayed webhooks are ignored).
 * - `refunded` and `cancelled` are terminal, except that Stripe may *reverse* a refund it reported as
 *   succeeded (signed `refund.failed` for a refund we recorded) — see REFUND_OUTCOME_TRANSITIONS.
 */
export const PAYMENT_STATUSES = [
  'pending',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'refund_pending',
  'partially_refunded',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = ['none', 'pending', 'succeeded', 'failed'] as const;
export type RefundStatusSummary = (typeof REFUND_STATUSES)[number];

/**
 * Lifecycle transitions driven by PaymentIntent updates (webhooks, polling, initiation) and by
 * refund *requests*. Once money is captured, PaymentIntent updates can no longer change anything,
 * so a delayed or replayed webhook can never regress a succeeded/refunded payment.
 */
const T: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ['requires_action', 'cancelled'],
  requires_action: ['requires_action', 'processing', 'succeeded', 'failed', 'cancelled'],
  processing: ['succeeded', 'failed', 'cancelled'],
  failed: ['requires_action', 'processing', 'succeeded', 'failed', 'cancelled'],
  succeeded: ['refund_pending'],
  partially_refunded: ['refund_pending'],
  refund_pending: [],
  refunded: [],
  cancelled: [],
};

/**
 * Transitions allowed only when the provider reports the outcome of a refund *we created*
 * (matched by refund id). Includes Stripe's refund reversal (succeeded → failed later).
 */
const REFUND_OUTCOME: Record<PaymentStatus, PaymentStatus[]> = {
  refund_pending: ['refunded', 'partially_refunded', 'succeeded'],
  partially_refunded: ['partially_refunded', 'succeeded'],
  refunded: ['partially_refunded', 'succeeded'],
  pending: [],
  requires_action: [],
  processing: [],
  failed: [],
  succeeded: [],
  cancelled: [],
};

export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = T;
export const REFUND_OUTCOME_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = REFUND_OUTCOME;

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return T[from].includes(to);
}

export function canApplyRefundOutcome(from: PaymentStatus, to: PaymentStatus): boolean {
  return REFUND_OUTCOME[from].includes(to);
}

/** States in which money has been captured. */
export const CAPTURED: readonly PaymentStatus[] = ['succeeded', 'refund_pending', 'partially_refunded', 'refunded'];
/** States with a live PaymentIntent that could still be charged. */
export const OPEN_INTENT: readonly PaymentStatus[] = ['requires_action', 'processing', 'failed'];
