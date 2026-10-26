import { api } from './client';

export interface AgentDelivery {
  id: string;
  orderId: string;
  orderNumber: string | null;
  status: 'preparing' | 'awaiting_partner' | 'partner_assigned' | 'picked_up' | 'arrived' | 'delivered' | 'cancelled' | 'assignment_failed';
  restaurantName: string | null;
  customerName: string | null;
  deliveryAddress: { line1: string; line2?: string; city: string; pincode: string; landmark?: string } | null;
  items: { name: string; quantity: number }[];
  agent: { id: string; name: string | null; phoneMasked: string | null } | null;
  timestamps: Record<'createdAt' | 'assignedAt' | 'pickedUpAt' | 'arrivedAt' | 'deliveredAt' | 'cancelledAt', string | null>;
  cancellation: { reason?: string } | null;
  /** Never the code itself: only its state. */
  otp: { status: string; expiresAt: string; attemptsRemaining: number } | null;
  otpIssues: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  status: 'available' | 'busy' | 'offline';
  activeDeliveryId: string | null;
  completedDeliveries: number;
  activeDelivery?: AgentDelivery | null;
}

/** Delivery partner API. The agent's identity always comes from the JWT; no request names an agent. */
export const deliveriesApi = {
  /** 404 until the agent has registered (PUT with a phone number). */
  me: () => api.get<AgentProfile>('/deliveries/agents/me'),
  updateMe: (body: { phone?: string; available?: boolean }) => api.put<AgentProfile>('/deliveries/agents/me', body),
  list: (q: { page?: number; limit?: number; status?: string } = {}) => api.get<AgentDelivery[]>('/deliveries', { query: { limit: 20, ...q } }),
  get: (id: string) => api.get<AgentDelivery>(`/deliveries/${id}`),
  pickup: (id: string) => api.post<AgentDelivery>(`/deliveries/${id}/pickup`),
  arrived: (id: string) => api.post<AgentDelivery>(`/deliveries/${id}/arrived`),
  /** The Delivery Service verifies the code; the app never sees or stores it. */
  verifyOtp: (id: string, otp: string) => api.post<AgentDelivery>(`/deliveries/${id}/verify-otp`, { otp }),
  resendOtp: (id: string) => api.post<AgentDelivery>(`/deliveries/${id}/resend-otp`),
};
