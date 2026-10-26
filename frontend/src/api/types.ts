// Response shapes of the backend (see API.md / docs/openapi.json). Money is always integer paise.

export const ROLES = ['customer', 'restaurant_admin', 'delivery_agent', 'platform_admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  customer: 'Customer',
  restaurant_admin: 'Restaurant administrator',
  delivery_agent: 'Delivery agent',
  platform_admin: 'Platform administrator',
};

export interface Address {
  id?: string;
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  pincode: string;
  landmark?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  phone: string | null;
  addresses: Address[];
  isActive?: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
}

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
  user: User;
}

// ---------------------------------------------------------------- catalog
export interface Restaurant {
  id: string;
  name: string;
  slug: string;
  description: string;
  cuisines: string[];
  tags: string[];
  address: { line1: string; area: string; city: string; pincode: string };
  /** Present only for platform admins and the restaurant's own administrators. */
  adminIds?: string[];
  isOpen: boolean;
  status: 'active' | 'inactive';
  isPureVeg: boolean;
  rating: number;
  ratingCount: number;
  costForTwo: number;
  avgDeliveryMinutes: number;
  openingHours: { opens: string; closes: string };
  imageUrl: string | null;
}

export interface MenuItem {
  id: string;
  restaurantId: string;
  name: string;
  description: string;
  category: string;
  price: number;
  isVeg: boolean;
  isAvailable: boolean;
  isBestseller: boolean;
  spiceLevel: number;
  imageUrl: string | null;
}

export interface Menu {
  restaurant: { id: string; name: string; isOpen: boolean; status: string; isPureVeg: boolean };
  categories: string[];
  items: MenuItem[];
}

// ---------------------------------------------------------------- orders
export type OrderStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'assigning_delivery_partner'
  | 'partner_assigned'
  | 'out_for_delivery'
  | 'location_reached'
  | 'delivered'
  | 'cancelled'
  | 'expired'
  | 'preparing'
  | 'ready_for_pickup'
  | 'payment_failed';

export interface HistoryEntry {
  status: OrderStatus;
  at: string;
  sourceEventId: string | null;
  sourceService: string | null;
  by?: string;
  role?: string;
  note?: string;
  metadata?: Record<string, string>;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  restaurantId: string;
  restaurantName: string;
  items: { menuItemId: string; name: string; unitPrice: number; isVeg?: boolean; quantity: number; lineTotal: number }[];
  subtotal: number;
  deliveryFee: number;
  provisionalTotal: number;
  currency: 'INR';
  status: OrderStatus;
  paymentStatus: string;
  statusHistory: HistoryEntry[];
  paymentId: string | null;
  amountPaid: number | null;
  deliveryAddress: Address;
  delivery: { deliveryId: string; status: string; agent: { id?: string; name: string; phoneMasked?: string } | null; otpExpiresAt: string | null; failureReason: string | null } | null;
  notes: string | null;
  cancellation: { reason: string; by?: string; role?: string; at?: string } | null;
  discountCode: string | null;
  /** Billing's final payable amount (null until the invoice is issued). */
  billing: { invoiceId: string; invoiceNumber: string; discountAmount: number; taxAmount: number; finalAmount: number; issuedAt: string } | null;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Tracking {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  statusLabel: string;
  paymentStatus: string;
  deliveryStatus: string | null;
  deliveryPartner: { name: string; phoneMasked: string | null } | null;
  deliveryCodeExpiresAt: string | null;
  deliveryIssue: string | null;
  terminal: boolean;
  completed: boolean;
  settled: boolean;
  sequence: number;
  steps: { status: OrderStatus; label: string; reached: boolean; at: string | null; current: boolean }[];
  history: HistoryEntry[];
  expiresAt: string | null;
}

// ---------------------------------------------------------------- billing + payments
export interface Invoice {
  id: string;
  invoiceNumber: string;
  orderId: string;
  orderNumber: string;
  restaurantName: string;
  lines: { kind: 'item' | 'delivery_fee'; description: string; unitPrice: number; quantity: number; lineTotal: number }[];
  itemsSubtotal: number;
  deliveryFee: number;
  subtotal: number;
  discount: { code: string; description?: string } | null;
  discountRejection: { code?: string; reason: string } | null;
  discountAmount: number;
  taxAmount: number;
  finalAmount: number;
  status: 'open' | 'paid' | 'partially_refunded' | 'refunded' | 'void';
  amountPaid: number;
  amountRefunded: number;
  amountDue: number;
  issuedAt: string;
}

export interface Payment {
  id: string;
  orderId: string;
  orderNumber: string;
  amount: number | null;
  invoiceNumber: string | null;
  currency: 'INR';
  status: 'pending' | 'requires_action' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | 'refund_pending' | 'partially_refunded' | 'refunded';
  refundStatus: string;
  refundedAmount: number;
  provider: 'mock' | 'stripe';
  attempts: number;
  lastFailure: { code: string | null; message: string; at: string } | null;
  paidAt: string | null;
  expiresAt: string | null;
}
