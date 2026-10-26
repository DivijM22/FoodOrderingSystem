import { z } from 'zod';
import { PermanentEventError } from '../messaging/broker.js';

/**
 * Versioned event contracts (v1). Producers validate before publishing,
 * consumers validate on receipt. Breaking changes require a new version
 * (e.g. order.created.v2) published side-by-side until consumers migrate.
 *
 * Money is always integer paise (1 INR = 100 paise) to avoid float rounding.
 */

const money = z.number().int().nonnegative();

const orderItem = z.object({
  menuItemId: z.string(),
  name: z.string(),
  unitPrice: money,
  quantity: z.number().int().positive(),
  lineTotal: money,
});

const address = z.object({
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  state: z.string().optional(),
  pincode: z.string(),
  landmark: z.string().optional(),
});

export const EventTypes = {
  OrderCreated: 'order.created',
  OrderCancelled: 'order.cancelled',
  OrderExpired: 'order.expired',
  PaymentSucceeded: 'payment.succeeded',
  PaymentFailed: 'payment.failed',
  PaymentCancelled: 'payment.cancelled',
  RefundCompleted: 'payment.refund.completed',
  RefundFailed: 'payment.refund.failed',
  OrderConfirmed: 'order.confirmed',
  /** Customer-facing projection of every accepted order status transition (Notification Service input). */
  OrderStatusChanged: 'order.status_changed',
  BillingFinalized: 'billing.finalized',
  /** @deprecated Stage 5 name of billing.finalized; still accepted by consumers, no longer published. */
  InvoiceGenerated: 'billing.invoice_generated',
  /** v2 (Stage 8.2): `adminIds` (many-to-many restaurant administrators) replaces v1's `ownerId`. v1 is retired. */
  CatalogRestaurantUpdated: 'catalog.restaurant.updated',
  /** An account was deactivated (Auth Service, transactional outbox). Catalog removes it from restaurant adminIds. */
  AuthUserDeactivated: 'auth.user.deactivated',
  /** An inactive account was permanently deleted (Auth Service, transactional outbox). Its id is never reused. */
  AuthUserDeleted: 'auth.user.deleted',
  CatalogSyncRequested: 'catalog.sync_requested',
  DeliveryReadyForPickup: 'delivery.ready_for_pickup',
  DeliveryPartnerAssigned: 'delivery.partner_assigned',
  DeliveryPickedUp: 'delivery.picked_up',
  DeliveryLocationReached: 'delivery.location_reached',
  DeliveryCompleted: 'delivery.completed',
  /** The delivery was stopped because the order was cancelled (agent released, OTP invalidated). */
  DeliveryCancelled: 'delivery.cancelled',
  /** No partner could be assigned within the bounded retries; needs an operator (no automatic refund). */
  DeliveryAssignmentFailed: 'delivery.assignment_failed',
  /** Restricted command (exchange food.restricted, never food.events): OTP sealed for the Notification Service. */
  DeliveryOtpNotification: 'notification.delivery_otp',
} as const;

/** Direct exchange for sensitive commands. Only delivery-service may publish, only notification-service may consume. */
export const RESTRICTED_EXCHANGE = 'food.restricted';
/** Event types that must only ever travel on RESTRICTED_EXCHANGE. */
export const RESTRICTED_EVENT_TYPES: readonly string[] = ['notification.delivery_otp'];

/** Delivery Service lifecycle (its own records; the Order Service mirrors it as `delivery.status`). */
export const DELIVERY_STATUSES = [
  'preparing',
  'awaiting_partner',
  'partner_assigned',
  'picked_up',
  'arrived',
  'delivered',
  'cancelled',
  'assignment_failed',
] as const;

/** Statuses used in order.status_changed (mirrors the Order Service's state machine). */
export const CUSTOMER_ORDER_STATUSES = [
  'pending_payment',
  'confirmed',
  'assigning_delivery_partner',
  'partner_assigned',
  'out_for_delivery',
  'location_reached',
  'delivered',
  'cancelled',
  'expired',
] as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

/**
 * The authoritative payable amount for an order (Billing Service). Also used for the deprecated
 * billing.invoice_generated.v1 alias (Stage 5 events carry no invoiceVersion/expiresAt, hence optional).
 */
