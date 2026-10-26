# Testing guide

How to start, explore, test and demonstrate the platform locally, without calling endpoints by hand.
Everything here runs on your machine (Docker Compose). Nothing is deployed and no email leaves the machine.

| Tool | URL | What it is for |
|---|---|---|
| **Web application** | http://localhost:3000 | the user-facing React app: customers order, pay (simulated) and track; restaurant admins manage menus and orders; agents deliver; platform admins manage users and assignments ([frontend/README.md](frontend/README.md)) |
| **Testing console** | http://localhost:3100 | click through a whole order → payment → delivery → OTP flow, live tracking, events, emails, health |
| **Swagger UI** | http://localhost:3100/docs | every client-facing endpoint (OpenAPI 3.1), "Try it out" against the gateway |
| API gateway | http://localhost:8080 | the only entry point a client uses |
| Mailpit | http://localhost:8025 | every email the platform sends (incl. delivery codes) |
| RabbitMQ management | http://localhost:15672 | exchanges, queues, dead-letter queues, message peeking |

The console and Swagger UI are served by the **development-only `devtools` container** (bound to `127.0.0.1`, not part of
any production deployment). It never touches a database and never sees broker or OTP secrets — see [How the console works](#how-the-console-works).

---

## 1. Start the platform

```bash
node scripts/init-env.mjs
```

Creates or completes the git-ignored `.env` with generated local secrets (JWT secret, admin password, one RabbitMQ password per
service plus the read-only console user, OTP keys, demo partner password). Existing values are never changed and nothing is printed.

```bash
docker compose up -d --build
```

```bash
docker compose ps
```

All services should be `healthy`; `rabbitmq-setup` is a one-shot provisioning job and shows `Exited (0)`. In Docker Desktop the whole
stack appears as one group, **food-platform** — click the ▸ arrow to see the individual containers.

```bash
node scripts/seed-delivery-agents.mjs
```

Seeds 12 fictional delivery partners (idempotent). The admin login is `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`; the partners'
shared password is `DELIVERY_AGENT_PASSWORD` (e.g. `grep DELIVERY_AGENT_PASSWORD .env`).

## 2. Swagger UI

Open http://localhost:3100/docs.

1. `POST /auth/register`, then `POST /auth/login` → copy `data.accessToken`.
2. Click **Authorize**, paste the token (no `Bearer ` prefix needed).
3. Use **Try it out** on any operation; requests go to the gateway at `http://localhost:8080`.

Each operation states the roles allowed (also as `x-roles`), its request/response schemas, examples and error codes.
The SSE endpoint `GET /orders/{id}/tracking/stream` is documented but Swagger cannot render streams — use the console or
`curl -N -H "Authorization: Bearer $TOKEN" http://localhost:8080/orders/<id>/tracking/stream`.

The spec lives in [`docs/openapi.mjs`](docs/openapi.mjs) (generated to `docs/openapi.json`). It is checked against the real code:

```bash
node scripts/openapi.mjs check
```

fails if any Express route is undocumented, any documented route doesn't exist, or a path isn't routed by the gateway.
After editing the spec run `node scripts/openapi.mjs build` (and rebuild the console image: `docker compose up -d --build devtools`).

## 3. Testing console

Open http://localhost:3100. The page is **role-aware**: register or log in, and it shows only the sections for the signed-in role.
Every action is a real gateway call with that user's JWT, so the backend's role and ownership checks apply exactly as for any client.
Tokens are kept in memory only (reloading the page signs you out); passwords and tokens never appear in the request log.

**Getting started from an empty database** (after a reset there is only the platform administrator from `.env`):

Optional sample catalog: 5 open restaurants with 5 available items each and no administrators. It is idempotent and only inserts what is missing,
never overwriting edits or touching other restaurants. Run it in the running Catalog container; the Order Service receives the new restaurants through the usual
`catalog.restaurant.updated.v2` events:

```bash
docker exec food-platform-catalog-service-1 node services/catalog/dist/seed/run.js --sample
```

1. Log in as the **platform administrator** → *Create a restaurant* → *Create user* with role `restaurant_admin` (select at least one
   restaurant; if an assignment fails, *Retry* re-sends only the failed ones) and one with role `delivery_agent`
   (real names, emails and passwords you choose; `POST /auth/users`). The agent adds a contact phone in step 3.
   More administrators can be added or removed under *Restaurant administrators*.
2. Log out, log in as the **restaurant administrator** → *My restaurants* (the assigned ones) → add menu items → *Open / close* if needed.
3. Log out, log in as the **delivery agent** → enter a phone → *Go available*.
4. Log out, *Create user* with role `customer` (public registration), log in → pick the restaurant → order → pay.
5. When the order shows **partner_assigned**, log in as the delivery agent → *Confirm pickup* → *Report arrival*.
6. Log in as the customer → *Show the code from my email* (or open Mailpit) → log in as the agent → *Submit code* → the order is **delivered**.

| Role | Sections | Gateway endpoints used |
|---|---|---|
| everyone | **Create user** (one form: name, email, password, confirm, role selector with all four roles). Signed out or signed in as a non-admin: only `customer` can be submitted (privileged roles show "You must be logged in as a Platform Administrator to create this account type." and the button is disabled). Signed in as `platform_admin`: any role. Log in / log out | `POST /auth/register` (customer, no token), `POST /auth/users` (platform admin's JWT, any role), `POST /auth/login` |
| `platform_admin` | Users list, Create a restaurant (initial administrators), Restaurant administrators (list/add/remove), restaurant multi-select in Create user | `GET /auth/users`, `GET /restaurants?includeInactive=true`, `POST /restaurants`, `POST /restaurants/:id/admins`, `DELETE /restaurants/:id/admins/:userId` |
| `restaurant_admin` | My restaurants (assigned ones, with their administrator ids; details, open/close, edit description/cost/delivery time), Menu (edit name, description, price; availability; delete; add item), Orders for this restaurant | `GET /restaurants/mine`, `GET /restaurants/:id/menu`, `PATCH /restaurants/:id`, `PATCH /restaurants/:id/open`, `POST /restaurants/:id/menu`, `PATCH /restaurants/:id/menu/:itemId`, `PATCH …/availability`, `DELETE /restaurants/:id/menu/:itemId`, `GET /orders?restaurantId=` |
| `delivery_agent` | Partner profile (phone, available/offline), Active delivery (pickup, arrival, resend code, submit code) | `GET/PUT /deliveries/agents/me`, `POST /deliveries/:id/pickup`, `/arrived`, `/resend-otp`, `/verify-otp` |
| `customer` | Restaurant and menu, Place the order, My orders, Invoice, Payment (mock success/decline, retry), Delivery code, Cancellation, Live tracking, Events, My emails | `GET /restaurants`, `GET /restaurants/:id/menu`, `GET /discounts`, `POST /orders`, `GET /orders`, `GET /orders/:id`, `GET /invoices/order/:id`, `POST /payments/initiate`, `POST /payments/:id/simulate`, `GET /payments/order/:id`, `POST /orders/:id/cancel`, `GET /orders/:id/tracking/stream` |
| all | Platform health, Queues and dead letters, Request log | devtools helpers only (read-only) |

Notes: the console never lets anyone choose a role at registration (the backend would reject it anyway); privileged accounts can only be
created by a signed-in platform admin. A restaurant admin's list shows every restaurant assigned to them (including inactive ones; only a platform admin changes `status`). Orders are listed newest-first, 50 per restaurant.

### How the console works

- Business actions call the **gateway** (`http://localhost:8080`) from the browser with the signed-in user's JWT — exactly what a client app does
  (CORS is open locally). No business endpoint is reached any other way.
- `devtools` adds read-only helpers under `/devtools/api/*`: aggregated health (internal `/health` endpoints), queue depths and dead-letter
  **metadata** (a `devtools` RabbitMQ user with the `monitoring` tag that cannot publish, cannot read business queues and cannot read the
  restricted OTP queue or its DLQ), a metadata-only event tracer on `food.events`, and Mailpit search (used for the customer's *My emails* and
  *Delivery code*). It holds **no user credentials**: everyone signs in with their own email and password.

## 4. Scenario runner

```bash
node scripts/scenarios.mjs list
```

```bash
node scripts/scenarios.mjs all
```

or by name/number, e.g. `node scripts/scenarios.mjs success agent-auth` / `node scripts/scenarios.mjs 1 8`. Each scenario prints its steps and
checks; the run is saved to `reports/scenarios/latest.md` (git-ignored) with, per scenario, the steps, passed/failed checks, order id, final
order state, every event observed on `food.events` for that order (routing key, source, event id, correlation id) and any errors.
Delivery timings are shortened for the run and restored afterwards.

| # | Scenario | What it demonstrates |
|---|---|---|
| 1 | `success` | register → order → finalized invoice → payment → confirmed → random partner → pickup → arrival → OTP from email → delivered; 7 emails |
| 2 | `payment-retry` | declined card → order stays payable (`payment.failed`, retryable) → retry on the same PaymentIntent → confirmed |
| 3 | `expiry` | order-service on a 12 s deadline → unpaid order expires (`order.expired`), late payment refused, expiry email, order kept |
| 4 | `cancel-refund` | paid order (with a promo code) cancelled → refund → credit note on the immutable invoice → delivery cancelled, email |
| 5 | `duplicates` | 6 captured events replayed twice (same and new ids) → no extra history, emails, payments, invoices or ledger entries |
| 6 | `rabbitmq-outage` | broker stopped mid-delivery → services degraded not down, pickup accepted, new orders refused (stale-catalog guard), catch-up after restart |
| 7 | `notification-outage` | notification-service stopped → order flow unaffected, event waits in the durable queue, exactly one email after restart |
| 8 | `agent-auth` | other partner (404), customer (403), no token (401), forged body (404), other partner's OTP (404), wrong code (422), then success |

The exhaustive regression suites (hundreds of checks) remain the `scripts/e2e-*.mjs` scripts below; the scenario runner tells one clear story each.

## 5. Full regression

```bash
RABBITMQ_TEST_URL=amqp://food:food-dev-password@localhost:5672 STRIPE_MOCK_URL=http://localhost:12111 MAILPIT_URL=http://localhost:8025 npm test
```

(unit + integration tests of all packages; the three URLs enable the real-broker, stripe-mock and Mailpit integration tests — start
stripe-mock with `docker run -d --rm --name food-stripe-mock -p 12111:12111 stripe/stripe-mock:latest`.)

| Script | Covers |
|---|---|
| `node scripts/openapi.mjs check` | spec ⇄ code ⇄ gateway consistency |
| `node scripts/e2e-smoke.mjs` | auth, browsing, placement + idempotency + validation, history, tracking, cancellation, no status PATCH, catalog change → read model, order events |
| `node scripts/e2e-payments.mjs --expiry --resilience` | success, decline + retry, cancellation/refund/refund failure, duplicates (events, webhooks, concurrent clicks), RabbitMQ outage, payment-service restart, expiry |
| `node scripts/e2e-billing.mjs --expiry --resilience` | promo codes, itemised invoice = charged amount, credit notes, voids, duplicates, expiry, Billing down, broker down |
| `node scripts/e2e-notifications.mjs --expiry --resilience` | every email template incl. the delivery code, duplicates, rejected/stale/conflicting events, DLQ, SMTP/RabbitMQ/service outages |
| `node scripts/e2e-delivery.mjs --resilience` | the full journey with live SSE, OTP security, cancellation at each stage, no partner available, broker permissions, RabbitMQ/Notification/Delivery/MongoDB outages |

Run the suites one at a time (several stop and start containers).

### Before you run anything: side effects of each suite

Nothing in this table was run during the documentation handover. The information comes from the scripts' source.

| Suite | Needs | Data it leaves behind | Stops / restarts infrastructure | Catalog it assumes |
|---|---|---|---|---|
| `npm test` (no URLs) | nothing running | none: each test file uses a **temporary in-memory MongoDB replica set** (MongoDB Memory Server; the binary is downloaded on first use) | no | its own seed in memory |
| `npm test` + `RABBITMQ_TEST_URL` | `docker compose up -d rabbitmq` | temporary test queues/exchanges on the **local broker** (connects as the admin user) | no | — |
| `npm test` + `MAILPIT_URL` | Mailpit running | one test email in Mailpit | no | — |
| `npm test` + `STRIPE_MOCK_URL` | `stripe/stripe-mock` container on :12111 | none (stripe-mock is stateless and is *not* real Stripe) | no | — |
| `e2e-smoke.mjs` | full stack, `ADMIN_*` in `.env` | **persistent** customers and orders; toggles one item's availability and restores it | no | **full demo catalog** (checks ≥ 15 restaurants and uses *Spice Route Biryani House*; fails with only the 5-restaurant sample) |
| `e2e-payments.mjs` | full stack | persistent customers, orders, payments, refunds, emails | `--expiry`: recreates **order-service** with a 12 s deadline, then restores it; `--resilience`: stops/starts **RabbitMQ**, restarts **payment-service** | **full demo catalog** (searches "spice route") |
| `e2e-billing.mjs` | full stack | persistent orders, invoices, ledger entries, discount codes | `--expiry`: recreates order-service; `--resilience`: stops **billing-service** and **RabbitMQ** | **full demo catalog** (searches "spice route") |
| `e2e-notifications.mjs` | full stack | persistent orders and emails; seeds delivery partners; publishes synthetic events with the admin broker user | `--expiry`: recreates order-service; `--resilience`: stops **Mailpit**, **RabbitMQ**, **notification-service** | any open restaurant |
| `e2e-delivery.mjs` | full stack | persistent orders, deliveries, emails; seeds delivery partners (temporarily sets them offline) | recreates **delivery-service** with short delays (restored); `--resilience`: stops RabbitMQ, notification-service, delivery-service, **MongoDB** | any open restaurant |
| `scenarios.mjs` | full stack | persistent data like the E2E suites; reports in `reports/scenarios/` (git-ignored) | recreates delivery-service (restored); `expiry` recreates order-service; `rabbitmq-outage` / `notification-outage` stop those containers | first open restaurant |

The suites and scenarios add **persistent records to your local databases**. There is no automatic clean-up, apart from cancelling or completing the
orders they leave open. If you need to keep a clean demo dataset, back it up first, or run the suites on a separate machine or Compose project.

## 6. Inspecting emails (Mailpit)

http://localhost:8025 shows every email (HTML and text views, headers such as `X-Template` and `X-Order-Id`). Search with
`to:"someone@example.com"` or `subject:"ORD-261017-…"`. The REST API is handy for scripts:
`curl -s 'http://localhost:8025/api/v1/search?query=to:%22someone@example.com%22'`. Mailpit has no volume: recreating the
container empties it.

## 7. Inspecting events (RabbitMQ)

Log in at http://localhost:15672 with the admin user (`RABBITMQ_USER` / `RABBITMQ_PASSWORD` in `.env`, default `food` / `food-dev-password`).

- **Exchanges → `food.events`**: all business events (topic, routing key `<event>.v<version>`, e.g. `order.created.v1`, `catalog.restaurant.updated.v2`). **`food.restricted`**: only the OTP command, bound to one queue.
- **Queues**: one durable queue per consumer (`<service>.<purpose>`), each with `.retry` and `.dlq`. Consumers column should be 1 for every main queue.
- To watch traffic, add a temporary queue bound to `food.events` with routing key `#`, then use *Get messages*. (The console's event panel does this for you, metadata only.)
- **Admin → Users** shows the per-service users and their permissions (provisioned by `rabbitmq-setup`).
- A message in a `.dlq` carries `x-last-error` and `x-retry-count` headers; the console's *Queues and dead letters* card lists them.

Correlation: every event has `eventId`, `aggregateId` (the order id) and `correlationId` (request id for API-triggered events, otherwise the
order id). Each order history entry records the `sourceEventId` that caused it, so you can follow history → event → producing service.
All service logs are JSON: `docker compose logs -f order-service | grep <orderId>`.

## 8. Diagnosing common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `docker` not found in WSL / containers missing | Docker Desktop stopped or WSL integration off | start Docker Desktop; then `docker compose up -d` |
| `required variable … is missing` on `docker compose up` | `.env` lacks a generated secret | `node scripts/init-env.mjs` |
| `POST /orders` → 503 `CATALOG_SYNC_PENDING` | the Order Service's catalog read model is still bootstrapping (fresh start) | wait a few seconds and retry |
| `POST /orders` → 503 `CATALOG_SYNC_UNAVAILABLE` | the Order Service has lost RabbitMQ | check `docker compose ps rabbitmq`; it recovers automatically |
| `POST /payments/initiate` → 409 `BILLING_PENDING` (keeps happening) | Billing hasn't finalized the amount: billing-service or the broker is down | `curl localhost:8080/health/billing`; queued events are processed after recovery |
| Order stuck in `assigning_delivery_partner`, tracking shows `deliveryIssue` | no partner available (all busy/offline) → `assignment_failed` | `node scripts/seed-delivery-agents.mjs` (sets them available), then admin `POST /deliveries/:id/retry-assignment` |
| Partners all `busy` | paid orders that were never picked up hold their partner | finish or cancel them (the E2E scripts clean up after themselves) |
| No email arrives | notification-service or Mailpit down, or SMTP retrying | console health card; `docker compose logs notification-service`; emails are retried and sent after recovery |
| `401 TOKEN_EXPIRED` | access tokens last 1 h | log in again |
| A queue shows 0 consumers | its service is down or failed to subscribe (bad credentials) | `docker compose logs <service>`; re-run `docker compose up -d` (re-provisions broker users) |
| Messages in a `.dlq` | a message failed permanently (contract violation) or exhausted retries | inspect `x-last-error` (console / RabbitMQ UI); the E2E suites intentionally dead-letter a few malformed events |
| `rabbitmq-setup` exits non-zero ("Legacy queue … still holds messages") | an old-style queue still has messages | let its service drain it, then `docker compose up -d` again |

---

## 9. API inventory and test coverage

The full, generated endpoint inventory (55 business endpoints + 2 gateway health endpoints, with owner service and roles) is in
[API.md → Endpoint inventory](API.md#endpoint-inventory); regenerate it with `node scripts/openapi.mjs inventory`.

### Test suites (latest counts in [PROGRESS.md](PROGRESS.md))

| Suite | Kind | Notes |
|---|---|---|
| `packages/common/test` | unit + real-RabbitMQ integration | envelope/contracts, JWT, HTTP errors, outbox relay, broker retries/DLQ, sealed box |
| `services/<svc>/test` | Vitest + Supertest + in-memory MongoDB replica set | every service's routes, domain rules, consumers, idempotency, races |
| `scripts/e2e-*.mjs` (5) | end-to-end against the live stack | see §5 |
| `scripts/scenarios.mjs` (8) | end-to-end stories with reports | see §4 |

### Coverage matrix (workflow → where it is verified)

| Workflow / failure case | Unit / integration | Live E2E | Scenario |
|---|---|---|---|
| Registration, login, JWT, roles, `/auth/me` | auth.test | smoke | 1 |
| Profile update, password change, admin user list/deactivate | auth.test | — | — |
| Restaurant browsing, filters, menu | catalog.test | smoke | 1 |
| Restaurant/menu management (create, update, open/close, availability, delete) | catalog.test, catalog-events.test | smoke (availability only) | — |
| Catalog change → Order read model (event-carried state, staleness guard) | catalog-events.test, catalog-projection.test | smoke §9, payments S5, billing B9 | 6 |
| Order placement: server-side pricing, idempotency key, validation | orders.test | smoke | 1 |
| Restaurant-admin order listing | orders.test | — | — |
| Billing: itemised immutable invoice, promo codes, credit notes, voids | billing.test, calculator.test | billing B1–B6 | 4 |
| Discount administration (create, deactivate) | billing.test | — | — |
| Payment success, `BILLING_PENDING`, finalized amount only | initiate.test, billing.test (payment) | payments S1, billing B2 | 1 |
| Payment decline + retry on the same PaymentIntent | payment-status.test, webhooks.test | payments S2 | 2 |
| Cancellation + refund (before/after payment, refund failure) | refunds.test, orders.test | payments S3, billing B4/B5 | 4 |
| Admin refunds (full/partial) | refunds.test | payments S4 (fully-refunded → 409) | — |
| Expiry of unpaid orders (+ late payment refund) | expiration.test (order, payment) | payments S6, billing B7, notifications N7 | 3 |
| Duplicate events / webhooks / concurrent requests | every consumer test, webhooks.test | payments S4, billing B6, notifications N3, delivery D3 | 5 |
| Out-of-order / stale / conflicting events | lifecycle-events.test, delivery-tracking.test | notifications N5, delivery D3 | — |
| Order lifecycle authority, attributed history, tracking view | lifecycle-events.test, delivery-tracking.test | smoke, delivery D1 | 1 |
| Live tracking (SSE): auth, ownership, reconnect snapshot, terminal end | delivery-tracking.test | delivery D1 (through the gateway) | console |
| Delivery creation, preparation deadline, restart resume | delivery.test | delivery D1, R3 | 1 |
| Random atomic assignment, concurrency, no partner, operator retry | delivery.test | delivery D4 | — |
| Partner authorization (pickup/arrival/OTP) | delivery.test | delivery D1 | 8 |
| OTP: CSPRNG, keyed verifier, expiry, attempts (concurrent), reissue limits, reuse | delivery.test, delivery-otp.test (notification) | delivery D2 | 8 (wrong code) |
| OTP never in events/logs/DB/history/SSE | delivery.test, delivery-otp.test | delivery D1 | — |
| Restricted channel + per-service broker permissions | outbox.test, broker.integration.test | delivery "Broker isolation" | — |
| Email templates, dedupe, SMTP failure/retry/permanent failure | notifications.test, delivery-otp.test | notifications N1–N10 | 1, 7 |
| RabbitMQ outage and recovery | broker.integration.test | payments S5, billing B9, notifications N9, delivery R1 | 6 |
| Notification/SMTP outage and recovery | notifications.test | notifications N8/N10, delivery R2 | 7 |
| MongoDB outage, service restarts | — | delivery R3/R4, payments S5 | — |
| OpenAPI ⇄ code ⇄ gateway consistency | `scripts/openapi.mjs check` | — | — |

### Known gaps (not covered by any automated test)

- **Live E2E** of restaurant/menu creation and editing, profile/password changes, admin user deactivation, discount administration and
  restaurant-admin order views — these are covered only by the services' Supertest suites, not against the running stack.
- **Real Stripe test mode** (webhooks from Stripe, `stripe listen`) — only the mock provider and stripe-mock are exercised (no credentials).
- **Horizontal scaling**: concurrent schedulers and SSE fan-out are designed and unit-tested for multiple instances, but no run used two replicas of a service.
- **Token revocation** after deactivation (known limitation: tokens stay valid until expiry), gateway rate limiting, load/performance and long-running soak tests.
- The browser console is verified by a headless-browser walkthrough during development (see PROGRESS.md), not by a committed UI test.

---

## 10. Demonstration walkthrough (≈10 minutes)

1. **Architecture in one picture (1 min):** open ARCHITECTURE.md §1 — seven services, one gateway, RabbitMQ between services only,
   a database per service. In Docker Desktop expand **food-platform**: one container per service.
2. **Health (30 s):** console → *Platform health*: 7 services green, each reporting its own MongoDB/RabbitMQ status; *Queues*: one consumer per queue, no dead letters.
3. **API (1 min):** http://localhost:3100/docs — show tags per service, roles per endpoint, `POST /orders` schema ("never send prices").
4. **Happy path (5 min), in the console.** Prepare beforehand:
   - as the platform admin, create or seed a restaurant (e.g. the 5-restaurant sample), then create a restaurant admin assigned to it and a delivery agent;
   - as the restaurant admin, check the menu;
   - as the agent, *Go available*.

   Then:
   *Create user* (role `customer`) → log in → pick the restaurant → choose items → *Place order* → *Load finalized invoice* →
   *Start payment* → *Simulate card success*. Point at *Live tracking*: confirmed → assigning a partner → partner assigned (random partner,
   masked phone) arriving by SSE without refreshing. Log in as the delivery agent → *Confirm pickup* → *Report arrival*; log in as the customer →
   *Show the code from my email* (or open Mailpit) → log in as the agent → *Submit code*. Back as the customer, *My orders* → *Open*: tracking shows
   **delivered**; history lists every step with the service and event that caused it; *Events* shows the chain
   `order.created → billing.finalized → payment.succeeded → order.confirmed → delivery.* → order.status_changed`.
5. **Security moment (1 min):** submit a wrong code → `422 OTP_INVALID (4 attempts remaining)`; mention the code is stored only as a keyed
   hash and travels on a restricted exchange only Notification can read.
6. **Failure and recovery (2 min):** `node scripts/scenarios.mjs rabbitmq-outage` (or `notification-outage`) and walk through its printed
   checks: the system degrades, keeps accepting what it safely can, and catches up via the outbox.
7. **Evidence (30 s):** show `reports/scenarios/latest.md` and the test totals in PROGRESS.md.
