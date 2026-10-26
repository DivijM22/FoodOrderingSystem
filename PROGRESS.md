# Progress

_Last updated: 2026-10-21_

## Stage status

| Stage | Scope | Status |
|---|---|---|
| 0 | Architecture, monorepo, tooling, Docker Compose, contracts | ✅ Complete |
| 1 | Authentication Service | ✅ Complete (tested + containerized) |
| 2 | Restaurant/Catalog Service + seed data | ✅ Complete (tested + containerized) |
| 3 | Order Service + RabbitMQ events (outbox) | ✅ Complete (tested + containerized) |
| 4 | Payment Service (Stripe test mode) | 🟡 Implemented and verified with the **mock provider** and stripe-mock. **Real Stripe test-mode run still pending** (no credentials) |
| 4.1 | Automatic expiration of unpaid orders | ✅ Complete (tested + live) |
| 5 | Billing Service (tax excluded for now) | ✅ Complete (tested + live) |
| 5.1 | Event-driven communication refactor (no internal HTTP, order lifecycle authority, tracking) | ✅ Complete (tested + live) |
| 7 | Notification Service (email via SMTP; Mailpit locally) | ✅ Complete (tested + live), done before Stage 6 at the user's request |
| 6 | Delivery Service (partners, assignment, OTP, restricted notification, live tracking, per-service broker users) | ✅ Complete (tested + live) |
| 8 | Developer testing console, OpenAPI/Swagger, observability, scenario runner, full-system verification | ✅ Complete (tested + live, incl. headless-browser walkthrough) |
| 8.1 | Role-aware testing console | ✅ Complete (functional testing deferred) |
| 8.2 | Many-to-many restaurant administration, deactivation events, `catalog.restaurant.updated.v2` | ✅ Implemented (typecheck + OpenAPI check only; functional testing deferred) |
| 8.3 | Sample catalog seed (5 restaurants) | ✅ Seeded locally and verified in the Catalog DB, the Order projection and the public API |
| 8.4 | Documentation and team handover (TEAM_HANDOVER.md, DEPLOYMENT_GUIDE.md) | ✅ Documentation only; no tests run |
| F0–F5 | React web frontend for all four roles (`frontend/`, Compose service on :3000) | ✅ Implemented; four-role browser walkthrough passed locally (partial coverage, see below) |
| 9 | Secure account deletion: `DELETE /auth/users/:id`, `auth.user.deleted.v1`, Catalog/Delivery cleanup, last-admin guard, admin search + delete UI | ✅ Implemented; typecheck, builds, OpenAPI and Compose checks, and new targeted tests pass. **Not run against the live stack** |
| Cloud | Cloud deployment (handled by teammates; see DEPLOYMENT_GUIDE.md) | ⏳ Not started. No cloud resources created |

## Environment

| Tool | Version | Notes |
|---|---|---|
| OS | Ubuntu 26.04 on WSL2 | |
| Node.js / npm | 24.16.0 / 11.13.0 | already installed via nvm |
| TypeScript | 7.0.2 | |
| Docker Desktop | 29.7.2, Compose v5.4.0 | WSL integration enabled (native `docker` in WSL, bind mounts work) |
| MongoDB | 8.0 (container, single-node replica set `rs0`) | |
| RabbitMQ | 4.1-management (container) | |
| Mailpit | axllent/mailpit v1.31.6 (container) | local SMTP capture, UI/API on :8025 |
| amqplib | (existing dependency) | also used by `scripts/e2e-delivery.mjs` to probe per-service broker permissions |
| Nodemailer | 10.1.2 | Notification Service SMTP client |
| Tests | Vitest 5, Supertest 7, mongodb-memory-server 11 | |
| Stripe | SDK `stripe@23.0.0` (API 2526); `stripe/stripe-mock` container for request-shape tests | no Stripe credentials or Stripe CLI available |

No host-level databases or brokers were installed; all infrastructure runs in containers.

## Stage 0: Architecture and environment ✅

- npm-workspaces monorepo: `packages/common` + `services/{auth,catalog,order}`.
- `@food/common` (infrastructure only): zod config loader, pino logger with redaction, `AppError`
  hierarchy, central error handler, request validation, JWT sign/verify, `authenticate`/`authorize`
  middleware, health router (critical vs optional checks), service-to-service HTTP client with
  timeouts, Mongo connect with retry, graceful shutdown, RabbitMQ `MessageBroker` (reconnect,
  confirms, retry queue, DLQ), `processOnce` consumer idempotency, **versioned zod contracts for all
  9 events**.
- `docker-compose.yml`: MongoDB replica set (auto-initiated by its health check), RabbitMQ with
  management UI, the services and an nginx gateway, all with health checks.
- `.env.example` at the root and per service. `.env` is git-ignored.
- Documentation: ARCHITECTURE.md (Mermaid system, sequence, state and AWS diagrams), API.md, README.md.

## Stage 1: Authentication Service ✅

Implemented: customer registration, login, bcrypt hashing, JWT access tokens (HS256, iss/aud, 1 h),
`/auth/verify`, `/auth/me` (get/update incl. saved addresses), password change, platform-admin user
management (create staff accounts, list/filter, activate/deactivate), bootstrap admin, timing-safe login
for unknown emails, strict input validation.

## Stage 2: Catalog Service ✅