const billingFinalized = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  /** Invoices are immutable; a correction would be a new version. Always 1 today. */
  invoiceVersion: z.number().int().positive().default(1),
  orderId: z.string(),
  orderNumber: z.string(),
  customerId: z.string(),
  currency: z.literal('INR'),
  itemsSubtotal: money,
  deliveryFee: money,
  /** itemsSubtotal + deliveryFee */
  subtotal: money,
  discountCode: z.string().optional(),
  discountAmount: money,
  /** Always 0 for now; kept so taxes can be introduced without a contract change. */
  taxAmount: money,
  /** subtotal − discountAmount + taxAmount — the ONLY amount the Payment Service may charge. */
  finalAmount: money,
  /** The order's payment deadline (from order.created), so payment needs no call to the Order Service. */
  expiresAt: z.iso.datetime().optional(),
  /** Stage 5 events named this issuedAt. */
  issuedAt: z.iso.datetime(),
});

export const eventDataSchemas = {
  [EventTypes.OrderCreated]: z.object({
    orderId: z.string(),
    orderNumber: z.string(),
    customerId: z.string(),
    customerEmail: z.string(),
    restaurantId: z.string(),
    restaurantName: z.string(),
    items: z.array(orderItem).min(1),
    subtotal: money,
    deliveryFee: money,
    provisionalTotal: money,
    currency: z.literal('INR'),
    deliveryAddress: address,
    createdAt: z.iso.datetime(),
    /** Payment deadline; after it the order expires (optional: added after v1 was first published). */
    expiresAt: z.iso.datetime().optional(),
    /** Customer-supplied discount code; validated by the Billing Service (optional field). */
    discountCode: z.string().optional(),
  }),
  [EventTypes.OrderExpired]: z.object({
    orderId: z.string(),
    orderNumber: z.string(),
    customerId: z.string(),
    restaurantId: z.string(),
    /** Order's mirrored paymentStatus at expiry (pending or failed). */
    paymentStatus: z.string(),
    provisionalTotal: money,
    expiresAt: z.iso.datetime(),
    expiredAt: z.iso.datetime(),
  }),
  [EventTypes.OrderCancelled]: z.object({
    orderId: z.string(),
    orderNumber: z.string(),
    customerId: z.string(),
    restaurantId: z.string(),
    reason: z.string(),
    cancelledBy: z.enum(['customer', 'restaurant', 'platform', 'system']),
    previousStatus: z.string(),
    /** Lets the Payment Service decide whether a refund is needed. */
    paymentStatus: z.string(),
    provisionalTotal: money,
    cancelledAt: z.iso.datetime(),
  }),
  [EventTypes.PaymentSucceeded]: z.object({
    paymentId: z.string(),
    orderId: z.string(),
    customerId: z.string(),
    amount: money,
    currency: z.literal('INR'),
    provider: z.enum(['stripe', 'mock']),
    providerReference: z.string(),
    /** Invoice whose finalAmount was charged (optional field, added in Stage 5). */
    invoiceId: z.string().optional(),
    paidAt: z.iso.datetime(),
  }),
  [EventTypes.PaymentFailed]: z.object({
    paymentId: z.string(),
    orderId: z.string(),
    customerId: z.string(),
    amount: money,
    reason: z.string(),
    failureCode: z.string().optional(),
    /** True when the customer may retry with the same order. */
    retryable: z.boolean(),
    failedAt: z.iso.datetime(),
  }),
  [EventTypes.PaymentCancelled]: z.object({
    paymentId: z.string(),
    orderId: z.string(),
    customerId: z.string(),
    amount: money,
    reason: z.string(),
    cancelledAt: z.iso.datetime(),
  }),
  [EventTypes.RefundCompleted]: z.object({
    refundId: z.string(),
    paymentId: z.string(),
    orderId: z.string(),
    customerId: z.string(),
    amount: money,
    /** Cumulative refunded amount for the payment after this refund. */
    totalRefunded: money,
    fullyRefunded: z.boolean(),
    providerReference: z.string(),
    refundedAt: z.iso.datetime(),
  }),
  [EventTypes.RefundFailed]: z.object({
    refundId: z.string(),
    paymentId: z.string(),
    orderId: z.string(),
    customerId: z.string(),
    amount: money,
    reason: z.string(),
    failedAt: z.iso.datetime(),
  }),
  [EventTypes.InvoiceGenerated]: billingFinalized,
  [EventTypes.BillingFinalized]: billingFinalized,
  [EventTypes.CatalogRestaurantUpdated]: z.object({
    restaurantId: z.string(),
    /** Monotonic per restaurant; consumers apply a snapshot only if it is newer than what they hold. */
    catalogVersion: z.number().int().nonnegative(),
    /** change | snapshot (periodic / requested re-broadcast) */
    reason: z.enum(['change', 'snapshot']),
    name: z.string(),
    status: z.enum(['active', 'inactive']),
    isOpen: z.boolean(),
    isPureVeg: z.boolean(),
    /** Restaurant administrators (Auth user ids) who manage this restaurant; all have identical permissions. */
    adminIds: z.array(z.string()),
    items: z.array(
      z.object({ id: z.string(), name: z.string(), price: money, isVeg: z.boolean(), isAvailable: z.boolean() }),
    ),
    updatedAt: z.iso.datetime(),
  }),
  [EventTypes.AuthUserDeactivated]: z.object({
    userId: z.string(),
    role: z.enum(['customer', 'restaurant_admin', 'delivery_agent', 'platform_admin']),
    /**
     * When the account was deactivated (Auth clock). Catalog removes only restaurant assignments made before this
     * moment, so a delayed event can never remove an assignment made after a later reactivation.
     */
    deactivatedAt: z.iso.datetime(),
    deactivatedBy: z.string(),
  }),
  [EventTypes.AuthUserDeleted]: z.object({
    userId: z.string(),
    role: z.enum(['customer', 'restaurant_admin', 'delivery_agent', 'platform_admin']),
    deletedAt: z.iso.datetime(),
  }),
  [EventTypes.CatalogSyncRequested]: z.object({
    requestedBy: z.string(),
    reason: z.string(),
    requestedAt: z.iso.datetime(),
  }),
  [EventTypes.OrderConfirmed]: z.object({
    orderId: z.string(),
    orderNumber: z.string(),
    customerId: z.string(),
    restaurantId: z.string(),
    restaurantName: z.string(),
    paymentId: z.string(),
    invoiceId: z.string().optional(),
    amountPaid: money,
    currency: z.literal('INR'),
    deliveryAddress: address,
    items: z.array(z.object({ menuItemId: z.string(), name: z.string(), quantity: z.number().int().positive() })),
    /** Optional (added in Stage 6, non-breaking). Used by Delivery only to address the OTP; never shown to agents. */
    customerEmail: z.string().optional(),
    customerName: z.string().optional(),
    confirmedAt: z.iso.datetime(),
  }),
  [EventTypes.OrderStatusChanged]: z.object({
    orderId: z.string(),
    orderNumber: z.string(),
    customerId: z.string(),
    /** Needed to notify without querying the Auth Service. PII: only for the customer's own notifications. */
    customerEmail: z.string(),
    customerName: z.string(),
    status: z.enum(CUSTOMER_ORDER_STATUSES),
    previousStatus: z.enum(CUSTOMER_ORDER_STATUSES).nullable(),
    /** 1-based index of this transition in the order's history: orders transitions and deduplicates. */
    sequence: z.number().int().positive(),
    changedAt: z.iso.datetime(),
    reason: z.string().optional(),
    /** Event (and service) that caused the transition. */
    cause: z.object({ eventId: z.string(), service: z.string() }),
    summary: z.object({
      restaurantName: z.string(),
      items: z.array(z.object({ name: z.string(), quantity: z.number().int().positive(), lineTotal: money })),
      currency: z.literal('INR'),
      /** Billing's final payable amount when known, else the provisional total. */
      total: money,
      amountPaid: money.optional(),
      deliveryCity: z.string(),
    }),
    /** Non-sensitive extras for the template, e.g. { agentName }. Never OTPs or payment secrets. */
    metadata: z.record(z.string(), z.string()).default({}),
  }),
  [EventTypes.DeliveryReadyForPickup]: z.object({ deliveryId: z.string(), orderId: z.string(), restaurantId: z.string(), readyAt: z.iso.datetime() }),
  [EventTypes.DeliveryPartnerAssigned]: z.object({
    deliveryId: z.string(),
    orderId: z.string(),
    agentId: z.string(),
    /** Display name only (shown to the customer). */
    agentName: z.string(),
    /** e.g. "+91 98XXXXXX10" — public contact hint; the full number is never published. */
    agentPhoneMasked: z.string().optional(),
    assignedAt: z.iso.datetime(),
  }),
  [EventTypes.DeliveryPickedUp]: z.object({ deliveryId: z.string(), orderId: z.string(), agentId: z.string(), pickedUpAt: z.iso.datetime() }),
  [EventTypes.DeliveryLocationReached]: z.object({
    deliveryId: z.string(),
    orderId: z.string(),
    agentId: z.string(),
    reachedAt: z.iso.datetime(),
    /** When the OTP (sent separately on food.restricted) expires. The OTP itself is never in this event. */
    otpExpiresAt: z.iso.datetime(),
  }),
  [EventTypes.DeliveryCompleted]: z.object({
    deliveryId: z.string(),
    orderId: z.string(),
    agentId: z.string(),
    deliveredAt: z.iso.datetime(),
    /** Always true: the Delivery Service publishes completion only after a successful OTP verification. */
    otpVerified: z.literal(true),
  }),
  [EventTypes.DeliveryCancelled]: z.object({
    deliveryId: z.string(),
    orderId: z.string(),
    previousStatus: z.enum(DELIVERY_STATUSES),
    reason: z.string(),
    agentId: z.string().optional(),
    cancelledAt: z.iso.datetime(),
  }),
  [EventTypes.DeliveryAssignmentFailed]: z.object({
    deliveryId: z.string(),
    orderId: z.string(),
    attempts: z.number().int().positive(),
    reason: z.string(),
    failedAt: z.iso.datetime(),
  }),
  [EventTypes.DeliveryOtpNotification]: z.object({
    deliveryId: z.string(),
    orderId: z.string(),
    orderNumber: z.string(),
    customerId: z.string(),
    customerEmail: z.string(),
    customerName: z.string(),
    agentName: z.string(),
    /** 1 for the first OTP, incremented on each (limited) reissue. Only the latest one is valid. */
    otpSequence: z.number().int().positive(),
    /** The OTP sealed to the Notification Service's X25519 public key (see crypto/sealed-box.ts). Never plaintext. */
    otpCiphertext: z.string().regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    otpExpiresAt: z.iso.datetime(),
  }),
} satisfies Record<EventType, z.ZodType>;

