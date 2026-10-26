# Deployment guide

What a cloud deployment of the platform needs. **Nothing has been deployed.** The repository contains no cloud infrastructure:
no Terraform, Kubernetes manifests or CI pipeline. This guide documents the requirements and the known blockers. It does not prescribe a
provider. Where AWS is mentioned it is an example (the course targets AWS), and anything not tested is marked **unverified**.

> Docker Compose (`docker-compose.yml`) is the **local development** environment. It is not a production orchestrator: it has no
> multi-host scheduling, rolling updates, secret store or autoscaling. Treat its contents as the reference for *what* each container needs, not *how* to run it in the cloud.

Contents: [1 Components](#1-deployable-components) · [2 Building images](#2-building-images) · [3 Ports & exposure](#3-ports-and-network-exposure) ·
[4 Service discovery & gateway](#4-service-discovery-and-gateway-routing) · [5 MongoDB](#5-mongodb) · [6 RabbitMQ](#6-rabbitmq) ·
[7 Environment variables](#7-environment-variables) · [8 Secrets](#8-secrets) · [9 Startup, health, restarts](#9-startup-order-health-checks-and-restarts) ·
[10 Logging](#10-logging) · [11 Mailpit](#11-mailpit-email-in-the-final-project) · [12 Blockers & limitations](#12-known-deployment-blockers-and-limitations) ·
[13 Checklist](#13-pre-deployment-checklist)

---

## 1. Deployable components

| Component | Image (local tag) | Build | Kind | Required? |
|---|---|---|---|---|
| auth-service | `food/auth-service` | `services/auth/Dockerfile`, context = repo root | long-running | yes |
| catalog-service | `food/catalog-service` | `services/catalog/Dockerfile`, context = repo root | long-running | yes |
| order-service | `food/order-service` | `services/order/Dockerfile`, context = repo root | long-running | yes |
| payment-service | `food/payment-service` | `services/payment/Dockerfile`, context = repo root | long-running | yes |
| billing-service | `food/billing-service` | `services/billing/Dockerfile`, context = repo root | long-running | yes |
| delivery-service | `food/delivery-service` | `services/delivery/Dockerfile`, context = repo root | long-running | yes |
| notification-service | `food/notification-service` | `services/notification/Dockerfile`, context = repo root | long-running, **internal** | yes |
| gateway | `food/gateway` | `infra/nginx/Dockerfile`, context = `infra/nginx` | long-running, **public** | yes (or a cloud load balancer with the same routes, §4) |
| rabbitmq-setup | `food/rabbitmq-setup` | `infra/rabbitmq-setup/Dockerfile`, context = `infra/rabbitmq-setup` | **one-shot job** (exit 0), run before services start and after any permission change | yes |
| MongoDB | `mongo:8.0` | upstream | stateful | yes; a managed replica set (e.g. MongoDB Atlas) or a container with a persistent volume |
| RabbitMQ | `rabbitmq:4.1-management-alpine` | upstream | stateful | yes; a container with a persistent volume, or a managed broker (see §6, unverified) |
| Mailpit | `axllent/mailpit:v1.31.6` | upstream | long-running, **private** | yes for the academic demo (§11) |
| frontend (web app) | `food/frontend` | `frontend/Dockerfile`, context = `frontend` | long-running, **public** (static files) | yes, for the user-facing UI |
| devtools (testing console) | `food/devtools` | `tools/devtools/Dockerfile`, context = repo root | development only | optional; refuses to start with `NODE_ENV=production` (§12) |

Each service image is self-contained. It is a Node 24 Alpine image built in two stages, compiled `dist/` plus production dependencies only, running as the `node` user.
Each image has a `HEALTHCHECK` and `CMD node services/<svc>/dist/server.js`. Images do not contain `.env` files; `.dockerignore` excludes them.

## 2. Building images

The service and devtools images must be built **from the repository root**, because they include `packages/common`:

```bash
docker build -f services/order/Dockerfile -t food/order-service .
```

Repeat for `auth`, `catalog`, `payment`, `billing`, `delivery` and `notification`. The infrastructure images use their own directory as the build context:

```bash
docker build -t food/gateway infra/nginx
```

```bash
docker build -t food/rabbitmq-setup infra/rabbitmq-setup
```

The development console, only if you deploy it:

```bash
docker build -f tools/devtools/Dockerfile -t food/devtools .
```

Alternatively, `docker compose build` builds all of them with the local tags shown in §1. To push to a registry (e.g. Amazon ECR), retag each image with
the registry URL and `docker push` it. Any change under `packages/common/` requires rebuilding **every** service image.

## 3. Ports and network exposure

| Component | Container port | Local host port (Compose) | Cloud exposure |
|---|---|---|---|
| gateway | 80 | 8080 | **public** (the only public API entry point; put TLS in front of it) |
| frontend | 80 | 3000 | **public** (static web app; put TLS in front of it). The browser then calls the gateway's public URL |
| auth-service | 4001 | 4001 | private (reached only by the gateway) |
| catalog-service | 4002 | 4002 | private |
| order-service | 4003 | 4003 | private |
| payment-service | 4004 | 4004 | private (the gateway forwards `/payments/webhook`) |
| billing-service | 4005 | 4005 | private |
| notification-service | 4006 | not published | private (no gateway route; only `/health`) |
| delivery-service | 4007 | 4007 | private |
| MongoDB | 27017 | 27017 | **private** (services only) |
| RabbitMQ AMQP | 5672 (5671 with TLS) | 5672 | **private** (services only) |
| RabbitMQ management | 15672 | 15672 | **private** (`rabbitmq-setup` needs it; operators via VPN/SSH tunnel only) |
| Mailpit SMTP | 1025 | 1025 | private (notification-service only) |
| Mailpit UI/API | 8025 | 8025 | **private, restricted to project members** (§11) |
| devtools | 3100 | 127.0.0.1:3100 | not deployed; if ever used, private and restricted |

Locally, Compose publishes the service ports for debugging. In the cloud, publish **none** of them except the gateway's. Firewall
(security-group) rules:
- the gateway and the frontend accept 80/443 from the internet;
- services accept their port only from the gateway, plus the health checker;
- MongoDB and RabbitMQ accept connections only from the service tasks (and `rabbitmq-setup`);
- Mailpit SMTP accepts only from notification-service;
- Mailpit's UI accepts only from the project members' IPs or a VPN.

Outbound internet is needed only by:
- payment-service, and only when `PAYMENT_PROVIDER=stripe` (to reach `api.stripe.com`);
- the image pulls.

## 4. Service discovery and gateway routing

The gateway (`infra/nginx/nginx.conf`) has **hard-coded upstream hostnames**, `auth-service:4001`, `catalog-service:4002`, `order-service:4003`,
`payment-service:4004`, `billing-service:4005` and `delivery-service:4007`, and it resolves them through **Docker's embedded DNS**
(`resolver 127.0.0.11`). Neither works outside a Docker network. Before a cloud deployment, the team must either:
- provide DNS names identical to the Compose service names (e.g. a private DNS namespace / service discovery) **and** change the `resolver`
  line to the platform's DNS resolver (the code in this repo has not been changed or tested for this); **or**
- replace nginx with a cloud load balancer that has the same path rules.

The routes any replacement must reproduce:

| Path | Upstream | Notes |
|---|---|---|
| `/auth/` | auth-service:4001 | rate limit 10 r/s per IP, burst 20 |
| `/restaurants` | catalog-service:4002 | |
| `/orders` | order-service:4003 | |
| `~ ^/orders/[^/]+/tracking/stream$` | order-service:4003 | **Server-Sent Events**: buffering off, HTTP/1.1, read timeout 1 h |
| `/payments` | payment-service:4004 | includes `/payments/webhook`: the body must be forwarded byte-for-byte (signature check) |
| `/invoices`, `/discounts` | billing-service:4005 | |
| `/deliveries` | delivery-service:4007 | |
| `/health` | gateway itself | `{"status":"ok","service":"gateway"}` |
| `/health/{auth,catalog,order,payment,billing,delivery}` | that service's `/health` | |
| anything else | gateway | JSON 404 |

The gateway also:
- sets `X-Request-Id`, `X-Forwarded-For` and `X-Forwarded-Proto`;
- limits bodies to 100 kB;
- uses a 3 s connect timeout and a 15 s read timeout;
- exposes the `x-request-id`, `retry-after` and `idempotent-replayed` headers to browsers (CORS).

Services set CORS from `CORS_ORIGINS` (default `*`). The web frontend calls the gateway cross-origin, so in the cloud restrict it to the frontend's public origin (e.g. `https://app.example.org`), not to nothing.

**Services never call each other over HTTP**, so the gateway is the only component that needs to locate them. Services need to reach only
MongoDB, RabbitMQ, SMTP (notification) and optionally Stripe (payment).

## 5. MongoDB

- **A replica set is mandatory.**
  - Every publishing service writes the business change and its outbox event in a multi-document **transaction**.
  - The Order Service's live tracking uses a **change stream**.

  Both need a replica set; a standalone `mongod` does not work. Locally the Compose healthcheck runs `rs.initiate()` for a single-node set `rs0`
  whose member host is `mongo:27017`. Clients must be able to resolve the member host names the replica set advertises.
- **One logical database per service:** `auth_db`, `catalog_db`, `order_db`, `payment_db`, `billing_db`, `delivery_db` and `notification_db`. Each service gets
  its own `MONGO_URI`. Locally the URI is `mongodb://mongo:27017/<db>?replicaSet=rs0` with **no authentication**.
- **Cloud requirements.** These are not implemented in this repository:
  - enable authentication;
  - create one database user per service with `readWrite` on its own database only;
  - use TLS;
  - pass the credentials inside the `MONGO_URI` secret.

  With MongoDB Atlas, an `mongodb+srv://user:pass@cluster/<db>?retryWrites=true&w=majority` URI is the usual form. Whether every feature, especially
  change streams, works on the free tier is **unverified**.
- **Persistent storage:** the `mongo-data` volume (`/data/db`) locally; a managed cluster or a persistent volume in the cloud. Back it up.
- **Initialization and migrations.** Nothing needs to be run by hand. On startup:
  - Mongoose creates indexes;
  - Auth creates the bootstrap admin if absent;
  - Billing seeds discount codes (`SEED_DISCOUNTS`);
  - Catalog seeds only if `SEED_ON_START=true`, then runs its idempotent `ownerId → adminIds` migration;
  - Order runs its idempotent projection migration.

  Published outbox rows are TTL-deleted after 7 days.

## 6. RabbitMQ

- **Exchanges** (pre-declared by `rabbitmq-setup`):
  - `food.events` (topic, durable);
  - `food.restricted` (direct, durable).

  Each consumer declares its own queues, `.retry`/`.dlq` queues and `.parking` exchange at startup.
- **One broker user per service.** The users are `auth-service`, `catalog-service`, `order-service`, `payment-service`, `billing-service`,
  `delivery-service` and `notification-service`, plus `devtools` (monitoring only). Each gets least-privilege permissions plus topic permissions. They are created by the
  **`rabbitmq-setup`** job through the **management HTTP API**, using the bootstrap admin (`RABBITMQ_ADMIN_USER` / `RABBITMQ_ADMIN_PASSWORD`),
  at `RABBITMQ_API` (default `http://rabbitmq:15672/api`). The job is idempotent; run it before the services and after changing passwords.
  The service users' passwords come from `RABBITMQ_<SERVICE>_PASSWORD`.
- **Connection.** Each service gets `RABBITMQ_URL=amqp://<svc>-service:<password>@<host>:5672`. TLS brokers use `amqps://…:5671`. The client
  supports it, but this is **unverified** in this project.
- **Managed brokers (e.g. Amazon MQ for RabbitMQ).** Whether the management API, topic permissions and user creation used by `setup.mjs` are
  available, and whether the bootstrap-admin model fits, is **unverified**. A self-hosted RabbitMQ container with a persistent volume
  matches the local setup exactly.
- **Persistent storage:** the `rabbitmq-data` volume (`/var/lib/rabbitmq`). The local container also pins `hostname: rabbitmq`, so durable queues
  survive container recreation. A cloud container needs a **stable node name and a persistent volume**; otherwise durable queues and
  unconsumed messages are lost on replacement.
- **Recovery.** Services reconnect automatically and re-declare their topology. Outboxes hold events while the broker is unreachable. The Catalog
  re-broadcasts snapshots every 5 minutes.

## 7. Environment variables

The authoritative list, with defaults and validation, is `services/<svc>/src/config.ts`; the base schema is `packages/common/src/config.ts`. A service
**refuses to start** if a required variable is missing or invalid. Values used locally are in `docker-compose.yml`.

**Common to every service except notification:**
- `NODE_ENV` (`production` in containers);
- `PORT`;
- `LOG_LEVEL` (`info`);
- `MONGO_URI` (required);
- `JWT_SECRET` (required, ≥ 32 characters, **identical in all six services**);
- `JWT_ISSUER` (`food-auth-service`);
- `JWT_AUDIENCE` (`food-platform`);
- `RABBITMQ_URL` (required);
- `EVENT_EXCHANGE` (`food.events`);
- `OUTBOX_POLL_INTERVAL_MS` (1000);
- `CORS_ORIGINS` (`*`).

| Service | Service-specific variables (default) |
|---|---|
| auth | `JWT_EXPIRES_IN` (1h), `BCRYPT_ROUNDS` (12; Compose uses 10), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥ 8 chars), `ADMIN_NAME` (Platform Admin) |
| catalog | `SEED_ON_START` (code default `false`; **Compose default `true`**), `CATALOG_SNAPSHOT_INTERVAL_MS` (300000) |
| order | `ORDER_PAYMENT_DEADLINE_SECONDS` (900), `EXPIRY_SWEEP_INTERVAL_MS` (15000), `EXPIRY_BATCH_SIZE` (100), `DELIVERY_FEE` (4000 paise), `FREE_DELIVERY_THRESHOLD` (49900 paise) |
| payment | `PAYMENT_PROVIDER` (`mock`; or `stripe`), `STRIPE_SECRET_KEY` (test key `sk_test_…`/`rk_test_…` only; live keys are refused), `STRIPE_WEBHOOK_SECRET` (`whsec_…`), `MOCK_WEBHOOK_SECRET`, `MOCK_WEBHOOK_URL` (default `http://127.0.0.1:<PORT>/payments/webhook`), `ENABLE_TEST_ENDPOINTS` (code default `false`; Compose default `true`; enables `POST /payments/:id/simulate`), `RECONCILE_INTERVAL_MS` (5000), `PROVIDER_POLL_AFTER_MS` (60000), `STRIPE_API_URL` (tests only) |
| billing | `MIN_PAYABLE_AMOUNT` (100 paise), `SEED_DISCOUNTS` (`true`) |
| delivery | `OTP_HMAC_KEY` (required, ≥ 32 chars), `NOTIFICATION_OTP_PUBLIC_KEY` (required), `PREPARATION_DELAY_MS` (15000), `ASSIGNMENT_DELAY_MS` (5000), `ASSIGNMENT_RETRY_MS` (10000), `ASSIGNMENT_MAX_ATTEMPTS` (60), `ASSIGNMENT_TIMEOUT_MS` (600000), `WORKER_INTERVAL_MS` (1000), `OTP_TTL_MS` (300000), `OTP_MAX_ATTEMPTS` (5), `OTP_MAX_ISSUES` (3), `OTP_RESEND_COOLDOWN_MS` (30000) |
| notification | **no JWT variables**; `MONGO_URI`, `RABBITMQ_URL`, `SMTP_HOST` (mailpit), `SMTP_PORT` (1025), `SMTP_SECURE` (false), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_TIMEOUT_MS` (10000), `MAIL_FROM`, `APP_NAME` (FoodApp), `NOTIFY_MAX_ATTEMPTS` (8), `SENDER_INTERVAL_MS` (2000), `SEND_LEASE_MS` (60000), `NOTIFICATION_OTP_PRIVATE_KEY` (without it delivery codes are not emailed) |
| rabbitmq-setup | `RABBITMQ_API`, `RABBITMQ_ADMIN_USER`, `RABBITMQ_ADMIN_PASSWORD`, `RABBITMQ_{AUTH,CATALOG,ORDER,PAYMENT,BILLING,DELIVERY,NOTIFICATION}_PASSWORD` (all required), `RABBITMQ_DEVTOOLS_PASSWORD` (optional) |
| frontend | `API_URL`: the gateway URL **as the browser reaches it** (e.g. `https://api.example.org`). It is written into `/config.js` at container start and must start with `http://` or `https://`. Compose sets it from `FRONTEND_API_URL` (default `http://localhost:8080`). It is not a secret |
| devtools | `GATEWAY_URL`, `MAILPIT_URL`, `RABBITMQ_API`, `RABBITMQ_DEVTOOLS_PASSWORD`, `PUBLIC_GATEWAY_URL`, `PUBLIC_MAILPIT_URL`, `PUBLIC_RABBITMQ_URL`, `PORT` (3100) |
| RabbitMQ container | `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS` (bootstrap admin) |
| Mailpit | `MP_MAX_MESSAGES` (5000 locally) |

In `.env`, the payment flag is named `ENABLE_PAYMENT_TEST_ENDPOINTS`; Compose maps it to the service's `ENABLE_TEST_ENDPOINTS`.

Cloud decisions:
- set `ENABLE_TEST_ENDPOINTS` explicitly. The mock payment flow needs `true`, because the console and the scenarios use `simulate`; a real Stripe flow must use `false`;
- set `SEED_ON_START` explicitly;
- restrict `CORS_ORIGINS` to the frontend's public origin;
- set the frontend's `API_URL` to the gateway's public URL.

## 8. Secrets

Store these in a secret manager (e.g. AWS Secrets Manager / SSM Parameter Store) and inject them as environment variables. **Never** bake them into
images or commit them. `.env` is git-ignored. `node scripts/init-env.mjs` generates fresh local values; generate **new** values for the cloud.

| Secret | Used by |
|---|---|
| `JWT_SECRET` | auth, catalog, order, payment, billing, delivery (same value) |
| `ADMIN_PASSWORD` (+ `ADMIN_EMAIL`) | auth (bootstrap platform admin) |
| `MONGO_URI` for each service (contains DB credentials in the cloud) | each service |
| RabbitMQ bootstrap admin password | RabbitMQ container, rabbitmq-setup |
| `RABBITMQ_<SERVICE>_PASSWORD` (7) and the matching `RABBITMQ_URL`s | rabbitmq-setup + each service |
| `RABBITMQ_DEVTOOLS_PASSWORD` | rabbitmq-setup, devtools (only if deployed) |
| `OTP_HMAC_KEY` | delivery |
| `NOTIFICATION_OTP_PUBLIC_KEY` / `NOTIFICATION_OTP_PRIVATE_KEY` (X25519 pair; private key only for notification) | delivery / notification |
| `MOCK_WEBHOOK_SECRET`; `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (if Stripe test mode) | payment |
| `SMTP_USER` / `SMTP_PASSWORD` (empty for Mailpit) | notification |
| `DELIVERY_AGENT_PASSWORD` | only `scripts/seed-delivery-agents.mjs` (not a container) |

The Compose defaults `RABBITMQ_PASSWORD=food-dev-password` and `MOCK_WEBHOOK_SECRET=whsec_mock_local_development_only` are public placeholders.
Replace them in any shared environment.

## 9. Startup order, health checks and restarts

Startup order, as encoded in Compose `depends_on`:
1. MongoDB healthy (replica set has a primary) and RabbitMQ healthy;
2. `rabbitmq-setup` completed successfully;
3. the seven services;
4. the gateway (it resolves upstreams per request, so it can start earlier);
5. devtools.

A service retries its first MongoDB connection 10 times, 3 s apart, then exits. After that the driver reconnects. RabbitMQ connections retry indefinitely.
An orchestrator should therefore **restart failed tasks** (Compose uses `restart: unless-stopped`). `rabbitmq-setup` must not restart (`restart: "no"`).

| Health endpoint | Status semantics |
|---|---|
| `GET /health` on each service (in-container port; image `HEALTHCHECK` uses `wget http://127.0.0.1:<port>/health`) | 200 `ok`; 200 `degraded` when an *optional* dependency is down (RabbitMQ for all; SMTP and OTP key for notification); **503 `unhealthy` when MongoDB is down** |
| `GET /health` on the gateway | 200 always (liveness) |
| `GET /health/<svc>` through the gateway | proxies the service's `/health` (not for notification) |
| frontend `GET /healthz` | web app (nginx) liveness |
| devtools `GET /healthz` | console liveness |

Use the service `/health` as the container/target health check. Do **not** fail a target on `degraded`: the services keep working, and their events
wait in the outbox. On SIGTERM a service stops accepting requests, closes SSE streams, drains the outbox relay, closes the broker and disconnects
MongoDB, all within 10 s. Allow at least that much stop timeout.

**Scaling.** Services are stateless:
- outbox rows are claimed with lease locks;
- workers (the order expiry sweep, the payment reconciler, the delivery scheduler and the notification sender) use compare-and-set or leases;
- SSE uses a per-instance change stream.

Multi-replica operation was designed for but is **unverified** (no multi-replica test was run).

## 10. Logging

Every service writes **structured JSON logs to stdout** (pino), with `service`, `level`, `time` and the request id. The gateway writes a JSON access log to stdout.
Ship container stdout to the platform's log service (e.g. CloudWatch Logs). The logger redacts `Authorization` headers and `password` /
`passwordHash` fields (`packages/common/src/logger.ts`). By design the delivery code is never logged or stored in plaintext. Not logging other
secrets is a coding convention, not an enforced guarantee. Useful alerts:
- messages in any `*.dlq` queue;
- a growing `outbox_events` backlog (`status: pending`);
- 5xx rates at the gateway;
- `/health` 503s.

## 11. Mailpit (email in the final project)

The team decided to **keep Mailpit as the email backend for the academic demonstration**. Replacing it is not a prerequisite.

- The Notification Service sends every email over SMTP (`SMTP_HOST`/`SMTP_PORT`) to Mailpit.
- Mailpit **captures** emails and never delivers them to real inboxes, so **fictional addresses** (e.g. `@food.local`, `@example.com`) work.
- **Delivery OTP emails are captured too.** The customer, or the demo presenter, reads the 6-digit code in Mailpit's UI.
- Mailpit's inbox is **shared and unauthenticated**: anyone who can open its UI can read every customer's email and every delivery code. Its UI and API
  (port 8025) **must not be publicly exposed**. Restrict them to authorised project members, for example with security-group IP allow-lists or a VPN/SSH tunnel.
  Mailpit's own UI authentication options were not configured or tested (**unverified**).
- SMTP (1025) should accept connections only from the notification service.
- Mailpit has no volume locally (`MP_MAX_MESSAGES=5000`), so recreating the container empties the inbox. Add a volume if the demo needs persistence.
- Switching to a real SMTP provider later only needs `SMTP_*` and `MAIL_FROM`; no code changes. This has not been tested with a real provider.

## 12. Known deployment blockers and limitations

| # | Item | Impact | Status |
|---|---|---|---|
| 1 | Gateway uses Docker's DNS (`resolver 127.0.0.11`) and hard-coded Compose hostnames | gateway cannot reach services outside a Docker network | **blocker**: change the resolver/hostnames or use a load balancer (§4) |
| 2 | MongoDB has no authentication locally; per-service DB users not implemented | cloud DB would be open | **blocker**: create per-service users, pass credentials in `MONGO_URI` (§5) |
| 3 | MongoDB must be a replica set reachable under its advertised member names | transactions/change streams fail on a standalone server | prerequisite (§5) |
| 4 | Broker provisioning relies on the RabbitMQ management API and topic permissions | may not work on a managed broker | **unverified** (§6) |
| 5 | RabbitMQ container needs a stable node name + persistent volume | otherwise durable queues are lost on replacement | prerequisite (§6) |
| 6 | No TLS anywhere locally (gateway HTTP, AMQP, MongoDB, SMTP) | traffic in clear text | add TLS at the edge; TLS to managed services is unverified |
| 7 | `CORS_ORIGINS=*` default | any origin can call the API from a browser | set explicitly |
| 8 | `ENABLE_TEST_ENDPOINTS` / mock payments | the demo payment flow depends on the `simulate` endpoint | acceptable for the academic demo; disable for anything real |
| 9 | JWT revocation: tokens valid ≤ 1 h after deactivation; HS256 secret shared by six services | compromise of one service exposes the signing secret | documented limitation (RS256 + JWKS would fix it) |
| 10 | Testing console (`devtools`) is development-only and refuses `NODE_ENV=production`; it targets Compose hostnames | no hosted browser UI for the demo unless the team deploys it deliberately (with `NODE_ENV=development`, private access and the `GATEWAY_URL`/`PUBLIC_*` variables set) | team decision; not designed for public hosting |
| 11 | Multi-replica operation, real Stripe test mode, managed services, cloud networking | not exercised | **unverified** |
| 12 | Demo seed scripts call the gateway with the admin password | must not run against shared environments carelessly | `seed-delivery-agents.mjs` refuses `NODE_ENV=production` |
| 13 | No CI/CD, no infrastructure as code in the repository | images are built and pushed by hand | out of scope for this handover |
| 14 | The earlier AWS outline (ARCHITECTURE §11: ECS Fargate, ALB, Atlas, Amazon MQ, Terraform) is a **proposal**, never provisioned | — | use as a starting point only |

## 13. Pre-deployment checklist

- [ ] Decide the target platform and the networking: private network for services, MongoDB, RabbitMQ and Mailpit; only the gateway public.
- [ ] Resolve blocker 1 (gateway discovery) and test the routing table of §4, including SSE and the webhook route.
- [ ] Provision MongoDB as a replica set with per-service users and TLS; build the seven `MONGO_URI`s.
- [ ] Provision RabbitMQ with a persistent volume (or verify a managed broker); run `rabbitmq-setup` once and check that it exits 0.
- [ ] Generate new secrets (§8) and store them in a secret manager; never reuse the local `.env`.
- [ ] Build and push the images (§2); record the image tags.
- [ ] Set `SEED_ON_START`, `ENABLE_TEST_ENDPOINTS`, `PAYMENT_PROVIDER` and `CORS_ORIGINS` explicitly.
- [ ] Configure health checks on `/health`, a restart policy and stop timeouts of at least 10 s.
- [ ] Route stdout logs to the log service; add DLQ and backlog alerts.
- [ ] Deploy Mailpit privately and restrict its UI to project members.
- [ ] Smoke-test through the public gateway: register → order → simulate payment → delivery → OTP from Mailpit → delivered.
