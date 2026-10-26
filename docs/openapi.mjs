// OpenAPI 3.1 description of every client-facing endpoint routed by the API gateway.
// Source of truth for docs/openapi.json (node scripts/build-openapi.mjs) and checked against the
// actual Express route declarations by scripts/check-openapi.mjs. Internal-only surfaces (the
// Notification Service, RabbitMQ, per-service /health beyond the gateway mapping) are not described.
//
// x-roles on an operation lists the roles allowed (enforced by each service); "public" = no token.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const objectId = { type: 'string', pattern: '^[a-f0-9]{24}$', example: '6ad0da6d875f7b0a9623df81' };
const paise = { type: 'integer', minimum: 0, description: 'Integer paise (₹249.00 → 24900)' };
const dateTime = { type: 'string', format: 'date-time' };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

const ok = (schema, description = 'OK', example) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', required: ['success', 'data'], properties: { success: { const: true }, data: schema } }, ...(example ? { example: { success: true, data: example } } : {}) } },
});
const page = (item, description = 'Page of results') => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties: { success: { const: true }, data: { type: 'array', items: item }, meta: ref('PageMeta') } } } },
});
const err = (description, codes) => ({
  description: `${description}${codes ? ` — \`${codes.join('`, `')}\`` : ''}`,
  content: { 'application/json': { schema: ref('Error'), ...(codes ? { example: { success: false, error: { code: codes[0], message: description } } } : {}) } },
});
const E = {
  400: err('Validation failed', ['VALIDATION_ERROR', 'MALFORMED_JSON', 'INVALID_ID']),
  401: err('Missing, invalid or expired token', ['MISSING_TOKEN', 'INVALID_TOKEN', 'TOKEN_EXPIRED']),
  403: err('Authenticated but not allowed (role)', ['FORBIDDEN']),
  404: err('Not found (also returned for resources owned by someone else)', ['NOT_FOUND']),
};
const body = (schema, example) => ({ required: true, content: { 'application/json': { schema, ...(example ? { example } : {}) } } });
const pathId = (name = 'id', description) => ({ name, in: 'path', required: true, schema: objectId, ...(description ? { description } : {}) });
const q = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description ? { description } : {}) });
const pageParams = (max = 50, def = 10) => [q('page', { type: 'integer', minimum: 1, default: 1 }), q('limit', { type: 'integer', minimum: 1, maximum: max, default: def })];
const idempotencyKey = (required, description) => ({
  name: 'Idempotency-Key', in: 'header', required, description,
  schema: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' },
});

/** Build an operation; `roles` drives security, the x-roles extension and the description prefix. */
function op({ tag, summary, description = '', roles, params = [], requestBody, responses, operationId }) {
  const isPublic = roles.includes('public');
  const optional = roles.includes('optional-auth');
  const who = isPublic ? 'Public.' : optional ? 'Public; a token unlocks more (see description).' : `Roles: ${roles.map((r) => `\`${r}\``).join(', ')}.`;
  return {
    tags: [tag],
    summary,
    operationId,
    description: `**${who}** ${description}`.trim(),
    'x-roles': roles,
    ...(isPublic ? { security: [] } : optional ? { security: [{}, { bearerAuth: [] }] } : { security: [{ bearerAuth: [] }] }),
    ...(params.length ? { parameters: params } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: { ...responses, ...(isPublic ? {} : optional ? {} : { 401: E[401] }) },
  };
}

const address = {
  type: 'object', required: ['line1', 'city', 'pincode'], additionalProperties: false,
  properties: {
    line1: { type: 'string', minLength: 3, maxLength: 200 }, line2: { type: 'string', maxLength: 200 },
    city: { type: 'string', minLength: 2, maxLength: 80 }, state: { type: 'string', maxLength: 80 },
    pincode: { type: 'string', pattern: '^[1-9][0-9]{5}$' }, landmark: { type: 'string', maxLength: 120 },
  },
};
const password = { type: 'string', minLength: 8, maxLength: 72, description: '8–72 chars with at least one letter and one digit' };
const phone = { type: 'string', pattern: '^\\+?[0-9]{10,15}$' };
const ROLES = ['customer', 'restaurant_admin', 'delivery_agent', 'platform_admin'];
const ORDER_STATUSES = ['pending_payment', 'confirmed', 'assigning_delivery_partner', 'partner_assigned', 'out_for_delivery', 'location_reached', 'delivered', 'cancelled', 'expired'];
const DELIVERY_STATUSES = ['preparing', 'awaiting_partner', 'partner_assigned', 'picked_up', 'arrived', 'delivered', 'cancelled', 'assignment_failed'];
const PAYMENT_STATUSES = ['pending', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled'];

const schemas = {
  Error: {
    type: 'object', required: ['success', 'error'],
    properties: {
      success: { const: false },
      error: {
        type: 'object', required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } } },
      },
    },
  },
  PageMeta: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } } },
  Health: {
    type: 'object',
    properties: { status: { enum: ['ok', 'degraded', 'unhealthy'] }, service: { type: 'string' }, uptimeSeconds: { type: 'number' }, checks: { type: 'object', additionalProperties: { enum: ['up', 'down'] } }, timestamp: dateTime },
    example: { status: 'ok', service: 'order-service', uptimeSeconds: 512, checks: { mongo: 'up', rabbitmq: 'up' }, timestamp: '2026-10-17T11:34:06.149Z' },
  },
  User: {
    type: 'object',
    properties: {
      id: objectId, name: { type: 'string' }, email: { type: 'string', format: 'email' }, role: { enum: ROLES }, phone: nullable(phone),
      addresses: { type: 'array', items: { type: 'object', properties: { id: objectId, label: { type: 'string' }, ...address.properties } } },
      isActive: { type: 'boolean' }, lastLoginAt: nullable(dateTime), createdAt: dateTime, updatedAt: dateTime,
    },
  },
  LoginResult: {
    type: 'object',
    properties: { accessToken: { type: 'string', description: 'HS256 JWT; send as `Authorization: Bearer <token>`' }, tokenType: { const: 'Bearer' }, expiresIn: { type: 'string', example: '1h' }, user: ref('User') },
  },
  Restaurant: {
    type: 'object',
    properties: {
      id: objectId, name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string' }, cuisines: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } },
      address: { type: 'object', properties: { line1: { type: 'string' }, area: { type: 'string' }, city: { type: 'string' }, pincode: { type: 'string' } } },
      adminIds: { type: 'array', items: objectId, description: 'Restaurant administrators (many-to-many, identical permissions). Present only for platform admins and the restaurant\'s own administrators; never shown to customers.' },
      isOpen: { type: 'boolean' }, status: { enum: ['active', 'inactive'] }, isPureVeg: { type: 'boolean' }, rating: { type: 'number' }, ratingCount: { type: 'integer' },
      costForTwo: paise, avgDeliveryMinutes: { type: 'integer' }, openingHours: { type: 'object', properties: { opens: { type: 'string' }, closes: { type: 'string' } } }, imageUrl: nullable({ type: 'string' }),
      createdAt: dateTime, updatedAt: dateTime,
    },
  },
  MenuItem: {
    type: 'object',
    properties: {
      id: objectId, restaurantId: objectId, name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: paise,
      isVeg: { type: 'boolean' }, isAvailable: { type: 'boolean' }, isBestseller: { type: 'boolean' }, spiceLevel: { type: 'integer', minimum: 0, maximum: 3 }, imageUrl: nullable({ type: 'string' }), updatedAt: dateTime,
    },
  },
  Menu: { type: 'object', properties: { restaurant: ref('Restaurant'), categories: { type: 'array', items: { type: 'string' } }, items: { type: 'array', items: ref('MenuItem') } } },
  StatusHistoryEntry: {
    type: 'object',
    properties: {
      status: { enum: ORDER_STATUSES }, at: dateTime, sourceEventId: nullable({ type: 'string' }), sourceService: nullable({ type: 'string' }), by: { type: 'string' }, role: { type: 'string' }, note: { type: 'string' },
      metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Non-sensitive context, e.g. agentName. Never OTPs or payment secrets.' },
    },
  },
  Order: {
    type: 'object',
    properties: {
      id: objectId, orderNumber: { type: 'string', example: 'ORD-261017-QGA9TV' }, customerId: objectId, restaurantId: objectId, restaurantName: { type: 'string' },
      items: { type: 'array', items: { type: 'object', properties: { menuItemId: objectId, name: { type: 'string' }, unitPrice: paise, isVeg: { type: 'boolean' }, quantity: { type: 'integer' }, lineTotal: paise } } },
      subtotal: paise, deliveryFee: paise, provisionalTotal: paise, currency: { const: 'INR' }, status: { enum: ORDER_STATUSES },
      paymentStatus: { enum: ['pending', 'paid', 'failed', 'cancelled', 'refund_pending', 'partially_refunded', 'refunded', 'refund_failed'] },
      statusHistory: { type: 'array', items: ref('StatusHistoryEntry') }, paymentId: nullable({ type: 'string' }), amountPaid: nullable(paise),
      paymentHistory: { type: 'array', items: { type: 'object', properties: { eventType: { type: 'string' }, paymentStatus: { type: 'string' }, at: dateTime, note: { type: 'string' } } } },
      deliveryAddress: address,
      delivery: nullable({ type: 'object', properties: { deliveryId: { type: 'string' }, status: { enum: DELIVERY_STATUSES }, agent: nullable({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, phoneMasked: { type: 'string' } } }), otpExpiresAt: nullable(dateTime), failureReason: nullable({ type: 'string' }), updatedAt: dateTime } }),
      notes: nullable({ type: 'string' }), cancellation: nullable({ type: 'object', properties: { reason: { type: 'string' }, by: { type: 'string' }, role: { type: 'string' }, at: dateTime } }),
      discountCode: nullable({ type: 'string' }),
      billing: nullable({ type: 'object', properties: { invoiceId: { type: 'string' }, invoiceNumber: { type: 'string' }, discountCode: nullable({ type: 'string' }), discountAmount: paise, taxAmount: paise, finalAmount: paise, issuedAt: dateTime } }),
      expiresAt: nullable(dateTime), expiredAt: nullable(dateTime), createdAt: dateTime, updatedAt: dateTime,
    },
  },
  Tracking: {
    type: 'object',
    properties: {
      orderId: objectId, orderNumber: { type: 'string' }, status: { enum: ORDER_STATUSES }, statusLabel: { type: 'string' }, paymentStatus: { type: 'string' },
      deliveryStatus: nullable({ enum: DELIVERY_STATUSES }), deliveryPartner: nullable({ type: 'object', properties: { name: { type: 'string' }, phoneMasked: nullable({ type: 'string' }) } }),
      deliveryCodeExpiresAt: nullable(dateTime), deliveryIssue: nullable({ type: 'string' }), terminal: { type: 'boolean' }, completed: { type: 'boolean' }, settled: { type: 'boolean', description: 'Nothing visible will change any more (delivered, or closed with a final payment outcome); the SSE stream ends then' }, sequence: { type: 'integer', description: 'History length (also the SSE event id)' },
      steps: { type: 'array', items: { type: 'object', properties: { status: { type: 'string' }, label: { type: 'string' }, reached: { type: 'boolean' }, at: nullable(dateTime), current: { type: 'boolean' } } } },
      timestamps: { type: 'object', additionalProperties: nullable(dateTime) },
      history: { type: 'array', items: ref('StatusHistoryEntry') }, expiresAt: nullable(dateTime),
    },
    example: {
      orderId: '6ad0da6d875f7b0a9623df81', orderNumber: 'ORD-261017-QGA9TV', status: 'partner_assigned', statusLabel: 'Delivery partner assigned', paymentStatus: 'paid',
      deliveryStatus: 'partner_assigned', deliveryPartner: { name: 'Ravi Kumar', phoneMasked: '98XXXXXX01' }, deliveryCodeExpiresAt: null, deliveryIssue: null, terminal: false, completed: false, sequence: 4,
    },
  },
  Payment: {
    type: 'object',
    properties: {
      id: objectId, orderId: objectId, orderNumber: { type: 'string' }, customerId: objectId, amount: paise, invoiceId: nullable({ type: 'string' }), invoiceNumber: nullable({ type: 'string' }), currency: { const: 'INR' },
      status: { enum: PAYMENT_STATUSES }, refundStatus: { type: 'string' }, refundedAmount: paise, provider: { enum: ['mock', 'stripe'] }, providerPaymentIntentId: nullable({ type: 'string' }), attempts: { type: 'integer' },
      lastFailure: nullable({ type: 'object' }), paidAt: nullable(dateTime), orderCancelledAt: nullable(dateTime), orderClosure: nullable({ type: 'string' }), expiresAt: nullable(dateTime),
      statusHistory: { type: 'array', items: { type: 'object' } }, refunds: { type: 'array', items: { type: 'object' } },
    },
  },
  PaymentInitiation: {
    type: 'object',
    properties: { payment: ref('Payment'), paymentIntentId: { type: 'string' }, clientSecret: { type: 'string', description: 'Pass to Stripe.js; never stored by the service' }, provider: { enum: ['mock', 'stripe'] }, testMode: { const: true } },
  },
  Invoice: {
    type: 'object',
    properties: {
      id: objectId, invoiceNumber: { type: 'string' }, orderId: objectId, orderNumber: { type: 'string' }, currency: { const: 'INR' },
      lines: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, description: { type: 'string' }, menuItemId: { type: 'string' }, unitPrice: paise, quantity: { type: 'integer' }, lineTotal: paise } } },
      itemsSubtotal: paise, deliveryFee: paise, subtotal: paise, discount: nullable({ type: 'object' }), discountRejection: nullable({ type: 'object', properties: { code: { type: 'string' }, reason: { type: 'string' } } }),
      discountAmount: paise, taxLines: { type: 'array', items: { type: 'object' } }, taxAmount: { const: 0 }, finalAmount: { ...paise, description: 'The payable amount: subtotal − discountAmount + taxAmount' },
      schemaVersion: { type: 'integer' }, issuedAt: dateTime, status: { enum: ['open', 'paid', 'partially_refunded', 'refunded', 'void'] },
      amountPaid: paise, amountRefunded: paise, netCollected: paise, amountDue: paise, adjustments: { type: 'array', items: { type: 'object' } },
    },
  },
  Discount: {
    type: 'object',
    properties: { code: { type: 'string' }, description: { type: 'string' }, type: { enum: ['percent', 'flat'] }, value: { type: 'integer' }, maxDiscount: { type: 'integer' }, minItemsSubtotal: paise, active: { type: 'boolean' }, validFrom: nullable(dateTime), validUntil: nullable(dateTime) },
  },
  Delivery: {
    type: 'object',
    description: 'Agent view. Never contains the customer email/phone, the OTP or its verifier.',
    properties: {
      id: objectId, orderId: objectId, orderNumber: nullable({ type: 'string' }), status: { enum: DELIVERY_STATUSES }, restaurantName: nullable({ type: 'string' }), customerName: nullable({ type: 'string' }),
      deliveryAddress: nullable(address), items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'integer' } } } },
      agent: nullable({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, phoneMasked: { type: 'string' } } }),
      timestamps: { type: 'object', additionalProperties: nullable(dateTime) }, assignmentAttempts: { type: 'integer' }, failureReason: nullable({ type: 'string' }), cancellation: nullable({ type: 'object' }),
      otp: nullable({ type: 'object', properties: { status: { enum: ['active', 'consumed', 'superseded', 'expired', 'locked', 'cancelled'] }, expiresAt: dateTime, attemptsRemaining: { type: 'integer' } } }),
      otpIssues: { type: 'integer' }, history: { type: 'array', items: { type: 'object' } },
    },
  },
  Agent: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, status: { enum: ['available', 'busy', 'offline'] }, activeDeliveryId: nullable({ type: 'string' }), completedDeliveries: { type: 'integer' }, lastAssignedAt: nullable(dateTime), createdAt: dateTime, updatedAt: dateTime },
  },
};

const paths = {};
const add = (path, method, operation) => {
  paths[path] ??= {};
  paths[path][method] = operation;
};

// ------------------------------------------------------------------ health (gateway)
add('/health', 'get', op({ tag: 'Health', operationId: 'gatewayHealth', summary: 'Gateway liveness', roles: ['public'], responses: { 200: { description: 'Gateway is up', content: { 'application/json': { example: { status: 'ok', service: 'gateway' } } } } } }));
add('/health/{service}', 'get', op({
  tag: 'Health', operationId: 'serviceHealth', summary: 'Health of one service (via the gateway)', roles: ['public'],
  description: 'MongoDB is a critical check (503 when down); RabbitMQ (and SMTP for notification) are optional → `degraded`. The Notification Service is internal and not routed here.',
  params: [{ name: 'service', in: 'path', required: true, schema: { enum: ['auth', 'catalog', 'order', 'payment', 'billing', 'delivery'] } }],
  responses: { 200: { description: 'ok or degraded', content: { 'application/json': { schema: ref('Health') } } }, 503: { description: 'unhealthy (critical dependency down)', content: { 'application/json': { schema: ref('Health') } } } },
}));

// ------------------------------------------------------------------ auth
add('/auth/register', 'post', op({
  tag: 'Auth', operationId: 'register', summary: 'Register a customer', roles: ['public'], description: 'Public registration always creates a `customer`.',
  requestBody: body({ type: 'object', required: ['name', 'email', 'password'], additionalProperties: false, properties: { name: { type: 'string', minLength: 2, maxLength: 80 }, email: { type: 'string', format: 'email' }, password, phone } }, { name: 'Priya Sharma', email: 'priya@example.com', password: 'Priya1234', phone: '9876543210' }),
  responses: { 201: ok(ref('User'), 'Created'), 400: E[400], 409: err('Email already registered', ['EMAIL_TAKEN']) },
}));
add('/auth/login', 'post', op({
  tag: 'Auth', operationId: 'login', summary: 'Log in and receive a JWT', roles: ['public'], description: 'Rate-limited at the gateway (10 r/s, burst 20).',
  requestBody: body({ type: 'object', required: ['email', 'password'], additionalProperties: false, properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } }, { email: 'priya@example.com', password: 'Priya1234' }),
  responses: { 200: ok(ref('LoginResult')), 400: E[400], 401: err('Wrong email or password', ['INVALID_CREDENTIALS']) },
}));
add('/auth/verify', 'get', op({ tag: 'Auth', operationId: 'verifyToken', summary: 'Validate the bearer token and return its claims', roles: ROLES, responses: { 200: ok({ type: 'object', properties: { valid: { const: true }, user: { type: 'object', properties: { id: objectId, email: { type: 'string' }, role: { enum: ROLES }, name: { type: 'string' } } } } }) } }));
add('/auth/me', 'get', op({ tag: 'Auth', operationId: 'getMe', summary: 'Own profile', roles: ROLES, responses: { 200: ok(ref('User')), 404: E[404] } }));
add('/auth/me', 'patch', op({
  tag: 'Auth', operationId: 'updateMe', summary: 'Update own profile and saved addresses', roles: ROLES,
  requestBody: body({ type: 'object', minProperties: 1, additionalProperties: false, properties: { name: { type: 'string', minLength: 2, maxLength: 80 }, phone, addresses: { type: 'array', maxItems: 10, items: { ...address, properties: { label: { type: 'string', maxLength: 30 }, ...address.properties } } } } }),
  responses: { 200: ok(ref('User')), 400: E[400] },
}));
add('/auth/me/password', 'post', op({
  tag: 'Auth', operationId: 'changePassword', summary: 'Change own password', roles: ROLES,
  requestBody: body({ type: 'object', required: ['currentPassword', 'newPassword'], additionalProperties: false, properties: { currentPassword: { type: 'string' }, newPassword: password } }),
  responses: { 204: { description: 'Password changed' }, 400: E[400], 401: err('Current password is wrong', ['INVALID_CREDENTIALS']) },
}));
add('/auth/users', 'get', op({ tag: 'Auth (admin)', operationId: 'listUsers', summary: 'List users', roles: ['platform_admin'], params: [q('role', { enum: ROLES }), ...pageParams(100, 20)], responses: { 200: page(ref('User')), 403: E[403] } }));
add('/auth/users', 'post', op({
  tag: 'Auth (admin)', operationId: 'createUser', summary: 'Create a staff account (restaurant admin, delivery partner, admin)', roles: ['platform_admin'],
  requestBody: body({ type: 'object', required: ['name', 'email', 'password', 'role'], additionalProperties: false, properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' }, password, phone, role: { enum: ROLES } } }, { name: 'Ravi Kumar', email: 'ravi@food.local', password: 'Deliver123', phone: '9845012301', role: 'delivery_agent' }),
  responses: { 201: ok(ref('User'), 'Created'), 400: E[400], 403: E[403], 409: err('Email already registered', ['EMAIL_TAKEN']) },
}));
add('/auth/users/{id}/status', 'patch', op({
  tag: 'Auth (admin)', operationId: 'setUserStatus', summary: 'Activate or deactivate a user', roles: ['platform_admin'], params: [pathId()],
  description: 'Deactivating an active account publishes `auth.user.deactivated.v1` (transactional outbox); the Catalog Service then removes the user from every restaurant\'s adminIds (eventual consistency). Deactivating an inactive account publishes nothing. Reactivation restores login only — restaurant assignments are **not** restored. The Delivery Service also blocks a deactivated agent from new assignments until they sign in again after reactivation. You cannot deactivate yourself, and the last active platform administrator cannot be deactivated (concurrent deactivations are serialized).',
  requestBody: body({ type: 'object', required: ['isActive'], additionalProperties: false, properties: { isActive: { type: 'boolean' } } }),
  responses: { 200: ok(ref('User')), 403: E[403], 404: E[404], 409: err('Would leave no active platform administrator', ['LAST_ACTIVE_ADMIN']) },
}));
add('/auth/users/{id}', 'delete', op({
  tag: 'Auth (admin)', operationId: 'deleteUser', summary: 'Permanently delete an inactive account', roles: ['platform_admin'], params: [pathId()],
  description: 'Deletes the Auth record of an **inactive** account and, in the same transaction, writes `auth.user.deleted.v1` to the outbox. Catalog then removes the id from every restaurant\'s adminIds and refuses to assign it again; Delivery blocks a deleted agent. Orders, payments, invoices, ledger entries and delivery history are kept and may still contain the user id and the name/email/address captured at the time. Ids are never reused. A JWT already issued to the user stays cryptographically valid until it expires (≤ 1 h). A repeated request returns 404 and publishes nothing.',
  responses: {
    200: ok({ type: 'object', required: ['id', 'role', 'deletedAt'], properties: { id: objectId, role: { enum: ROLES }, deletedAt: { type: 'string', format: 'date-time' } } }),
    400: E[400], 401: E[401],
    403: err('Not a platform admin, deleting yourself, or your admin account is no longer active', ['FORBIDDEN', 'CANNOT_DELETE_SELF', 'ACTOR_NOT_ACTIVE']),
    404: E[404],
    409: err('Account still active, or a delivery agent still holds an active delivery', ['USER_ACTIVE', 'AGENT_HAS_ACTIVE_DELIVERY']),
  },
}));

// ------------------------------------------------------------------ catalog
const bool = { enum: ['true', 'false'] };
add('/restaurants', 'get', op({
  tag: 'Catalog', operationId: 'listRestaurants', summary: 'Browse restaurants', roles: ['optional-auth'], description: 'Owners/admins may add `includeInactive=true`.',
  params: [q('search', { type: 'string' }), q('cuisine', { type: 'string' }), q('city', { type: 'string' }), q('isOpen', bool), q('pureVeg', bool), q('minRating', { type: 'number', minimum: 0, maximum: 5 }), q('maxCostForTwo', { type: 'integer' }), q('sort', { enum: ['rating', 'deliveryTime', 'costLowToHigh', 'costHighToLow', 'name'], default: 'rating' }), q('includeInactive', bool), ...pageParams(50, 20)],
  responses: { 200: page(ref('Restaurant')), 400: E[400] },
}));
add('/restaurants/cuisines', 'get', op({ tag: 'Catalog', operationId: 'listCuisines', summary: 'Distinct cuisines', roles: ['public'], responses: { 200: ok({ type: 'array', items: { type: 'string' } }) } }));
add('/restaurants/{id}', 'get', op({ tag: 'Catalog', operationId: 'getRestaurant', summary: 'Restaurant details', roles: ['optional-auth'], params: [pathId()], responses: { 200: ok(ref('Restaurant')), 404: E[404] } }));
add('/restaurants/{id}/menu', 'get', op({ tag: 'Catalog', operationId: 'getMenu', summary: 'Menu with categories', roles: ['optional-auth'], params: [pathId(), q('category', { type: 'string' }), q('vegOnly', bool), q('availableOnly', bool)], responses: { 200: ok(ref('Menu')), 404: E[404] } }));
add('/restaurants/{id}/menu/{itemId}', 'get', op({ tag: 'Catalog', operationId: 'getMenuItem', summary: 'One menu item', roles: ['optional-auth'], params: [pathId(), pathId('itemId')], responses: { 200: ok(ref('MenuItem')), 404: E[404] } }));
const restaurantInput = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 100 }, description: { type: 'string', minLength: 10, maxLength: 500 }, cuisines: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } }, tags: { type: 'array', maxItems: 10, items: { type: 'string' } },
    address: { type: 'object', required: ['line1', 'area', 'city', 'pincode'], properties: { line1: { type: 'string' }, area: { type: 'string' }, city: { type: 'string' }, pincode: { type: 'string', pattern: '^[1-9][0-9]{5}$' } } },
    isPureVeg: { type: 'boolean', default: false }, costForTwo: paise, avgDeliveryMinutes: { type: 'integer', minimum: 5, maximum: 180 },
    openingHours: { type: 'object', properties: { opens: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, closes: { type: 'string' } } }, imageUrl: { type: 'string', format: 'uri' },
    adminIds: { type: 'array', items: objectId, maxItems: 50, description: 'Optional initial restaurant administrators (duplicates ignored)' },
  },
};
const managers = ['restaurant_admin', 'platform_admin'];
const restaurantAdminNote = 'A restaurant admin may act only on restaurants whose `adminIds` include them (403 otherwise); platform admins act on any restaurant.';
add('/restaurants', 'post', op({ tag: 'Catalog (management)', operationId: 'createRestaurant', summary: 'Create a restaurant (platform admin)', roles: ['platform_admin'], description: 'Only platform admins create restaurants. `adminIds` (optional) assigns the initial restaurant administrators; a restaurant may start with none. Ids of deleted accounts are refused.', requestBody: body({ ...restaurantInput, required: ['name', 'description', 'cuisines', 'address', 'costForTwo', 'avgDeliveryMinutes'] }), responses: { 201: ok(ref('Restaurant'), 'Created'), 400: E[400], 403: E[403], 409: err('An initial administrator account was permanently deleted', ['USER_DELETED']) } }));
add('/restaurants/{id}', 'patch', op({ tag: 'Catalog (management)', operationId: 'updateRestaurant', summary: 'Update restaurant details', roles: managers, description: `${restaurantAdminNote} \`status\` (listing) is platform-admin only; administrator assignments are changed only via /restaurants/{id}/admins.`, params: [pathId()], requestBody: body((({ adminIds, ...p }) => ({ ...restaurantInput, minProperties: 1, properties: { ...p, status: { enum: ['active', 'inactive'] } } }))(restaurantInput.properties)), responses: { 200: ok(ref('Restaurant')), 400: E[400], 403: E[403], 404: E[404] } }));
add('/restaurants/{id}', 'delete', op({ tag: 'Catalog (management)', operationId: 'deactivateRestaurant', summary: 'Soft-delete (deactivate) a restaurant', roles: ['platform_admin'], params: [pathId()], responses: { 200: ok(ref('Restaurant')), 403: E[403], 404: E[404] } }));
add('/restaurants/mine', 'get', op({ tag: 'Catalog (management)', operationId: 'listMyRestaurants', summary: 'Restaurants assigned to me', roles: ['restaurant_admin'], description: 'Every restaurant whose `adminIds` include the caller (from the JWT), including inactive ones, with `adminIds` visible.', responses: { 200: ok({ type: 'array', items: ref('Restaurant') }), 403: E[403] } }));
add('/restaurants/{id}/admins', 'post', op({
  tag: 'Catalog (management)', operationId: 'addRestaurantAdmin', summary: 'Assign a restaurant administrator', roles: ['platform_admin'],
  description: 'Atomic `$addToSet`: assigning someone already assigned changes nothing (idempotent, safe to retry). The id is not checked against the Auth Service (no synchronous call): assign only `restaurant_admin` accounts. Ids of deleted accounts (learned from `auth.user.deleted.v1`) are refused.',
  params: [pathId()], requestBody: body({ type: 'object', required: ['userId'], additionalProperties: false, properties: { userId: objectId } }),
  responses: { 200: ok(ref('Restaurant')), 400: E[400], 403: E[403], 404: E[404], 409: err('The account was permanently deleted', ['USER_DELETED']) },
}));
add('/restaurants/{id}/admins/{userId}', 'delete', op({
  tag: 'Catalog (management)', operationId: 'removeRestaurantAdmin', summary: 'Remove a restaurant administrator', roles: ['platform_admin'],
  description: 'Atomic `$pull` (idempotent). Takes effect immediately in the Catalog Service and reaches the Order Service through `catalog.restaurant.updated.v2`.',
  params: [pathId(), pathId('userId')], responses: { 200: ok(ref('Restaurant')), 403: E[403], 404: E[404] },
}));
add('/restaurants/{id}/open', 'patch', op({ tag: 'Catalog (management)', operationId: 'setOpen', summary: 'Open or close for orders', roles: managers, description: restaurantAdminNote, params: [pathId()], requestBody: body({ type: 'object', required: ['isOpen'], additionalProperties: false, properties: { isOpen: { type: 'boolean' } } }), responses: { 200: ok(ref('Restaurant')), 403: E[403], 404: E[404] } }));
const menuInput = {
  type: 'object', additionalProperties: false,
  properties: { name: { type: 'string', minLength: 2, maxLength: 100 }, description: { type: 'string', maxLength: 300 }, category: { type: 'string', minLength: 2, maxLength: 60 }, price: { ...paise, minimum: 100 }, isVeg: { type: 'boolean' }, isAvailable: { type: 'boolean', default: true }, isBestseller: { type: 'boolean', default: false }, spiceLevel: { type: 'integer', minimum: 0, maximum: 3 }, imageUrl: { type: 'string', format: 'uri' } },
};
add('/restaurants/{id}/menu', 'post', op({ tag: 'Catalog (management)', operationId: 'addMenuItem', description: restaurantAdminNote, summary: 'Add a menu item', roles: managers, params: [pathId()], requestBody: body({ ...menuInput, required: ['name', 'category', 'price', 'isVeg'] }), responses: { 201: ok(ref('MenuItem'), 'Created'), 400: E[400], 403: E[403], 409: err('Conflict', ['DUPLICATE_ITEM', 'PURE_VEG_VIOLATION']) } }));
add('/restaurants/{id}/menu/{itemId}', 'patch', op({ tag: 'Catalog (management)', operationId: 'updateMenuItem', description: restaurantAdminNote, summary: 'Update a menu item', roles: managers, params: [pathId(), pathId('itemId')], requestBody: body({ ...menuInput, minProperties: 1 }), responses: { 200: ok(ref('MenuItem')), 400: E[400], 403: E[403], 404: E[404] } }));
add('/restaurants/{id}/menu/{itemId}', 'delete', op({ tag: 'Catalog (management)', operationId: 'deleteMenuItem', description: restaurantAdminNote, summary: 'Delete a menu item', roles: managers, params: [pathId(), pathId('itemId')], responses: { 204: { description: 'Deleted' }, 403: E[403], 404: E[404] } }));
add('/restaurants/{id}/menu/{itemId}/availability', 'patch', op({ tag: 'Catalog (management)', operationId: 'setAvailability', description: restaurantAdminNote, summary: 'Mark an item (un)available', roles: managers, params: [pathId(), pathId('itemId')], requestBody: body({ type: 'object', required: ['isAvailable'], additionalProperties: false, properties: { isAvailable: { type: 'boolean' } } }), responses: { 200: ok(ref('MenuItem')), 403: E[403], 404: E[404] } }));

