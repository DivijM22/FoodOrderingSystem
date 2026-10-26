import { describe, expect, it } from 'vitest';
import { canApplyRefundOutcome, canTransition, CAPTURED, PAYMENT_STATUSES } from '../src/models/payment-status.js';
import { intentTarget } from '../src/services/workflow.js';

describe('payment state machine', () => {
  it('never lets a PaymentIntent update change a captured payment', () => {
    for (const from of CAPTURED) {
      for (const to of ['succeeded', 'failed', 'processing', 'requires_action', 'cancelled'] as const) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
      }
    }
  });

  it('keeps cancelled terminal and refunded terminal for lifecycle updates', () => {
    for (const to of PAYMENT_STATUSES) {
      expect(canTransition('cancelled', to)).toBe(false);
      expect(canTransition('refunded', to)).toBe(false);
    }
  });

  it('allows retry after failure and refunds only from captured states', () => {
    expect(canTransition('failed', 'requires_action')).toBe(true);
    expect(canTransition('succeeded', 'refund_pending')).toBe(true);
    expect(canTransition('requires_action', 'refund_pending')).toBe(false);
  });

  it('applies refund outcomes only to refund states (incl. Stripe refund reversal)', () => {
    expect(canApplyRefundOutcome('refund_pending', 'refunded')).toBe(true);
    expect(canApplyRefundOutcome('refunded', 'succeeded')).toBe(true); // reversal
    expect(canApplyRefundOutcome('succeeded', 'refunded')).toBe(false);
    expect(canApplyRefundOutcome('requires_action', 'succeeded')).toBe(false);
  });

  it('maps Stripe PaymentIntent statuses', () => {
    const base = { id: 'pi', amount: 1, currency: 'inr', metadata: {} };
    expect(intentTarget({ ...base, status: 'requires_payment_method' })).toBe('requires_action');
    expect(intentTarget({ ...base, status: 'requires_payment_method', lastError: { message: 'declined' } })).toBe('failed');
    expect(intentTarget({ ...base, status: 'requires_action' })).toBe('requires_action');
    expect(intentTarget({ ...base, status: 'processing' })).toBe('processing');
    expect(intentTarget({ ...base, status: 'succeeded' })).toBe('succeeded');
    expect(intentTarget({ ...base, status: 'canceled' })).toBe('cancelled');
  });
});