Implemented: restaurant CRUD (soft delete), menu item CRUD, availability toggle, open/closed status,
listing with search (name/cuisine/tag/**dish**), filters (cuisine, city, open, pure-veg, rating, cost),
5 sort orders, pagination, cuisine list, ownership-based management (restaurant admins manage only
their own restaurants; only platform admins change ownership/listing status), pure-veg enforcement.

Seed data: **16 fictional restaurants, 162 menu items**, 10 cities. The mix covers Hyderabadi, South
Indian, Punjabi, Mangalorean, Mumbai street food, Gujarati/Rajasthani, Kerala, Awadhi, Indo-Chinese,
fast food, a café, a dessert shop, Italian, Japanese, Mexican and Lebanese. INR prices, veg and non-veg,
bestsellers, spice levels, **7 unavailable items** and **1 closed restaurant** for testing failure
paths. Stable deterministic IDs. Idempotent seeding: a re-run inserts 0 and updates 0; `--reset`
restores seed values.

## Stage 3: Order Service ✅

Implemented: authenticated order placement (customers only), restaurant and item validation against the
live catalog (sync REST, 3 s timeout), server-side pricing (client prices rejected), name/price
snapshots, provisional total (`subtotal + ₹40 delivery fee`, waived at ₹499+), state machine with
role-gated transitions and compare-and-set updates, status history, order history (paginated, filtered,
role-scoped), cancellation rules per actor, `refund_pending` for cancelled paid orders,
`Idempotency-Key` support, and **transactional outbox** publishing `order.created.v1` /
`order.cancelled.v1` to RabbitMQ with ordering, backoff and multi-replica lease locks.

## Stage 4: Payment Service 🟡

**Implemented** (`services/payment`, port 4004, database `payment_db`):
- Payment record per order, created from `order.created.v1` (unique `orderId`; redelivery-safe). If the
  event hasn't arrived yet, initiation creates the record from the Order Service's REST response.
- `POST /payments/initiate`: ownership, eligibility and amount come from the Order Service (customer JWT
  forwarded); client amounts are rejected. One PaymentIntent per payment (`pi:<paymentId>` idempotency
  key), reused on retry and on concurrent clicks. The client secret is never persisted.
- Stripe webhook endpoint: SDK signature verification over the raw body; idempotent by event id; a state
  machine that ignores stale/out-of-order events; amount/currency checked against our record.
- Payment state machine with **separate lifecycle and refund-outcome tables** (see ARCHITECTURE §13.3).
- Cancellation: pending → cancelled; open intent → cancelled at the provider; captured → automatic refund
  (at most one, unique key); the success-versus-cancellation race in both orderings; refund failures recorded
  and published, never retried automatically.
- Admin partial/full refunds (`Idempotency-Key`); `GET` endpoints with owner/admin access.
- Reconciler: provider calls outside DB transactions, retried with exponential backoff, plus polling
  for lost webhooks.
- Events through the shared transactional outbox: `payment.succeeded / failed / cancelled / refund.completed / refund.failed` (v1).
- Providers: `StripeProvider` (official SDK, **test keys only**, live keys refused at startup, hard
  per-call deadline) and a clearly labelled, Mongo-backed `MockPaymentProvider` that sends webhooks
  signed with Stripe's scheme.
- Test-only `POST /payments/:id/simulate` (plays the customer's card step; still webhook-driven).
- Docker image, compose service (health check, restart policy, env config), gateway route `/payments`.

**Order Service changes:** consumes `payment.*` (queue `order-service.payment-events`; idempotent, CAS,
non-regressing `paymentStatus` table). A verified payment confirms the order; a failure leaves it payable;
`paymentHistory` on orders. The interim admin "confirm/payment_failed" transitions are removed.

**Shared package changes:** the outbox moved to `@food/common`; payment contracts revised;
`PermanentEventError` (straight to DLQ); `parseEventData`; raw-body capture; a plain-Node ESM load test.

**Bugs found during Stage 4 and fixed:**
1. *State machine:* a delayed `payment_intent.succeeded` could move a `refunded` payment back to
   `succeeded` (and re-publish `payment.succeeded`). Lifecycle and refund-outcome transitions are now
   separate tables, with dedicated tests. Found by the race-B test.
2. *Stripe SDK hang:* SDK v23 never settled requests to an unreachable host, even with `timeout` set.
   Every Stripe call now has a hard deadline and surfaces `ProviderUnavailableError`.
3. *ESM import:* `import { models } from 'mongoose'` passed under Vitest but crashed every container
   (CommonJS named-export detection). Fixed, plus a test that loads the built package in plain Node.
4. *Test hygiene:* the RabbitMQ integration test would have deleted the live `payment-service.order-events`
   queue during cleanup. Queue names are now injectable and tests use unique names.

### Stripe verification status (explicit)

| What | Status |
|---|---|
| Provider-independent workflow (records, states, refunds, races, events) | ✅ verified (automated + live stack, mock provider) |
| Webhook signature verification (official SDK `constructEvent`, tolerance, tampering) | ✅ verified offline with SDK-generated signatures |
| Live-key refusal / test-mode guard | ✅ verified |
| StripeProvider request shapes (create/retrieve/cancel/confirm PaymentIntent, create/retrieve refund) | ✅ against **stripe-mock** (Stripe's official OpenAPI mock); stateless, not real Stripe |
| Real Stripe test mode (real PaymentIntents, `stripe listen` webhooks, test cards, refund settlement, INR account specifics) | ❌ **not verified**: no `sk_test_` / `whsec_` credentials available |

## Stage 5: Billing Service ✅

Taxes are **deliberately excluded** (project focus: microservices and reliability). `taxAmount = 0`, and the
schema keeps `taxLines` + `schemaVersion` so tax can be added later.

**Implemented** (`services/billing`, port 4005, `billing_db`):
- One **immutable**, itemised invoice per order (unique `orderId`) from `order.created.v1`; immutability is
  enforced at the model layer (every update/delete is rejected).
- **Subtotal verification:** each line, Σ lines = subtotal, and subtotal + delivery fee = provisional total. A mismatch means
  no invoice (DLQ / 422).
- **Discounts:** optional `discountCode` on orders, validated by Billing (percent with cap, or flat; minimum
  subtotal; active/validity window); rejections are recorded on the invoice; seeded demo codes.
- `finalAmount = subtotal − discountAmount + taxAmount`, where `subtotal` includes the delivery fee as an invoice line,
  so the existing ₹40 fee isn't lost. Discounts never push the amount below ₹1.
- **Adjustments ledger** (immutable, unique per kind and reference): payment, refund (credit note), refund reversal,
  closure (cancellation/expiry voids an unpaid invoice). Invoice status is derived from it.
- **Issue-on-demand** REST endpoint for delayed billing events (idempotent, race-safe).
- `billing.invoice_generated.v1` via the transactional outbox.

**Integration changes:**
- *Payment Service:* charges only `invoice.finalAmount`. The payment record's amount is unset until the invoice arrives
  (event, or issue-on-demand at initiation); `409 INVOICE_NOT_READY`, and 503 if Billing is down (nothing charged).
  Exactly one invoice per payment; `payment.succeeded` carries `invoiceId`.
- *Order Service:* accepts `discountCode`; mirrors `billing` from the invoice event; verifies
  `payment.succeeded.amount === billing.finalAmount` (bounded ≤ provisional total if the mirror hasn't arrived yet).
- *Shared:* revised `billing.invoice_generated.v1` (never published before); optional `discountCode` on
  `order.created`, optional `invoiceId` on `payment.succeeded`. A 503 "dependency unavailable" is now logged at warn,
  not error. (A live outage test had produced error-level "Unhandled error" lines for a handled condition.)
- The 15-minute expiry is unchanged; Billing voids expired invoices.

**Tests added:** billing 22 (calculator 6, invoices/ledger/immutability/issue-on-demand/discounts 16),
order +6 (discount codes, invoice mirror, payment verification against the invoice), payment +6 (charges the
invoice amount, delayed invoice, Billing unavailable, one invoice per payment, invoice before
order.created, refund of a discounted payment), common +1.

**Live verification:** `scripts/e2e-billing.mjs --expiry --resilience` → **31/31**: promo list; FEAST20 →
₹1107 − ₹150 = ₹957 charged (not ₹1107), `payment.succeeded` with `invoiceId`, Order mirror, invoice `paid`;
expired code at full price with reason; refund as `CN-` credit note with the invoice unchanged; void on cancel and on
expiry; duplicate `order.created` / `payment.succeeded` (including a new event id) counted once; Billing stopped →
initiation 503 and queued event processed on restart; RabbitMQ stopped → invoice issued on demand, with one invoice after recovery.

## Stage 5.1: Event-driven communication refactor ✅

Goal: services communicate only through RabbitMQ events (choreography); clients use REST through the gateway.
Details: [ARCHITECTURE.md §16](ARCHITECTURE.md#16-final-communication-architecture-event-driven-choreography).

**Internal HTTP removed (all 5 calls; none retained):**

| Before | Replacement |
|---|---|
| Order → Catalog `GET /restaurants/:id/menu` (pricing) | versioned **catalog read model** in the Order Service from `catalog.restaurant.updated.v1` (full snapshot per restaurant, `catalogVersion` CAS). Placement returns 503 `CATALOG_SYNC_PENDING` / `CATALOG_SYNC_UNAVAILABLE` rather than use possibly stale data |
| Order → Catalog `GET /restaurants/:id` (ownership) | same read model (`ownerId`) |
| Payment → Order `GET /orders/:id` | `customerId` / `expiresAt` from `order.created`; closures from `order.cancelled` / `order.expired` |
| Payment → Billing `POST /invoices/order/:id/issue` | `billing.finalized.v1`; before it, `409 BILLING_PENDING` + `Retry-After: 2` |
| Billing → Order `GET /orders/:id` (issue-on-demand) | removed together with the endpoint |

No synchronous dependency was judged essential for correctness, so no approval for an exception was needed.

**Order lifecycle:** the Order Service is the sole writer of order status: `pending_payment → confirmed →
assigning_delivery_partner → partner_assigned → out_for_delivery → location_reached → delivered` (+ cancelled, expired;
refund states stay in `paymentStatus`). History entries carry `sourceEventId`, `sourceService` and `metadata`. Every accepted
transition publishes `order.status_changed.v1` (plus the domain event `order.confirmed` / `order.cancelled` / `order.expired`)
in the same transaction. `PATCH /orders/:id/status` was removed (404); `GET /orders/:id/tracking` was added. Delivery facts
(`delivery.ready_for_pickup / partner_assigned / picked_up / location_reached / completed`) are consumed now with rank
ordering: early events are retried, stale or duplicate ones ignored, and closed orders ignore delivery events. The OTP has its own
restricted design (`food.restricted` exchange, sealed payload, never persisted or logged), to be implemented in Stage 6.

**Billing:** publishes `billing.finalized.v1` (adds `invoiceVersion`, `expiresAt`); consumers still accept the legacy
`billing.invoice_generated.v1`. Per-service RabbitMQ users are designed (§16.8) but not yet applied (all services share `food`).

## Stage 7: Notification Service ✅

Internal service (`services/notification`, port 4006 inside the Docker network only, `notification_db`). See
[ARCHITECTURE.md §17](ARCHITECTURE.md#17-notification-service).

- Queue `notification-service.order-events` bound to `order.#`; **only `order.status_changed.v1` produces email**.
- 8 templates (HTML + text): order confirmed (covers payment received), cancelled, expired, delivery assignment started,
  partner assigned, out for delivery, partner arrived, delivered. `pending_payment` sends nothing.
- Durable record per (order, status) (unique `dedupeKey`), inserted **before** the message is acked; a separate sender
  claims due records with a lease and sends via Nodemailer. Transient SMTP errors are retried with exponential backoff (≤ 10 min,
  8 attempts); 5xx fails permanently; the failure history is stored. Malformed events go to the DLQ.
- Known, documented duplicate risk: SMTP accept and the "sent" write are not atomic (crash in between → resend
  with the same `Message-ID`).
- Mailpit in compose (UI http://localhost:8025). **No email was delivered to a real mailbox**; all verification used Mailpit.

## Stage 9: Secure account deletion

- **Auth.**
  - New endpoint `DELETE /auth/users/:id` (platform admin). It accepts only inactive accounts, never the caller's own, and requires the caller to still
    be an active platform admin in `auth_db`.
  - Delivery agents with an active delivery are refused (409 `AGENT_HAS_ACTIVE_DELIVERY`). This uses a projection fed by `delivery.partner_assigned/completed/cancelled.v1`
    (queue `auth-service.delivery-events`).
  - The delete and `auth.user.deleted.v1 {userId, role, deletedAt}` commit in one transaction; a repeated delete is a 404 with no event.
  - Deactivation now refuses the last active platform admin (409 `LAST_ACTIVE_ADMIN`); concurrent admin deactivations serialize on `auth_db.locks`.
  - `AuthUser.issuedAt` (JWT `iat`) is now exposed by `verifyAccessToken`.
- **Catalog.** `catalog-service.auth-events` also consumes `auth.user.deleted.v1`. The id is tombstoned (`deleted_users`) and removed from every restaurant's
  `adminIds` with no timestamp cut-off, because ids are never reused. Each change publishes a v2 snapshot. Tombstoned ids get 409 `USER_DELETED` on assignment.
- **Delivery.** New `delivery-service.auth-events` (deactivated + deleted, agents only) writes `account_blocks`:
  - blocked agents are skipped by assignment, go offline (or on release), and cannot register or go available;
  - a held delivery stays with the agent;
  - deactivation blocks lift when the agent uses a token issued after reactivation; deletion is permanent.
- **Frontend.** All accounts gains a search box (name, email or id) over all pages of the role, with client-side paging, and a Delete action for inactive accounts
  other than your own. The confirmation dialog shows name, email and role and requires an explicit acknowledgement.
- No new services, no synchronous calls, no broker permission changes: services already read their own queues.
- **Verification:**
  - passed: `npm run typecheck` (all workspaces, tests included), `npm run build --workspaces`, frontend `npm run build`,
    `node scripts/openapi.mjs check` (56 operations), `docker compose config -q`;
  - new targeted test files passed: `services/auth/test/delete-user.test.ts` (8, incl. concurrent mutual deactivation),
    `services/delivery/test/account-blocks.test.ts` (4), and the new case in `services/catalog/test/catalog.test.ts` (file: 19/19);
  - also re-run: `packages/common/test/auth.test.ts` (6/6) and `services/delivery/test/delivery.test.ts` (29/29). In `services/auth/test/auth.test.ts`,
    18 of 19 pass; the one failure is pre-existing (limitation 32);
  - the full suites, E2E scripts and live-stack checks were **not** run. The containers were not rebuilt, and no account was created or deleted.

## Stages F0–F5: Web frontend

- New `frontend/` (React 19, TypeScript, Vite, React Router). It is independent of the npm workspaces and has its own lockfile, Dockerfile (nginx static) and
  Compose service `frontend` on **http://localhost:3000**. The gateway URL is runtime config (`API_URL` → `/config.js`), and the browser calls the gateway directly (CORS).
  The JWT is kept in sessionStorage. **No backend change was needed.**
- Commits:
  - F0: foundation and auth (`c3dbb92`);
  - F1: customer ordering, simulated payment and SSE tracking (`2b47165`);
  - F2: platform admin (`b269b45`);
  - F3: restaurant admin (`bd90f59`);
  - F4: delivery agent (`7582297`);
  - F5: refinements (`d6d35b0`).
- **Verified:**
  - type check and production build;
  - the image builds and the container runs healthy;
  - CORS preflight from the frontend's origin through the gateway;
  - a headless-browser walkthrough of all four roles on 2026-10-26 (27 steps, outside the repo), covering account creation with restaurant assignment, agent
    availability, registration, ordering, invoice, simulated payment, live SSE tracking, pickup, arrival, wrong and correct delivery codes, delivered, restaurant-admin
    views and an availability toggle, the role guard, and deactivation removing the assignment.

  Three runs (two resumed after test-script fixes) created 9 test accounts (`ui.*@example.com`: 3 restaurant admins, 3 agents, 3 customers) and 3 delivered orders on *Saffron Handi Biryani*. All 9 accounts were deactivated by the walkthrough itself.
- **Bugs found and fixed by the walkthrough:**
  - the first request after a page reload carried no JWT;
  - the delivery-completed message vanished;
  - the invoice status did not refresh after payment;
  - the agent history did not refresh.
- **Not exercised in a browser:** the declined-payment retry, cancellation and refund, restaurant creation, menu add/edit/delete, details editing, assignment
  removal in the UI, the partial-assignment-failure retry, code resend, the polling fallback, session expiry, and the history refresh within one delivery (fixed after the run).

## Stage 8.4: Documentation and team handover

- New **[TEAM_HANDOVER.md](TEAM_HANDOVER.md)**, the entry document for teammates. It covers:
  - the overview and stack;
  - the service table and repository navigation;
  - the complete order lifecycle (table + sequence diagram), with cancellation, refunds, expiry and failure paths;
  - events, databases, the RBAC matrix, local setup, testing, cloud prerequisites, limitations and the reading order.
- New **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)**. It covers:
  - images and build contexts, ports and exposure;
  - gateway routing and service discovery;
  - MongoDB and RabbitMQ requirements;
  - every environment variable and secret;
  - startup order, health and restarts, logging;
  - Mailpit for the demo;
  - **deployment blockers** and a checklist.
- ARCHITECTURE.md:
  - new §21 service reference cards;
  - expanded §4 (physical vs logical databases, indexes, initialization);
  - corrected outdated statements: repository layout, which services use the outbox, consumer idempotency mechanisms, event-matrix consumers, local Compose contents, the request-id note, Catalog's deactivation consumer (idempotent by state, not `processOnce`);
  - the AWS section marked as an unimplemented proposal;
  - Mailpit retained for the demo.
- README rewritten as an entry point. TESTING_GUIDE has a per-suite side-effects table (Docker needs, persistent data, containers stopped, catalog assumptions)
  and a demo walkthrough corrected for platform-admin-only restaurant creation.
- Docs were reconciled against the code (routes via `scripts/openapi.mjs`, event contracts, Compose, `config.ts`). **No code, schema, topology or Compose
  change was made; no tests were run.** Docker Desktop was not running during this milestone, so no live checks were possible (none were required).

## Stage 8.2: Many-to-many restaurant administration and RBAC

- Catalog `ownerId` → **`adminIds: string[]`** (+ `adminAssignedAt` per admin). Any number of identical-permission administrators per
  restaurant; no hierarchy. Only platform admins create restaurants (optional initial `adminIds`) and manage assignments:
  `POST /restaurants/:id/admins {userId}` (`$addToSet`), `DELETE /restaurants/:id/admins/:userId` (`$pull`). New `GET /restaurants/mine`.
  Assigned restaurant admins update details, open/close, menu, prices and availability, and view/cancel orders; `status` is platform-only.
  `adminIds` is shown only to platform admins and the restaurant's own administrators.
- **Auth publishes events** for the first time: broker user `auth-service` (topic write `^auth\.`), outbox + relay;
  `PATCH /auth/users/:id/status {isActive:false}` atomically deactivates and enqueues **`auth.user.deactivated.v1`** (nothing if already
  inactive). Catalog (`catalog-service.auth-events`) pulls the user from every restaurant assigned **before** `deactivatedAt` (delayed or
  duplicate events cannot remove a later re-assignment) and publishes snapshots. Reactivation restores nothing.
- **`catalog.restaurant.updated.v2`** (`adminIds`) replaces v1, which is retired (unbound and rejected). The Order projection stores `adminIds`.
- Idempotent startup migrations in Catalog (`ownerId` → `adminIds`, version bump + snapshot) and the Order projection; seed uses `adminIds: []`.
- Console: Create User requires ≥1 restaurant for a new restaurant admin (partial-failure retry re-sends only failed assignments,
  never re-creates the user); platform admin creates restaurants and adds/removes administrators; restaurant admin sees assigned restaurants.
- Limitations: issued JWTs stay valid until expiry (≤ 1 h); access removal is eventually consistent; Auth/Catalog clock-skew caveat;
  Catalog cannot verify an assigned id's role (no Auth projection by design). Details: ARCHITECTURE §20.
- **Functional testing deferred** at the user's request (typecheck and OpenAPI route check only).

## Stage 8.1: Role-aware testing console

The console at http://localhost:3100 now supports all four roles with real input forms (no generated accounts): public customer registration
(name, email, password + confirmation; no phone — see below) and login for any role, with logout; platform admins create restaurant admins, delivery agents
and platform admins (`POST /auth/users`), list users and assign or remove restaurant owners (`PATCH /restaurants/:id {ownerId}`, *superseded by Stage 8.2's `adminIds` endpoints*); restaurant
admins create restaurants, edit details, open/close, manage menu items (name, description, price, availability, add, delete) and view their
restaurant's orders; delivery agents register their phone/availability and handle their active delivery (pickup, arrival, resend code,
submit code); customers keep the full order → invoice → mock payment → live tracking → code → cancellation flow. Only existing endpoints are
used; no backend change. The devtools "sign in as seeded partner" helper (which held the shared demo password) was removed — devtools now
holds no user credentials. **Functional testing of this milestone was intentionally deferred** (syntax and static element checks only).

Create-user form (follow-up): one always-visible **Create user** form (name, email, password, confirm, role selector showing all four
roles, default `customer`) replaces the separate guest registration and admin account forms. A signed-in platform admin creates any role
via `POST /auth/users` with their JWT; anyone else can only submit `customer` (public `POST /auth/register`, sent without a token) — for
privileged roles the form shows the Platform Administrator requirement and disables only the submit button. The backend RBAC is unchanged
and remains the security boundary. The admin stays signed in; created users are never signed in automatically.

Phone audit (follow-up): the only phone the business logic needs is the **delivery partner's**, stored in the Delivery Service profile
(`PUT /deliveries/agents/me`, required once — `PHONE_REQUIRED`) and shown to customers only masked (`agentPhoneMasked` in
`delivery.partner_assigned.v1` and the tracking view). Customer and staff phones on the Auth user are optional, stored only when sent, and
used by nothing (no SMS, no auth, not in JWTs, orders or notifications). The console therefore no longer asks for a phone at registration or
account creation; the partner's contact phone stays on the partner-profile card.

## Stage 8: Developer testing console, API documentation, full-system verification ✅

Goal: make the distributed system understandable, testable and demonstrable without calling endpoints by hand. Guide: [TESTING_GUIDE.md](TESTING_GUIDE.md);
design: [ARCHITECTURE.md §19](ARCHITECTURE.md#19-developer-tooling-and-observability-stage-8).

- **Audit:** 52 business endpoints (+2 gateway health) inventoried from the code ([API.md → Endpoint inventory](API.md#endpoint-inventory));
  coverage matrix and real gaps in [TESTING_GUIDE.md §9](TESTING_GUIDE.md#9-api-inventory-and-test-coverage). Found and fixed: 7 error codes in
  API.md that no code emits any more; no live test of a catalog change reaching the Order read model (added to the smoke E2E).
- **OpenAPI 3.1** (`docs/openapi.mjs` → `docs/openapi.json`): every client-facing operation with schemas, JWT, `x-roles`, error codes and
  examples. `node scripts/openapi.mjs check` (now part of `npm test`) compares it with the Express routes parsed from source and the gateway
  routes; validated with Redocly (valid, no errors).
- **devtools container** (http://localhost:3100, bound to 127.0.0.1): Swagger UI at `/docs`; a testing console covering the whole journey
  (customer, menu, order, invoice, mock payment incl. decline/retry, live SSE tracking, partner sign-in, pickup, arrival, OTP from Mailpit,
  verification, cancellation/refund) plus health, events (ids + correlation ids), emails, queues/DLQ and a request log. Read-only broker user
  `devtools` (cannot publish; cannot read business queues or the OTP DLQ); no database access; seeded-partner sign-in returns only a JWT.
- **Scenario runner** (`node scripts/scenarios.mjs all`): 8 scenarios with Markdown/JSON reports (steps, checks, order id, final state,
  events, errors).
- **Defect fixed:** the tracking SSE stream ended as soon as an order became terminal, so a cancelled paid order never streamed its refund.
  It now ends when the order is *settled* (new `settled` field). Found by the browser walkthrough.
- Gateway exposes `x-request-id`, `retry-after`, `idempotent-replayed` to browser clients (CORS).

## Stage 6: Delivery Service ✅

`services/delivery` (port 4007, `delivery_db`). Design: [ARCHITECTURE.md §18](ARCHITECTURE.md#18-delivery-service-stage-6).

- **Creation:** consumes `order.confirmed.v1` (requires a captured payment and the customer email); one delivery per order
  (unique `orderId`); cancellations/expiries arriving first leave a tombstone so a delayed confirmation is ignored.
- **Preparation and assignment:** persisted deadlines (`PREPARATION_DELAY_MS`, default 15 s; `ASSIGNMENT_DELAY_MS`, 5 s) driven by a
  polling scheduler, so work resumes after restarts. Random choice (`$sample`) among available partners; the partner and the delivery are
  reserved by compare-and-set in one transaction, backed by a unique `activeDeliveryId` index. No partner → bounded retries → `assignment_failed`
  (+ `delivery.assignment_failed.v1`); an operator can re-queue it. No automatic refund for delivery problems.
- **Partners:** 12 fictional partners via `scripts/seed-delivery-agents.mjs` (Auth accounts created by the platform admin; profiles registered
  with each partner's own JWT). Password from `.env` (generated), never hard-coded; the seed refuses `NODE_ENV=production`.
- **Partner API:** `POST /deliveries/:id/pickup | arrived | verify-otp | resend-otp`, assigned partner only (identity from the JWT).
- **OTP:** CSPRNG 6 digits, 5-minute TTL, 5 attempts (counted atomically before comparing), at most 3 codes with a 30 s cooldown, stored as
  an HMAC-SHA256 verifier bound to delivery + sequence, constant-time comparison, consumed exactly once. The plaintext is sealed (X25519 +
  AES-256-GCM) to the Notification Service and sent as `notification.delivery_otp.v1` on the **restricted** `food.restricted` exchange, in the same
  transaction as the arrival. `delivery.completed.v1` (with `otpVerified: true`, required by the Order Service) is published only after verification.
- **Notification:** dedicated restricted queue and `DELIVERY_OTP` template; the sealed code is stored only until sent, never sent after expiry,
  superseded by a reissue, retried every ≤ 15 s during SMTP outages.
- **Order Service:** delivery mirror (`order.delivery`: status, partner name + masked phone, code expiry), new mirror-only events
  (`delivery.cancelled`, `delivery.assignment_failed`), rejects facts about a different delivery id and completions without OTP verification,
  agents see only orders assigned to them, extended tracking view and **live tracking over SSE** (`GET /orders/:id/tracking/stream`, MongoDB change
  stream per instance, nginx unbuffered location).
- **Broker:** per-service RabbitMQ users created by the one-shot `rabbitmq-setup` job (least-privilege permissions, topic permissions per
  publisher, both exchanges pre-declared); retries/dead-letters through each consumer's own parking exchange (no service can write to the default exchange).
  Empty legacy queues are migrated automatically.
- **Shared contracts:** envelopes carry `aggregateId` and a default `correlationId`; new `delivery.cancelled.v1`, `delivery.assignment_failed.v1`;
  `order.confirmed.v1` + `customerEmail`/`customerName`; `delivery.partner_assigned.v1` + `agentPhoneMasked`.

## Stage 4.1: Automatic expiration of unpaid orders ✅

**Implemented**
- Payment deadline on every new order: `expiresAt = createdAt + ORDER_PAYMENT_DEADLINE_SECONDS`
  (default 900 s), also sent on `order.created.v1` (optional field). "Unpaid" is read from the existing
  `paymentStatus` (`pending`/`failed`); there is no `isPaid` flag.
- New terminal order status `expired` (with `expiredAt` and a system `statusHistory` entry).
- `ExpirationWorker` (order-service): periodic sweep; per order, an atomic compare-and-set plus
  `order.expired.v1` written to the outbox in one transaction. It is stateless, so after a restart it expires the backlog.
  **No TTL index; nothing is deleted.**
- Payment Service consumes `order.expired.v1`, treating it like a cancellation (`orderClosure: "expired"`):
  a pending payment is cancelled, an open PaymentIntent is cancelled at the provider, and a late
  capture is refunded once (the refund key is shared with cancellation).
- Payment attempts are refused with `409 ORDER_EXPIRED` when the order is expired or its deadline has
  passed (even before the sweep has run).
- A payment success arriving for an expired order leaves the order `expired` with `paymentStatus: refund_pending`, then `refunded`.
- Order consumer: a lost compare-and-set now retries immediately with fresh state, instead of waiting for the broker's 5 s retry.

**Bugs found and fixed during this work**
1. *Mock provider race:* read-modify-write PaymentIntent updates let a concurrent cancel and confirm
   both "succeed", leaving our payment `cancelled` while the mock intent was `succeeded`. Mock
   transitions and refund reservation are now atomic, and the workflow logs a charge on a cancelled
   payment as an error-level anomaly. Found by the concurrency test (it failed about 1 run in 5–15 before; 12/12 after).
2. *Concurrent first initiation (since Stage 4):* the mock claimed the idempotency key before saving
   the intent, so a simultaneous request could get "No such payment_intent", returned as a 502. Seen once in
   live E2E. The mock now saves first and then claims the key. Real-Stripe counterpart: `idempotency_key_in_use`
   is now treated as transient, and initiation retries briefly with the same key. Added a burst test and
   an error-classification test.

**Tests added:** order-service 12 (deadline, expire without payment, paid before expiry not expired,
failed attempt still expires, cancelled ignored, worker restart mid-backlog, two racing workers,
expired orders blocked, delayed success webhook, duplicate expiry, 8 concurrent payment/expiry pairs).
payment-service 11 (9 expiry/race tests including 6 concurrent card-completion/expiry pairs, a reconciler
restart, duplicate expiry events and expiry plus cancellation; a concurrent first-initiation burst;
Stripe error classification).

**Live verification:** `e2e-payments.mjs --expiry` (scenario 6, 14 checks) temporarily runs order-service with a
12 s deadline and 1 s sweep. It covers: unpaid order expired by the worker, `order.expired.v1` published,
payment cancelled, `ORDER_EXPIRED` on retry, open PaymentIntent cancelled, an order paid in time not expired,
an expired order not cancellable, and orders falling due while order-service is stopped expired exactly once after restart.
Defaults are restored afterwards.

## Test results (latest run)

```
npm test   (RABBITMQ_TEST_URL, STRIPE_MOCK_URL, MAILPIT_URL set; nothing skipped), 2026-10-17, Stage 8
  @food/common                41 passed
  @food/auth-service          19 passed
  @food/billing-service       21 passed
  @food/catalog-service       27 passed
  @food/delivery-service      29 passed
  @food/notification-service  25 passed
  @food/order-service         80 passed
  @food/payment-service       73 passed
  ──────────────────────────────────────
  Total                      315 passed, 0 failed
  + OpenAPI check: 52 business operations match the 52 Express routes; all routed by the gateway
npm run typecheck   0 errors
node scripts/e2e-smoke.mjs                                  41/41
node scripts/e2e-payments.mjs      --expiry --resilience    60/60
node scripts/e2e-billing.mjs       --expiry --resilience    35/35
node scripts/e2e-notifications.mjs --expiry --resilience    47/47
node scripts/e2e-delivery.mjs      --resilience            105/105
node scripts/scenarios.mjs all                              8/8 scenarios, 46/46 checks (report: reports/scenarios/latest.md)
Testing console, headless Chromium walkthrough (Playwright)  16/16 steps
Swagger UI (headless Chromium)                               54 operations in 14 tags rendered; "Try it out" executed against the gateway
OpenAPI lint (Redocly CLI 1.34.5)                            valid (warnings only: tag/4xx/ambiguous-path style rules)
```

Console walkthrough evidence: every business call went to `http://localhost:8080` (27 requests: register, login, menu, order, invoice,
payment initiate/simulate, tracking stream, partner `agents/me`, pickup, arrived, verify-otp, cancel …), helper calls only to
`/devtools/api/*`, **no other origin**; the only browser errors were the deliberate wrong-code test (422) and `BILLING_PENDING` retries (409).
The first scenario run aborted before any scenario because partner seeding raced a delivery-service restart (gateway 502); the seed now
retries 502/504 and the runner waits for delivery health — the rerun passed 8/8.

Live stack after the runs: 12/12 long-running containers healthy (incl. `devtools`), `rabbitmq-setup` exited 0, 0 busy partners. The only
dead-lettered messages were the notification E2E's two deliberate negative tests (shown with their last error by the console's DLQ panel);
they were purged afterwards.

Previous (Stage 5.1 / 7) run, kept for reference:

```
npm test   (RABBITMQ_TEST_URL, STRIPE_MOCK_URL and MAILPIT_URL set; nothing skipped), 2026-10-16, refactor + Notification
  @food/common                34 passed
  @food/auth-service          19 passed
  @food/billing-service       21 passed
  @food/catalog-service       27 passed
  @food/notification-service  19 passed
  @food/order-service         68 passed
  @food/payment-service       73 passed
  ──────────────────────────────────────
  Total                      261 passed, 0 failed
npm run typecheck   0 errors
node scripts/e2e-smoke.mjs                                  38/38
node scripts/e2e-payments.mjs      --expiry --resilience    60/60
node scripts/e2e-billing.mjs       --expiry --resilience    35/35
node scripts/e2e-notifications.mjs --expiry --resilience    43/43
```

Live stack: **10/10 containers healthy** (mongo, rabbitmq, mailpit, gateway, auth, catalog, order, payment, billing, notification).
After the runs: 97 notification records, all `sent`, 0 duplicate dedupe keys; 0 pending outbox events in catalog/order/payment/billing;
the only queued messages are 3 in `notification-service.order-events.dlq`, the deliberately malformed events from the 3 notification E2E runs
(also the only 3 error-level log lines). Every email was captured by Mailpit; **none was delivered to a real mailbox**.

Notification E2E coverage: confirmation email (text + HTML, items, amount, template headers); five delivery-phase emails from synthetic
`delivery.*` events; duplicates (same id, new id, stale delivery fact) → no extra email; rejected transitions (deliver an unpaid
order, second cancel, delivery event on a cancelled order) → no email, history unchanged; out-of-order delivery events → correct order
and one email each; malformed event → DLQ; expiry email; Mailpit stopped → order unaffected, attempts and failures persisted, health
`degraded`, email delivered once after recovery; RabbitMQ stopped → email after recovery; notification-service stopped → event waits
in the durable queue → exactly one email after restart.

Previous (Stage 5) run, kept for reference:
After the runs: 52 invoices (8 discounted), 0 duplicate invoices, 0 duplicate ledger entries, 0 ledger anomalies,
0 invoices violating `finalAmount = subtotal − discount + tax`, 0 non-zero tax. Every Stage 5 payment's amount and
invoice id match the invoice (0 mismatches), and every order mirror matches its invoice. 0 queued/DLQ messages,
0 pending outbox events, 0 error-level log lines. (Payments created before Stage 5 have no invoice, as expected.)

Tests that use the **mock provider**: all payment-service tests except the Stripe provider file. Tests
that need **real Stripe test credentials**: none exist yet (see the verification table).

The broker idempotency test was flaky at first (1 failure in 3 runs). It was a test bug: the test read
the counter before the handlers had finished. It was fixed to wait for completion, then passed 5/5
repeated runs.

### Stage 4 live verification (Docker Compose, mock provider)

7/7 containers healthy (`payment-service` included; restart policy `unless-stopped`). Durable queues
`payment-service.order-events` and `order-service.payment-events`, each with `.retry` and `.dlq`, one consumer each.

`node scripts/e2e-smoke.mjs`: **31/31**. `node scripts/e2e-payments.mjs --resilience`: **46/46**.

| Scenario | Verified |
|---|---|
| 1. Success | register → login → order → payment record from `order.created` → initiate (PaymentIntent) → client amount rejected → card step → signed webhook → `succeeded` → `payment.succeeded.v1` → order `confirmed` / `paid` (system entry in history) → other customer 404 |
| 2. Failure + retry | decline → `failed` (`generic_decline`) → `payment.failed.v1` (`retryable: true`) → order stays `pending_payment` / `failed` → retry reuses the **same** PaymentIntent → success → order confirmed |
| 3. Cancellation/refund | paid order cancelled → refund → `refunded` → `payment.refund.completed.v1` → order `cancelled` / `refunded`. Cancel before payment → PaymentIntent cancelled → `payment.cancelled.v1` → order `cancelled`; paying afterwards → 409. Refund failure → `payment.refund.failed.v1` → order `refund_failed` |
| 4. Duplicates | `order.created` republished 3× → 1 payment; concurrent initiations → 1 PaymentIntent; success webhook delivered 3× → 1 `payment.succeeded`, 1 history entry, 1 order confirmation; `order.cancelled` republished → 1 refund, 1 refund event; forged webhook → 400 |
| 5. Infrastructure | RabbitMQ stopped: payment service degraded but up, order + initiation + payment succeed, order waits; RabbitMQ started → outbox flushed → order confirmed. Payment service restarted mid-payment → state and PaymentIntent persisted → payment completes |

After the runs: 26 payments, **0 duplicate payments per order**, max **1** automatic refund per payment,
**0** pending outbox events in either service, **0** messages in any DLQ, **0** error-level log lines.
Payment↔order state convergence was checked for every order (0 mismatches). `docker compose down` + `up`
(volumes kept): payment and order counts identical.

### Stage 0–3 live verification

**End-to-end smoke test** (`node scripts/e2e-smoke.mjs`, through the gateway): **30 passed, 0 failed** (Stage 3; now 31 with payment health).
It covers: health of all 3 services → register → duplicate register 409 → wrong password 401 → login
JWT → `/auth/me` → invalid token 401 → browse/filter → ≥15 restaurants → menu → place order (server-side
subtotal verified) → idempotent replay → tampered price 400 → unavailable item 422 → closed restaurant
422 → unauthenticated 401 → history → order detail → cancel → double cancel 409 → admin confirm (paid)
→ illegal transition 409 → customer status change 403 → **3 events received from RabbitMQ**
(2× `order.created.v1`, 1× `order.cancelled.v1`) with payloads matching the orders.

**Resilience checks** (live containers):

| Scenario | Result |
|---|---|
| RabbitMQ stopped, then order placed | `201 Created`; `/health/order` → `degraded {mongo: up, rabbitmq: down}`; outbox pending = 1 |
| RabbitMQ restarted | event delivered automatically (same orderId); outbox pending = 0; health → `ok` |
| Catalog stopped, then order placed | `503 SERVICE_UNAVAILABLE` after the 3 s timeout, no order created; order history and auth unaffected |
| Restart mongo + auth + order | login works, orders and 16 restaurants persist (named volumes) |
| Catalog restart / CLI seed re-run | `inserted: 0, updated: 0` (idempotent) |

## Integration verification (Stages 0–3), 2026-10-15

Full re-verification with native Docker after WSL integration was enabled.

**Issues found and fixed** (separate commit after the initial one):
1. **MongoDB and RabbitMQ had no restart policy** (`restart: no`). After a Docker Desktop restart both
   stayed `Exited`, and the three services crash-looped on `ENOTFOUND mongo`. Fix: both now use
   `restart: unless-stopped`.
2. **Noisy startup logs:** each failed initial Mongo connection attempt logged three lines (warn +
   full error stack + retry). The connection event listeners are now registered after the first
   successful connect, so each attempt logs one line.

| Check | Result |
|---|---|
| `docker info` / `docker compose version` (native, WSL) | 29.7.2 Docker Desktop / Compose v5.4.0; WSL bind mount test OK |
| `docker compose up -d --build` | 6/6 containers `healthy`, restart policy `unless-stopped` on all; Mongo `rs0` PRIMARY; RabbitMQ 4.1.8 |
| Automated tests (incl. real RabbitMQ) | 94/94 passed (common 20, auth 19, catalog 22, order 33); typecheck 0 errors; re-run after fixes: same |
| E2E smoke (`scripts/e2e-smoke.mjs`) | 30/30 passed (before and after fixes) |
| RabbitMQ events | 2× `order.created.v1` + 1× `order.cancelled.v1` received; event IDs match `outbox_events` records (all `published`, attempts = 1); exchange `publish_in = publish_out = 3` |
| Persistence: `docker compose restart` | counts identical (users 6, restaurants 16, menu items 162, orders 6, outbox 8); fixture user logs in, fixture order readable |
| Persistence: `docker compose down` (volumes kept) + `up` | identical counts; same fixture checks pass |
| Infra crash (mongod forced shutdown, `rabbitmqctl stop`) | auto-restarted (`RestartCount 1`); all services reconnected without restart, healthy within ~8 s; no data loss |
| Log scan | no Mongo E/F entries; every app warning and RabbitMQ error corresponds to the outages induced above; all 62 gateway 503s were `/health/order` polls during the outages |

Note: `docker kill` / `docker stop` count as *manual* stops, so Docker deliberately doesn't apply
the restart policy after them. Use `docker compose up -d` to bring such containers back.

## Architectural decisions

See [ARCHITECTURE.md §12](ARCHITECTURE.md#12-key-decisions-adr-summary). Highlights:
- Transactional outbox instead of publish-after-save (no lost or phantom events, survives broker
  outages, verified).
- Integer paise everywhere. Deterministic seed IDs. Soft-deleted restaurants. Order snapshots.
- RabbitMQ counts as an *optional* dependency for the Order Service's health; MongoDB is critical.
- JWTs are verified locally in each service (no runtime dependency on the Auth Service).
- nginx gateway with its config baked into the image (no host bind mounts, which also suits ECS).
- Stage 4: the Payment Service owns payment state and the Order Service mirrors it from events; one
  PaymentIntent per payment; provider calls outside transactions with a reconciler; a mock provider with
  real Stripe signature verification (ARCHITECTURE §12 rows 15–20, §13).

## Known issues and limitations

1. ~~Docker WSL integration off~~. **Resolved** (integration enabled; native `docker` verified).
2. **Real Stripe test mode is unverified** (no credentials). Everything Stripe-specific beyond request
   shapes and signature verification (real PaymentIntent lifecycle, `stripe listen` delivery, test
   PaymentMethods such as `pm_card_refundFail`, INR/Indian-account requirements) still needs one run with
   `sk_test_`/`whsec_` keys. Steps are in ARCHITECTURE §13.9.
3. ~~Interim delivery transitions via PATCH~~. **Resolved:** delivery progress comes only from the Delivery Service, and
   `delivered` requires a verified OTP (Stage 6).
4. **Token revocation:** a deactivated or deleted user's existing JWT stays valid until it expires (≤ 1 h). There
   are no refresh tokens or revocation list yet. The smallest improvement is an event-fed per-user `iat` cut-off in `authenticate()` (ARCHITECTURE §23.5).
5. ~~Synchronous Order → Catalog calls~~. **Resolved** by the catalog read model. Trade-off: while the Order Service's
   RabbitMQ connection is down, **new orders are refused** (503 `CATALOG_SYNC_UNAVAILABLE`) because catalog changes might be
   in flight. Such orders couldn't be billed or paid during the outage anyway. Catalog itself being down doesn't block orders.
6. Residual staleness window: consumer lag between a catalog change and its projection (milliseconds normally). Each order
   records the `catalogVersion` it was priced from.
7. The synopsis PDF mentioned in the brief was **not found** in the repository. The brief's seven-service
   baseline was used instead.
8. No CI pipeline yet (planned with the cloud deployment, GitHub Actions).
9. ~~Payment amount = provisional total~~. **Resolved in Stage 5:** the Payment Service charges the invoice `finalAmount`.
   Taxes are intentionally not calculated (`taxAmount = 0`).
10. Failed refunds need manual follow-up (by design); there is no alerting beyond logs, the
    `payment.refund.failed` event and `refundStatus: failed`.
11. No 3-D Secure / redirect payment methods (`allow_redirects: 'never'`); a frontend would add Stripe.js.
12. ~~Shared RabbitMQ user~~. **Resolved in Stage 6:** per-service users with least-privilege and topic permissions. The bootstrap
    admin (`RABBITMQ_USER`) still exists for the management UI, provisioning, tests and the E2E scripts (which publish synthetic events with it).
13. Expiry granularity is the sweep interval (default 15 s). Payment initiation already refuses at the exact
    deadline; the order status flips at the next sweep. A customer who completes the card step in the window
    between their PaymentIntent and its cancellation is refunded automatically.
14. Discount codes have no per-customer or global redemption limits yet (any eligible order may use a code).
15. If the totals of an order fail billing verification (should be impossible), no `billing.finalized` is published: payment
    initiation keeps answering `409 BILLING_PENDING` and the order expires after 15 minutes. Payment can't distinguish
    "not finalized yet" from "unknown order" either (both are `BILLING_PENDING`), since it no longer asks the Order Service.
16. Notification: SMTP accept and the `sent` update are not atomic (rare duplicate on a crash in that window, same
    `Message-ID`). A notification that exhausts its 8 attempts stays `failed` in `notification_db` and needs a manual replay.
    Emails are captured by Mailpit only; no real mailbox or provider (e.g. SES) has been tested. Mailpit keeps no
    volume, so captured mail is lost when the container is recreated.
17. The notification for each transition is independent, so if an early delivery event is retried, the customer may
    briefly see emails slightly out of order (the Order Service still applies the transitions in order).
18. Delivery: a reserved partner stays reserved until pickup or cancellation (no pickup timeout or reassignment). Paid orders that are
    never picked up hold a partner; the E2E suites cancel or complete what they leave open to keep the shared pool free.
19. Delivery: random assignment only (no distance/route optimisation, by design); preparation is a simulated delay (no restaurant "ready" action).
20. After pickup no one can cancel through the API (by policy); returns/refunds after pickup would be a support process.
21. OTP delivery is email only (no SMS). If all 3 codes are used up (lost emails, 5 wrong attempts each), the delivery stays `arrived`
    until support intervenes. The code is visible in Mailpit, as intended for local testing.
22. Live tracking needs a client that can send an `Authorization` header on a streaming request (the browser `EventSource` cannot);
    the polling endpoint remains. There is no WebSocket channel.
23. Testing gaps (see TESTING_GUIDE §9): restaurant/menu management, profile/password changes, admin user deactivation, discount administration
    and restaurant-admin order views are covered by service-level Supertest suites but not by live E2E runs; no multi-replica run; no load tests.
    The console's browser walkthrough is run during development (Playwright, outside the repo), not committed as a test.
24. The devtools console is for local development only. Since Stage 8.1 it holds **no user credentials**, only a read-only broker credential,
    server-side. It is bound to 127.0.0.1 and refuses `NODE_ENV=production`. Deploying it is not part of the plan (DEPLOYMENT_GUIDE §12).
25. **Deployment blocker:** the gateway's nginx config uses Docker's embedded DNS (`resolver 127.0.0.11`) and the Compose hostnames, so it does not work
    outside a Docker network without changes (DEPLOYMENT_GUIDE §4). MongoDB has no authentication locally, and per-service database users don't exist yet.
26. `SEED_ON_START` defaults differ: the code defaults to `false`, while `docker-compose.yml` and `.env.example` default to `true`. The original development machine sets
    `false` and holds only the 5-restaurant sample catalog.
27. `e2e-smoke.mjs`, `e2e-payments.mjs` and `e2e-billing.mjs` depend on the **full demo catalog**. They expect ≥ 15 restaurants and the *Spice Route Biryani House*,
    so they fail against the 5-restaurant sample catalog. The delivery and notification suites and the scenarios use any open restaurant.
28. The host-run env templates (`services/*/.env.example`) connect to RabbitMQ as the admin user (no per-service permissions). The Auth template has no
    `RABBITMQ_URL`, so a host-run Auth Service keeps its deactivation events in the outbox (health `degraded`).
29. `ENABLE_TEST_ENDPOINTS` defaults to `false` in code but `true` in Compose. The mock payment flow (console, scenarios) depends on it.
30. The real-RabbitMQ integration tests (`RABBITMQ_TEST_URL`) connect to the shared local broker as the admin user and create test queues there.
31. **Account deletion (Stage 9):**
    - It is not personal-data erasure. Orders, payments, invoices, ledger, delivery and notification records keep the user id and captured details.
    - Deleting an agent is refused while Auth's event-fed projection shows an active delivery. An assignment made in the sub-second window
      before Delivery processed the deactivation can be missed; that delivery then stays with the deleted agent, with no automatic reassignment.
    - The projection only covers assignments made after Stage 9 was deployed. There were no in-flight deliveries locally at that time.
    - The deactivation → re-enable comparison in Delivery uses the JWT `iat` (seconds). An agent who logs in within the same second as their reactivation may
      need to log in once more.
32. The existing `services/auth/test/auth.test.ts › GET /health › reports mongo up` fails without a broker. Health is `degraded` because RabbitMQ is
    down in tests; this predates Stage 9 and also fails on the previous commit.

## Remaining tasks

- Stage 4 (remaining): one verification run with real Stripe test credentials (`PAYMENT_PROVIDER=stripe`,
  `stripe listen --forward-to localhost:8080/payments/webhook`, then `node scripts/e2e-payments.mjs`).
- Optional: pickup timeout/reassignment for partners; live E2E for the management endpoints listed in limitation 23.
- Cloud deployment by teammates, following DEPLOYMENT_GUIDE.md (resolve the blockers in §12 first). No infrastructure as code is in the repository.
- Functional verification of Stages 8.1–8.2 (deferred so far).

## Next recommended action

1. **Provide Stripe test credentials** (`sk_test_…` plus a `whsec_…` from `stripe listen`) and rerun the payment and
   billing E2E scripts with `PAYMENT_PROVIDER=stripe`. This is the one unverified Stage 4 item.
2. Run the deferred functional checks of Stages 8.1–8.2 (console flows, assignments, deactivation → assignment removal).
3. Rebuild the Auth, Catalog, Delivery and frontend containers, then verify Stage 9 live on one disposable account per role: deactivate, delete,
   check the Catalog/Order assignment cleanup and the Delivery block.
4. Teammates: read TEAM_HANDOVER.md, then DEPLOYMENT_GUIDE.md, and resolve the deployment blockers before any cloud run.