// ------------------------------------------------------------------ orders
add('/orders', 'post', op({
  tag: 'Orders', operationId: 'placeOrder', summary: 'Place an order', roles: ['customer'],
  description: 'Prices come from the Order Service\'s catalog read model; **never send prices or totals** (strict schema). Publishes `order.created.v1` + `order.status_changed.v1`.',
  params: [idempotencyKey(false, 'Retries with the same key return the original order (200, `Idempotent-Replayed: true`).')],
  requestBody: body(
    { type: 'object', required: ['restaurantId', 'items', 'deliveryAddress'], additionalProperties: false, properties: { restaurantId: objectId, items: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', required: ['menuItemId', 'quantity'], additionalProperties: false, properties: { menuItemId: objectId, quantity: { type: 'integer', minimum: 1, maximum: 20 } } } }, deliveryAddress: address, notes: { type: 'string', maxLength: 300 }, discountCode: { type: 'string', pattern: '^[A-Za-z0-9]{3,20}$' } } },
    { restaurantId: '5d76d0a773b899a3c0c817b0', items: [{ menuItemId: '74a73ddec378d05239b6f639', quantity: 2 }], deliveryAddress: { line1: '12, Road No. 3', city: 'Hyderabad', pincode: '500034' }, discountCode: 'WELCOME50' },
  ),
  responses: {
    201: ok(ref('Order'), 'Created'), 200: ok(ref('Order'), 'Idempotent replay'), 400: E[400], 403: E[403],
    422: err('Order cannot be placed', ['RESTAURANT_NOT_FOUND', 'RESTAURANT_CLOSED', 'ORDER_ITEMS_INVALID']),
    503: err('Catalog read model not ready or possibly stale (retry shortly)', ['CATALOG_SYNC_PENDING', 'CATALOG_SYNC_UNAVAILABLE']),
  },
}));
add('/orders', 'get', op({
  tag: 'Orders', operationId: 'listOrders', summary: 'Order history', roles: ['customer', 'restaurant_admin', 'platform_admin'],
  description: 'Customers see only their own orders; restaurant admins must pass a `restaurantId` they own; `customerId` filter is admin-only.',
  params: [q('status', { enum: ORDER_STATUSES }), q('restaurantId', objectId), q('customerId', objectId), ...pageParams(50, 10)],
  responses: { 200: page(ref('Order')), 403: E[403], 422: err('restaurantId required', ['RESTAURANT_ID_REQUIRED']) },
}));
const orderReaders = ['customer', 'restaurant_admin', 'delivery_agent', 'platform_admin'];
const orderReaderNote = 'Owner, the restaurant\'s admin, the **assigned** delivery partner, or a platform admin; anyone else gets 404.';
add('/orders/{id}', 'get', op({ tag: 'Orders', operationId: 'getOrder', summary: 'Order details incl. status history and delivery mirror', roles: orderReaders, description: orderReaderNote, params: [pathId()], responses: { 200: ok(ref('Order')), 404: E[404] } }));
add('/orders/{id}/tracking', 'get', op({ tag: 'Orders', operationId: 'getTracking', summary: 'Progress tracker view', roles: orderReaders, description: `${orderReaderNote} Contains no customer contact data or OTP material (only the code's expiry).`, params: [pathId()], responses: { 200: ok(ref('Tracking')), 404: E[404] } }));
add('/orders/{id}/tracking/stream', 'get', op({
  tag: 'Orders', operationId: 'streamTracking', summary: 'Live tracking (Server-Sent Events)', roles: orderReaders,
  description: `${orderReaderNote} \`text/event-stream\`: a snapshot on connect, then \`event: tracking\` per committed change (\`id\` = history length), \`: ping\` heartbeats every 15 s and \`event: end\` once the order is settled (e.g. a cancelled order streams until its refund lands). The token must be in the Authorization header (Swagger UI cannot render streams; use curl -N or the testing console).`,
  params: [pathId()],
  responses: { 200: { description: 'Event stream', content: { 'text/event-stream': { schema: { type: 'string' }, example: 'retry: 3000\n\nid: 4\nevent: tracking\ndata: {"status":"partner_assigned", ...}\n\n' } } }, 404: E[404] },
}));
add('/orders/{id}/cancel', 'post', op({
  tag: 'Orders', operationId: 'cancelOrder', summary: 'Cancel an eligible order', roles: ['customer', 'restaurant_admin', 'platform_admin'],
  description: 'Customer: `pending_payment`, `confirmed`. Restaurant admin: + `assigning_delivery_partner`. Platform admin: + `partner_assigned`. **Nobody after pickup.** A paid order is refunded through the Payment/Billing events; the delivery is cancelled and the partner released.',
  params: [pathId()], requestBody: body({ type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 3, maxLength: 200 } } }, { reason: 'Ordered by mistake' }),
  responses: { 200: ok(ref('Order')), 404: E[404], 409: err('Not cancellable in this state', ['ORDER_NOT_CANCELLABLE', 'CONCURRENT_UPDATE']) },
}));

