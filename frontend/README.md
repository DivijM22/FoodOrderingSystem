# Frontend

The web application of the food ordering platform, built with React 19, TypeScript, Vite and React Router. One app serves all four roles: customer,
restaurant administrator, delivery agent and platform administrator. It contains **no business logic**. Every action is a call to the existing
**API gateway** using the signed-in user's JWT, and the backend remains the security boundary. The UI hides actions a role cannot perform only to
make the app easier to use.

It is independent of the backend monorepo. It is not an npm workspace, has its own `package-lock.json`, and has its own image and Compose service.

## Structure

```
frontend/
├── index.html              loads /config.js (runtime config) and the app
├── public/config.js        development default: window.__APP_CONFIG__ = { apiUrl: 'http://localhost:8080' }
├── src/
│   ├── main.tsx, App.tsx   entry point; ALL routes are defined in App.tsx
│   ├── routes.ts           each role's home page and navigation entries
│   ├── config.ts           API gateway URL resolution
│   ├── api/                client.ts (fetch wrapper, error envelope, JWT, 401 handling) + one module per backend area
│   │                       (auth, catalog, orders/billing/payments, deliveries) + types.ts (response shapes)
│   ├── auth/               AuthContext (session in sessionStorage, expiry, logout), ProtectedRoute (login + role guard)
│   ├── components/         Layout (top navigation), ui (fields, alerts, badges, dialogs), OrderParts (order summary,
│   │                       tracking panel, cancellation), useTracking (SSE + polling), useAsync, CheckList
│   ├── pages/              login, public registration, profile, not found
│   ├── customer/           restaurants, restaurant + cart + checkout, my orders, order (invoice, payment, tracking)
│   ├── admin/              users (create, activate/deactivate), restaurants (create, administrator assignments)
│   ├── restaurant/         my restaurants, manage restaurant (menu, details, orders), order details
│   └── delivery/           dashboard (availability, current delivery, pickup/arrival/code), delivery details
├── Dockerfile              node build → nginx static image
└── docker/                 nginx.conf (SPA fallback, /healthz), 40-app-config.sh (writes /config.js from API_URL)
```

## Install and run

Prerequisites: Node.js ≥ 24, and the backend running (`docker compose up -d` in the repository root).

```bash
cd frontend
```

```bash
npm install
```

```bash
npm run dev
```

This serves the app at http://localhost:5173. Check the code without a full build with `npm run typecheck`. For a production build into `dist/`, run:

```bash
npm run build
```

## Docker

The root `docker-compose.yml` has a `frontend` service, served at **http://localhost:3000**:

```bash
docker compose up -d --build frontend
```

To build the image alone, use the `frontend/` directory as the build context:

```bash
docker build -t food/frontend frontend
```

The image is nginx serving the static build. It never proxies API calls, holds no secrets and has a health check at `/healthz`.

## API gateway configuration

The browser calls the gateway **directly**, cross-origin; the services already allow this through CORS. The gateway URL is resolved at runtime in this order:

1. `/config.js` (`window.__APP_CONFIG__.apiUrl`). In the container, `docker/40-app-config.sh` writes it at start-up from **`API_URL`**.
   Compose sets that from `FRONTEND_API_URL`, with default `http://localhost:8080`. The same image therefore works in every environment.
2. `VITE_API_URL` at build time.
3. `http://localhost:8080`.

`API_URL` must be the gateway address **as the user's browser reaches it**, not a Docker-internal hostname. Alternatively it can be the
same-origin path **`/api`**: the container's nginx proxies `/api/*` to `http://gateway:80/*`, stripping the prefix and passing the method,
body, query string and `Authorization` header through, with buffering off for SSE. The browser then only ever calls the frontend's own origin.
`docker-compose.azure.yml` uses this. It publishes the frontend on port 80 with `API_URL=/api` and binds the gateway and all other ports to
`127.0.0.1`:

```bash
docker compose -f docker-compose.yml -f docker-compose.azure.yml up -d --build --no-deps frontend
```

## Sessions

Login uses `POST /auth/login`. The JWT and the user are kept in **sessionStorage**: they survive reloads, are per tab, and are cleared when the tab closes.
- The app logs out automatically when the token expires (1 h), or when the gateway rejects it (`TOKEN_EXPIRED`, `INVALID_TOKEN`).
- The profile page re-reads `/auth/me`. A deactivated account, which gets 404, is logged out.
- Public registration always creates a **customer**. Staff accounts are created by a platform administrator.

## Role-based routes

| Role | Home | Pages |
|---|---|---|
| (anyone) | `/login` | `/login`, `/register` (customers only), `/profile` (signed in) |
| customer | `/restaurants` | `/restaurants`, `/restaurants/:id` (menu, cart, checkout), `/orders`, `/orders/:id` (invoice, payment, live tracking, cancel) |
| restaurant_admin | `/manage` | `/manage` (assigned restaurants), `/manage/:id` (menu, details, open/close, orders), `/manage/orders/:orderId` |
| delivery_agent | `/deliveries` | `/deliveries` (availability, current delivery, history), `/deliveries/:id` |
| platform_admin | `/admin/users` | `/admin/users` (accounts: search, create, activate/deactivate, delete), `/admin/restaurants` (create, administrators) |