export type EventData<T extends EventType> = z.infer<(typeof eventDataSchemas)[T]>;

/** Default contract version (most events are v1). */
export const EVENT_VERSION = 1;

/** Contracts whose current version differs from EVENT_VERSION. Older versions are retired (rejected as permanent). */
export const EVENT_VERSIONS: Partial<Record<EventType, number>> = {
  [EventTypes.CatalogRestaurantUpdated]: 2,
};

/** Current version of a contract (what producers publish and consumers bind to). */
export const versionOf = (type: EventType): number => EVENT_VERSIONS[type] ?? EVENT_VERSION;

/**
 * Validates an incoming event against its contract. Contract violations can never succeed on retry,
 * so they surface as PermanentEventError (dead-lettered immediately by the broker).
 */
export function parseEventData<T extends EventType>(event: { eventType: string; version: number; data: unknown }, type: T): EventData<T> {
  if (event.eventType !== type || event.version !== versionOf(type)) {
    throw new PermanentEventError(`Unsupported event ${event.eventType}.v${event.version} (expected ${type}.v${versionOf(type)})`);
  }
  const parsed = eventDataSchemas[type].safeParse(event.data);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new PermanentEventError(`Invalid ${type} payload: ${problems}`);
  }
  return parsed.data as EventData<T>;
}