// ------------------------------------------------------------------ payments
add('/payments/initiate', 'post', op({
  tag: 'Payments', operationId: 'initiatePayment', summary: 'Create or resume the payment for an order', roles: ['customer'],
  description: 'Charges exactly Billing\'s `finalAmount` (from `billing.finalized.v1`). Until it is known: **409 `BILLING_PENDING`** with `Retry-After: 2` — retry. Never send an amount.',
  requestBody: body({ type: 'object', required: ['orderId'], additionalProperties: false, properties: { orderId: objectId } }),
  responses: {
    201: ok(ref('PaymentInitiation'), 'PaymentIntent created'), 200: ok(ref('PaymentInitiation'), 'Existing PaymentIntent reused'), 400: E[400], 403: E[403], 404: E[404],
    409: err('Not payable now', ['BILLING_PENDING', 'ALREADY_PAID', 'ORDER_EXPIRED', 'ORDER_NOT_PAYABLE', 'PAYMENT_PROCESSING']),
    503: err('Payment provider unavailable (safe to retry)', ['PAYMENT_PROVIDER_UNAVAILABLE']),
  },
}));
add('/payments', 'get', op({ tag: 'Payments', operationId: 'listPayments', summary: 'List payments', roles: ['customer', 'platform_admin'], description: 'Customers see their own; `customerId` is admin-only.', params: [q('status', { enum: PAYMENT_STATUSES }), q('orderId', objectId), q('customerId', objectId), ...pageParams(50, 10)], responses: { 200: page(ref('Payment')), 403: E[403] } }));
add('/payments/order/{orderId}', 'get', op({ tag: 'Payments', operationId: 'getPaymentForOrder', summary: 'Payment for an order (with refunds)', roles: ['customer', 'platform_admin'], description: 'Owner or platform admin.', params: [pathId('orderId')], responses: { 200: ok(ref('Payment')), 404: E[404] } }));
add('/payments/{id}', 'get', op({ tag: 'Payments', operationId: 'getPayment', summary: 'Payment details', roles: ['customer', 'platform_admin'], description: 'Owner or platform admin.', params: [pathId()], responses: { 200: ok(ref('Payment')), 404: E[404] } }));
add('/payments/{id}/refund', 'post', op({
  tag: 'Payments (admin)', operationId: 'refundPayment', summary: 'Full or partial refund', roles: ['platform_admin'],
  params: [pathId(), idempotencyKey(true, 'Required: a retried refund with the same key is applied once.')],
  requestBody: body({ type: 'object', required: ['reason'], properties: { amount: { type: 'integer', minimum: 100, description: 'Omit for the full remaining amount' }, reason: { type: 'string', minLength: 3, maxLength: 200 } } }),
  responses: { 202: ok({ type: 'object', description: 'The refund record (completed asynchronously by the provider)' }, 'Refund accepted'), 200: ok({ type: 'object' }, 'Idempotent replay'), 400: E[400], 403: E[403], 404: E[404], 409: err('Not refundable', ['PAYMENT_NOT_REFUNDABLE', 'REFUND_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED']), 422: err('Amount too large', ['REFUND_EXCEEDS_REMAINING']) },
}));
add('/payments/webhook', 'post', op({
  tag: 'Payments', operationId: 'paymentWebhook', summary: 'Payment provider webhook (Stripe-signed)', roles: ['public'],
  description: 'Called by Stripe (or the local mock provider), not by clients. Requires a valid `Stripe-Signature` over the raw body; no JWT.',
  params: [{ name: 'Stripe-Signature', in: 'header', required: true, schema: { type: 'string' } }],
  requestBody: body({ type: 'object', description: 'Stripe event object' }),
  responses: { 200: ok({ type: 'object', properties: { received: { const: true }, eventId: { type: 'string' }, result: { type: 'string', description: "'duplicate' for already-processed events" } } }, 'Accepted'), 400: err('Bad signature', ['INVALID_SIGNATURE']) },
}));
add('/payments/{id}/simulate', 'post', op({
  tag: 'Payments (test only)', operationId: 'simulatePayment', summary: 'Play the customer\'s card step (development only)', roles: ['customer', 'platform_admin'],
  description: 'Exists only when `ENABLE_TEST_ENDPOINTS=true` (local compose default). With the mock provider it completes the PaymentIntent and delivers signed webhooks; `deliveries` > 1 sends duplicates.',
  params: [pathId()], requestBody: body({ type: 'object', required: ['outcome'], properties: { outcome: { enum: ['succeed', 'fail', 'succeed_refund_fails', 'processing'] }, deliveries: { type: 'integer', minimum: 1, maximum: 5, default: 1 } } }, { outcome: 'succeed' }),
  responses: { 202: ok({ type: 'object' }, 'Simulation scheduled (webhooks follow)'), 404: E[404], 409: err('Payment not in a payable state', ['PAYMENT_NOT_INITIATED', 'INVALID_PAYMENT_STATE']) },
}));

