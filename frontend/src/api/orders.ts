import { api } from './client';
import type { Address, Invoice, Order, Payment, Tracking } from './types';

export const ordersApi = {
  /** Prices are never sent: the Order Service prices the items from its own catalog data. */
  place: (body: { restaurantId: string; items: { menuItemId: string; quantity: number }[]; deliveryAddress: Address; notes?: string }, idempotencyKey: string) =>
    api.post<Order>('/orders', body, { headers: { 'Idempotency-Key': idempotencyKey } }),
  list: (q: { restaurantId?: string; status?: string; page?: number; limit?: number } = {}) => api.get<Order[]>('/orders', { query: { limit: 20, ...q } }),
  get: (id: string) => api.get<Order>(`/orders/${id}`),
  tracking: (id: string) => api.get<Tracking>(`/orders/${id}/tracking`),
  cancel: (id: string, reason: string) => api.post<Order>(`/orders/${id}/cancel`, { reason }),
};

export const billingApi = {
  /** 404 until the Billing Service has issued the invoice (asynchronously, from order.created). */
  invoiceForOrder: (orderId: string) => api.get<Invoice>(`/invoices/order/${orderId}`),
};

export const paymentsApi = {
  forOrder: (orderId: string) => api.get<Payment>(`/payments/order/${orderId}`),
  /** 409 BILLING_PENDING (with Retry-After) until Billing has finalized the amount. */
  initiate: (orderId: string) => api.post<{ payment: Payment; provider: string; testMode: boolean }>('/payments/initiate', { orderId }),
  /** Mock provider only (ENABLE_TEST_ENDPOINTS): plays the customer's card step; the outcome arrives via a signed webhook. */
  simulate: (paymentId: string, outcome: 'succeed' | 'fail') => api.post<unknown>(`/payments/${paymentId}/simulate`, { outcome }),
};