Opening another role's page redirects to the user's own home page.

## Features and the endpoints they use

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/register`, `GET /auth/me` |
| Customer browsing | `GET /restaurants`, `GET /restaurants/:id`, `GET /restaurants/:id/menu` |
| Ordering | `POST /orders` (with `Idempotency-Key`; prices are never sent), `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel` |
| Invoice and payment | `GET /invoices/order/:id`, `GET /payments/order/:id`, `POST /payments/initiate` (retries `409 BILLING_PENDING`), `POST /payments/:id/simulate` (**mock provider only; labelled "simulated"**) |
| Tracking | `GET /orders/:id/tracking/stream` (SSE, read with `fetch` so the JWT is sent in a header), with `GET /orders/:id/tracking` polling as fallback |
| Platform admin | `GET/POST /auth/users`, `PATCH /auth/users/:id/status`, `DELETE /auth/users/:id`, `GET /restaurants?includeInactive=true`, `POST /restaurants`, `POST/DELETE /restaurants/:id/admins[/:userId]` |
| Restaurant admin | `GET /restaurants/mine`, `PATCH /restaurants/:id`, `PATCH /restaurants/:id/open`, `POST/PATCH/DELETE /restaurants/:id/menu[/:itemId]`, `PATCH …/availability`, `GET /orders?restaurantId=` |
| Delivery agent | `GET/PUT /deliveries/agents/me`, `GET /deliveries`, `GET /deliveries/:id`, `POST /deliveries/:id/pickup`, `/arrived`, `/verify-otp`, `/resend-otp` |

Notes:
- **Customer.** The cart shows an *estimate* only. The order total comes from the Order Service and the payable amount from the Billing invoice. Order
  progress is rendered only from the server's status history; the app never advances a status itself. Customers can cancel in `pending_payment` and `confirmed`.
- **Restaurant administrator.** There are no restaurant creation or assignment controls; all administrators of a restaurant see the same pages. Cancellation is offered
  up to `assigning_delivery_partner`.
- **Platform administrator.** Creating a restaurant administrator requires selecting at least one restaurant. The account is created first, then
  each assignment. If an assignment fails, the account is kept and **Retry** sends only the failed assignments again; the account is never created twice. The
  deactivation dialog explains that a deactivated restaurant administrator loses all assignments, and that reactivation restores none.
- **Account search and deletion (Stage 9).**
  - *All accounts* loads every page of the selected role (`GET /auth/users`, 100 per call), so the search box covers all accounts, not just one page.
  - Search filters client-side by name, email or user id; the list is paged client-side, 20 per page. There is no search API.
  - **Delete** appears on every row but is enabled only for **inactive** accounts other than your own.
  - The confirmation dialog shows the name, email and role and states that deletion is permanent and that business history is kept. It
    enables *Delete permanently* only after an acknowledgement checkbox is ticked.
  - Backend refusals such as `USER_ACTIVE` or `AGENT_HAS_ACTIVE_DELIVERY` are shown in the dialog. On success the list reloads and a message
    names the deleted account. There is no bulk delete.
- **Delivery agent.** Before the Delivery Service assigns anything, the agent registers a phone number and goes available. The delivery code is typed in and
  verified by the Delivery Service: the app never generates, stores or bypasses it. Mailpit is not linked; for demonstrations, read code emails in Mailpit
  separately.

## Verification status

- Type check and production build pass. The Docker image builds and runs healthy in Compose.
- A headless-browser walkthrough of all four roles was run against the local stack on 2026-10-26; it is not committed to the repository. It covered:
  - the admin creating a restaurant admin (including the at-least-one-restaurant check) and an agent;
  - the agent going available;
  - customer registration and login, an order, the invoice, a simulated payment and live SSE tracking up to the partner assignment;
  - pickup, arrival, a rejected wrong code, the correct code, and delivered;
  - the restaurant admin seeing only their restaurant and its order, and toggling an item's availability;
  - the role guard;
  - deactivation removing the assignment (event-driven), and the deactivated login being refused.

  The test accounts it created were deactivated at the end.
- **Stage 9 (account search and deletion): type check and production build only.** The search and the delete dialog have not been run in a
  browser, and no account was deleted during development.
- **Not exercised in a browser:**
  - the declined-payment retry, cancellation and refund;
  - restaurant creation, menu add/edit/delete and details editing;
  - assignment removal through the UI and the partial-assignment-failure retry;
  - code resend, the polling fallback, and session expiry;
  - phone-sized layouts beyond screenshots.

## Known limitations

- Live tracking reads the SSE stream with `fetch` streaming, which all current browsers support. If the stream is unavailable, the page polls every 5 s.
- The delivery dashboard refreshes every 10 s (the Delivery Service has no push channel for agents).
- No profile editing, password change, saved-address management or discount codes (not in scope). Search exists only in the admin's account list.
- Lists show up to 50 restaurants per call (all pages are loaded for admins) and 20 orders per page.
- The JWT lives in sessionStorage, so a malicious script in the page could read it. The app loads no third-party scripts, and React escapes all rendered data.
- Stripe test mode is not supported in the UI (no Stripe.js); with `PAYMENT_PROVIDER=stripe` the payment panel says so.