// ------------------------------------------------------------------ billing
add('/invoices', 'get', op({ tag: 'Billing', operationId: 'listInvoices', summary: 'List invoices', roles: ['customer', 'platform_admin'], params: [q('orderId', objectId), q('customerId', objectId), ...pageParams(50, 10)], responses: { 200: page(ref('Invoice')), 403: E[403] } }));
add('/invoices/order/{orderId}', 'get', op({ tag: 'Billing', operationId: 'getInvoiceForOrder', summary: 'Invoice for an order (404 until Billing has issued it)', roles: ['customer', 'platform_admin'], params: [pathId('orderId')], responses: { 200: ok(ref('Invoice')), 404: E[404] } }));
add('/invoices/{id}', 'get', op({ tag: 'Billing', operationId: 'getInvoice', summary: 'Invoice by id', roles: ['customer', 'platform_admin'], params: [pathId()], responses: { 200: ok(ref('Invoice')), 404: E[404] } }));
add('/discounts', 'get', op({ tag: 'Billing', operationId: 'listDiscounts', summary: 'Currently usable promo codes', roles: ['optional-auth'], description: 'Platform admins may add `all=true`.', params: [q('all', bool)], responses: { 200: ok({ type: 'array', items: ref('Discount') }) } }));
add('/discounts', 'post', op({
  tag: 'Billing (admin)', operationId: 'createDiscount', summary: 'Create a discount code', roles: ['platform_admin'],
  requestBody: body({ type: 'object', required: ['code', 'description', 'type', 'value'], additionalProperties: false, properties: { code: { type: 'string', pattern: '^[A-Za-z0-9]{3,20}$' }, description: { type: 'string' }, type: { enum: ['percent', 'flat'] }, value: { type: 'integer', minimum: 1 }, maxDiscount: { type: 'integer' }, minItemsSubtotal: paise, active: { type: 'boolean' }, validFrom: dateTime, validUntil: dateTime } }, { code: 'DIWALI30', description: '30% off for Diwali', type: 'percent', value: 30, maxDiscount: 20000, minItemsSubtotal: 49900 }),
  responses: { 201: ok(ref('Discount'), 'Created'), 400: E[400], 403: E[403], 409: err('Code exists', ['DISCOUNT_EXISTS']) },
}));
add('/discounts/{code}', 'patch', op({ tag: 'Billing (admin)', operationId: 'setDiscountActive', summary: 'Activate/deactivate a code', roles: ['platform_admin'], params: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object', required: ['active'], additionalProperties: false, properties: { active: { type: 'boolean' } } }), responses: { 200: ok(ref('Discount')), 403: E[403], 404: E[404] } }));

// ------------------------------------------------------------------ deliveries
const agentOnly = ['delivery_agent'];
const assignedNote = 'Only the **assigned** partner (identity from the JWT; bodies never name an agent). Others get 404; other roles 403.';
add('/deliveries/agents/me', 'get', op({ tag: 'Delivery partners', operationId: 'getAgentMe', summary: 'Own partner profile and active delivery', roles: agentOnly, responses: { 200: ok({ allOf: [ref('Agent'), { type: 'object', properties: { activeDelivery: nullable(ref('Delivery')) } }] }), 403: E[403], 404: E[404] } }));
add('/deliveries/agents/me', 'put', op({
  tag: 'Delivery partners', operationId: 'upsertAgentMe', summary: 'Register / update own profile and availability', roles: agentOnly,
  requestBody: body({ type: 'object', additionalProperties: false, properties: { phone, available: { type: 'boolean' } } }, { phone: '9845012301', available: true }),
  responses: { 200: ok(ref('Agent')), 400: E[400], 403: err('Not a delivery agent, or the account was deactivated (sign in again after reactivation) or deleted', ['FORBIDDEN', 'ACCOUNT_DISABLED', 'ACCOUNT_DELETED']), 409: err('Busy partners cannot go offline', ['AGENT_BUSY']), 422: err('Phone required on first registration', ['PHONE_REQUIRED']) },
}));
add('/deliveries/agents', 'get', op({ tag: 'Deliveries (admin)', operationId: 'listAgents', summary: 'All delivery partners', roles: ['platform_admin'], params: [q('status', { enum: ['available', 'busy', 'offline'] })], responses: { 200: ok({ type: 'array', items: ref('Agent') }), 403: E[403] } }));
add('/deliveries', 'get', op({ tag: 'Deliveries', operationId: 'listDeliveries', summary: 'List deliveries', roles: ['delivery_agent', 'platform_admin'], description: 'Partners see their own.', params: [q('status', { enum: DELIVERY_STATUSES }), ...pageParams(50, 20)], responses: { 200: page(ref('Delivery')), 403: E[403] } }));
add('/deliveries/order/{orderId}', 'get', op({ tag: 'Deliveries (admin)', operationId: 'getDeliveryForOrder', summary: 'Delivery for an order', roles: ['platform_admin'], params: [pathId('orderId')], responses: { 200: ok(ref('Delivery')), 403: E[403], 404: E[404] } }));
add('/deliveries/{id}', 'get', op({ tag: 'Deliveries', operationId: 'getDelivery', summary: 'Delivery (agent view)', roles: ['delivery_agent', 'platform_admin'], description: 'Assigned partner or platform admin.', params: [pathId()], responses: { 200: ok(ref('Delivery')), 403: E[403], 404: E[404] } }));
const stateErrors = (codes) => ({ 404: E[404], 403: E[403], 409: err('Not allowed in the current delivery state', codes) });
add('/deliveries/{id}/pickup', 'post', op({ tag: 'Deliveries', operationId: 'pickup', summary: 'Partner picked the order up (partner_assigned → picked_up)', roles: agentOnly, description: `${assignedNote} Publishes \`delivery.picked_up.v1\` → order \`out_for_delivery\`.`, params: [pathId()], responses: { 200: ok(ref('Delivery')), ...stateErrors(['DELIVERY_ALREADY_PICKED_UP', 'INVALID_DELIVERY_STATE', 'DELIVERY_CANCELLED', 'ALREADY_DELIVERED', 'CONCURRENT_UPDATE']) } }));
add('/deliveries/{id}/arrived', 'post', op({ tag: 'Deliveries', operationId: 'arrived', summary: 'Partner reached the customer (picked_up → arrived); issues the OTP', roles: agentOnly, description: `${assignedNote} The 6-digit code is emailed to the customer through the restricted channel; it is never in this response.`, params: [pathId()], responses: { 200: ok(ref('Delivery')), ...stateErrors(['DELIVERY_NOT_PICKED_UP', 'DELIVERY_ALREADY_ARRIVED', 'DELIVERY_CANCELLED', 'CONCURRENT_UPDATE']) } }));
add('/deliveries/{id}/verify-otp', 'post', op({
  tag: 'Deliveries', operationId: 'verifyOtp', summary: 'Submit the customer\'s code (arrived → delivered)', roles: agentOnly,
  description: `${assignedNote} 5 attempts per code (counted atomically), 5-minute expiry. Success publishes \`delivery.completed.v1\` (otpVerified) → order \`delivered\`.`,
  params: [pathId()], requestBody: body({ type: 'object', required: ['otp'], additionalProperties: false, properties: { otp: { type: 'string', pattern: '^\\d{6}$' } } }, { otp: '482913' }),
  responses: {
    200: ok(ref('Delivery')), ...stateErrors(['DELIVERY_NOT_ARRIVED', 'ALREADY_DELIVERED', 'DELIVERY_CANCELLED', 'OTP_NOT_ISSUED']),
    410: err('Code expired; request a new one', ['OTP_EXPIRED']), 422: err('Wrong code (n attempts remaining)', ['OTP_INVALID']), 423: err('Too many wrong codes; request a new one', ['OTP_LOCKED']),
  },
}));
add('/deliveries/{id}/resend-otp', 'post', op({ tag: 'Deliveries', operationId: 'resendOtp', summary: 'Issue a new code (supersedes the old one)', roles: agentOnly, description: `${assignedNote} At most 3 codes per delivery, 30 s apart.`, params: [pathId()], responses: { 200: ok(ref('Delivery')), ...stateErrors(['DELIVERY_NOT_ARRIVED', 'DELIVERY_CANCELLED']), 429: err('Too soon or limit reached', ['OTP_RESEND_TOO_SOON', 'OTP_RESEND_LIMIT']) } }));
add('/deliveries/{id}/retry-assignment', 'post', op({ tag: 'Deliveries (admin)', operationId: 'retryAssignment', summary: 'Re-queue a delivery whose assignment failed', roles: ['platform_admin'], params: [pathId()], responses: { 200: ok(ref('Delivery')), 403: E[403], 409: err('Assignment did not fail', ['DELIVERY_NOT_RETRYABLE']) } }));

export default {
  openapi: '3.1.0',
  info: {
    title: 'Food Ordering Platform — client API',
    version: '1.0.0',
    description: [
      'Every client-facing endpoint routed by the API gateway (http://localhost:8080). Services communicate with each other only through RabbitMQ events, which are documented in API.md / ARCHITECTURE.md §16.3, not here.',
      '',
      '**Authentication:** log in with `POST /auth/login`, then click **Authorize** and paste the `accessToken`. Each operation lists the roles allowed (`x-roles`).',
      '',
      '**Money** is always integer paise. **Envelope:** `{ "success": true, "data": … , "meta"? }` or `{ "success": false, "error": { "code", "message", "details"? } }`. Every response has an `x-request-id` header.',
      '',
      'Not described (internal only): the Notification Service, RabbitMQ, MongoDB and the per-service ports.',
    ].join('\n'),
  },
  servers: [{ url: 'http://localhost:8080', description: 'API gateway (local Docker Compose)' }],
  tags: [
    { name: 'Health', description: 'Gateway and per-service health (MongoDB critical, RabbitMQ/SMTP optional).' },
    { name: 'Auth', description: 'Auth Service: registration, login (JWT), own profile.' },
    { name: 'Auth (admin)', description: 'Auth Service: staff accounts and moderation (platform admin).' },
    { name: 'Catalog', description: 'Catalog Service: public browsing of restaurants and menus.' },
    { name: 'Catalog (management)', description: 'Catalog Service: restaurant/menu management by owners and admins.' },
    { name: 'Orders', description: 'Order Service: placement, history, cancellation, tracking (REST + SSE).' },
    { name: 'Payments', description: 'Payment Service: initiation, status, provider webhook.' },
    { name: 'Payments (admin)', description: 'Payment Service: manual refunds (platform admin).' },
    { name: 'Payments (test only)', description: 'Development-only simulation of the card step (ENABLE_TEST_ENDPOINTS=true).' },
    { name: 'Billing', description: 'Billing Service: immutable invoices and promo codes.' },
    { name: 'Billing (admin)', description: 'Billing Service: discount code management (platform admin).' },
    { name: 'Delivery partners', description: 'Delivery Service: a partner\'s own profile and availability.' },
    { name: 'Deliveries', description: 'Delivery Service: pickup, arrival and OTP verification by the assigned partner.' },
    { name: 'Deliveries (admin)', description: 'Delivery Service: operator views and assignment retry.' },
  ],
  paths,
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas },
};
