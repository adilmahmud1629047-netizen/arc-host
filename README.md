# Minecraft Hosting Client

Minecraft hosting storefront and customer portal. This repository contains an Express.js REST API, a plain HTML/CSS/JavaScript frontend, a secure admin panel (`frontend/admin/`), and a PostgreSQL schema with a minimal migration runner.

> **Provenance:** the backend/API, admin panel, and database schema were forked from the
> **FLARE HostiNG** template. Everything below the "Client environment" section documents that
> inherited code and is being rebranded separately. Nothing in this repository may contact the
> original FLARE project's database, domain, or port.

## Client environment (read this first)

| Purpose | Value |
|---|---|
| Dev server | `PORT=5001` (`http://127.0.0.1:5001`) |
| Client test server | `5056` (`http://127.0.0.1:5056`) — start it yourself, see below |
| Original FLARE project | `5000` — **owned by the other project; never start this app there** |
| Leftover inherited harness | `5055` — runs the old FLARE test app; **never use for client tests** |
| Database | `minecraft_client` — **never `flare_hosting`** |
| Payments / SMS | `PAYMENT_PROVIDER=disabled`, `BKASH_PAYMENT_ENABLED=false`, `SMS_PROVIDER=disabled` |

`5056` is the only port this project's tests talk to. Every test file reads `TEST_BASE_URL`
(and falls back to `http://127.0.0.1:5056`), so no executable test hardcodes `5055` any more.

### Running the test server

```powershell
$env:PORT='5056'
$env:NODE_ENV='test'                              # enables the test-only reset hook + HMAC fixture
$env:TEST_BASE_URL='http://127.0.0.1:5056'
$env:PUBLIC_URL='http://127.0.0.1:5056/'
$env:APP_PUBLIC_URL='http://127.0.0.1:5056'
node src/server.js        # from backend/
```

Then run the suite (the hook is loaded automatically by the npm script):

```powershell
npm test          # node --test --require ./test/_hooks.cjs ...
```

Notes:

- `PUBLIC_URL` / `APP_PUBLIC_URL` are passed **per run only**. `.env` keeps `APP_PUBLIC_URL` empty
  while payments are disabled — never put a production origin there.
- **No provider credentials are needed for tests.** With `NODE_ENV=test` the server falls back to
  a deterministic HMAC fixture (`textbee-webhook-secret-for-tests-20chars-min`) that matches
  `TEST_SECRET` in the textbee/bKash test files. It is not a real TextBee secret, it is never
  stored in `.env`, and it does **not** apply outside `NODE_ENV=test` (a dev/prod server answers
  `503 SMS_PROVIDER_NOT_CONFIGURED` instead).
- **Rate limits are never raised.** `REGISTER_RATE_LIMIT_MAX=10`/hour and
  `LOGIN_RATE_LIMIT_MAX=10`/15 min stay exactly as committed. `backend/test/_hooks.cjs` registers a
  root `beforeEach` that clears in-memory limiter counters before every test — on the test server
  via `POST /api/_test/reset-rate-limits` (registered only when `NODE_ENV=test`, loopback-only) and
  in-process for limiters created by the test files themselves. This isolates tests without
  touching any limit, window or default, so every `429` assertion still exercises the real
  limiter.


## Project Structure

```
project-root/
├── frontend/            # Customer website (plain HTML/CSS/JS)
│   └── admin/           # Admin panel (login, dashboard overview, order management)
├── backend/
│   ├── src/
│   │   ├── config/      # Environment + database configuration
│   │   ├── controllers/ # Request handlers
│   │   ├── middleware/  # Error handling and shared middleware (auth, admin, CSRF)
│   │   ├── models/      # Parameterized query modules (finders)
│   │   ├── routes/      # API route definitions (incl. /api/admin)
│   │   ├── services/    # Business logic + migration runner
│   │   ├── jobs/        # Background jobs / automation (future)
│   │   ├── app.js       # Express app (clean URL allowlist)
│   │   └── server.js    # Server entry point
│   └── package.json
├── database/
│   ├── migrations/      # Ordered SQL migrations
│   ├── seeds/           # Optional SQL seeds (demo catalog lives in backend)
│   └── README.md        # Schema documentation
├── .env.example
├── .gitignore
└── README.md
```

## Prerequisites

- Node.js 18+ (tested on Node 24)
- npm
- PostgreSQL 13+ (tested on PostgreSQL 18)

## Installation

```bash
cd backend
npm install
```

Then create your local environment file (never commit it):

```bash
copy .env.example .env    # Windows
# cp .env.example .env    # macOS / Linux
```

## Environment Variables

All secrets live in `.env` (see `.env.example`). Never hardcode passwords, API keys, or database credentials.

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | `development` or `production` | `development` |
| `PORT` | API listen port (this project: `5001`) | `5001` |
| `API_PREFIX` | REST API route prefix | `/api` |
| `DATABASE_HOST` | PostgreSQL host | `localhost` |
| `DATABASE_PORT` | PostgreSQL port | `5432` |
| `DATABASE_NAME` | Database name (this project: `minecraft_client`) | `minecraft_client` |
| `DATABASE_USER` | Database user | `postgres` |
| `DATABASE_PASSWORD` | Database password (never commit) | — |
| `DATABASE_POOL_MAX` | Max pooled connections | `10` |
| `DATABASE_SSL` | `true` to require SSL | `false` |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Connect timeout (ms) | `5000` |
| `SESSION_COOKIE_NAME` | Auth session cookie name | `fh_session` |
| `SESSION_TTL_SECONDS` | Session lifetime (seconds) | `604800` (7 days) |
| `LOGIN_RATE_LIMIT_WINDOW_MS` | Login rate-limit window | `900000` (15 min) |
| `LOGIN_RATE_LIMIT_MAX` | Login attempts per window | `10` |
| `REGISTER_RATE_LIMIT_WINDOW_MS` | Registration rate-limit window | `3600000` (1 h) |
| `REGISTER_RATE_LIMIT_MAX` | Registrations per window | `10` |
| `ORDER_RATE_LIMIT_WINDOW_MS` | Order create rate-limit window | `900000` (15 min) |
| `ORDER_RATE_LIMIT_MAX` | Order creates per window | `30` |
| `PAYMENT_RATE_LIMIT_WINDOW_MS` | Payment create rate-limit window | `900000` (15 min) |
| `PAYMENT_RATE_LIMIT_MAX` | Payment creates per window | `30` |
| `PAYMENT_PROVIDER` | Payment provider id — `disabled` (default) or `sslcommerz` (sandbox only; live mode refused) | `disabled` |
| `SSLCOMMERZ_STORE_ID` | SSLCommerz sandbox store id (required when provider is `sslcommerz`) | — |
| `SSLCOMMERZ_STORE_PASSWORD` | SSLCommerz sandbox store password (env only — never committed) | — |
| `SSLCOMMERZ_MODE` | Only `sandbox` is accepted; anything else → `503` | `sandbox` |
| `SSLCOMMERZ_BASE_URL` | Sandbox gateway base URL | `https://sandbox-gw.sslcommerz.com` |
| `SSLCOMMERZ_VALIDATION_URL` | Sandbox Order Validation API URL | `https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php` |
| `APP_PUBLIC_URL` | Public base URL of this app — the only source for gateway success/fail/cancel/IPN URLs (must be externally reachable `https` for real IPN; localhost cannot receive IPN) | `http://localhost:5000` |
| `PAYMENT_CALLBACK_RATE_LIMIT_WINDOW_MS` | SSLCommerz callback rate-limit window | `60000` (1 min) |
| `PAYMENT_CALLBACK_RATE_LIMIT_MAX` | SSLCommerz callbacks per window | `120` |
| `SSLCOMMERZ_CONNECT_TIMEOUT_MS` | Gateway connect timeout (ms) | `10000` |
| `SSLCOMMERZ_REQUEST_TIMEOUT_MS` | Gateway request timeout (ms) | `15000` |
| `BKASH_PAYMENT_ENABLED` | `true` to enable bKash inbound-SMS auto-verification (Step 17). Default **false** — do not enable until real TextBee credentials + webhook delivery are verified. | `false` |
| `BKASH_RECEIVER_NUMBER` | Receiver SIM number for bKash payment SMS (server-side only — the payment SIM, not the SMS sender). Optional; recorded in verification metadata only. | — |
| `SMS_PROVIDER` | SMS provider id — `disabled` (default) or `textbee` | `disabled` |
| `TEXTBEE_API_KEY` | TextBee API key — server-side only; never commit, log, or expose it | — |
| `TEXTBEE_BASE_URL` | TextBee REST API base URL | `https://api.textbee.dev/api/v1` |
| `TEXTBEE_DEVICE_ID` | Optional device id. **Outbound:** default TextBee send device (empty → provider default). **Inbound webhook (Step 21):** when non-empty, `payload.deviceId` must exactly match or the request is rejected `401` after HMAC; when empty, any/missing deviceId is accepted (legacy). Value is server-only — never logged, returned, or committed. | — |
| `TEXTBEE_GATEWAY_ID` | Optional gateway id for incoming-SMS metadata | — |
| `TEXTBEE_SIM_SUBSCRIPTION_ID` | Optional SIM subscription id (empty → device default SIM; invalid values ignored) | — |
| `TEXTBEE_WEBHOOK_SECRET` | Server-side HMAC secret for `X-Signature` on `POST /api/webhooks/textbee/sms` (must match the TextBee dashboard webhook subscription). Value lives only in `.env` — never in source, logs, API responses, or this document. | — |
| `TEXTBEE_WEBHOOK_RATE_LIMIT_WINDOW_MS` | Incoming webhook rate-limit window | `60000` (1 min) |
| `TEXTBEE_WEBHOOK_RATE_LIMIT_MAX` | Incoming webhooks per window | `120` |
| `SMS_REQUEST_TIMEOUT_MS` | TextBee request timeout (ms) | `10000` |
| `SMS_RATE_LIMIT_WINDOW_MS` | SMS send rate-limit window (future internal endpoints) | `900000` (15 min) |
| `SMS_RATE_LIMIT_MAX` | SMS sends per window | `10` |
| `PROVISIONING_PROVIDER` | Provisioning provider id — `disabled` (default) refuses everything with `PROVISIONING_PROVIDER_NOT_CONFIGURED`; `proxmox` / `whm` select a real provider (Step 12 placeholders refuse with `PROVISIONING_NOT_IMPLEMENTED` — no external call) | `disabled` |
| `PROXMOX_API_URL` | Future Proxmox VE API base URL (https only; required when provider is `proxmox`) | — |
| `PROXMOX_TOKEN_ID` | Future Proxmox API token id (env only — never committed) | — |
| `PROXMOX_TOKEN_SECRET` | Future Proxmox API token secret (env only — never committed) | — |
| `PROXMOX_NODE` | Future Proxmox node name | — |
| `WHM_API_URL` | Future WHM/cPanel API base URL (https only; required when provider is `whm`) | — |
| `WHM_API_TOKEN` | Future WHM API token (env only — never committed) | — |
| `WHM_USERNAME` | Future WHM API username | — |
| `ARGON2_MEMORY_COST` | Argon2id memory (KiB) | `19456` |
| `ARGON2_TIME_COST` | Argon2id time cost | `2` |
| `ARGON2_PARALLELISM` | Argon2id parallelism | `1` |
| `CATALOG_CURRENCY` | Default ISO currency for seeded/demo plans | `BDT` |
| `CATALOG_CACHE_TTL_MS` | In-process catalog list cache TTL (ms) | `30000` |

## PostgreSQL Setup

1. Install PostgreSQL 13+ and start the service.
2. Create a role and note its password (or use an existing superuser for local dev).
3. Copy `.env.example` to `.env` and set `DATABASE_USER` / `DATABASE_PASSWORD`.

### Create the database

```bash
cd backend
npm run db:create
```

(Or manually: `CREATE DATABASE flare_hosting;`)

### Check connectivity

```bash
npm run db:check
```

### Run migrations

```bash
npm run db:migrate     # apply pending migrations
npm run db:status      # show applied vs pending
```

Migrations are ordered SQL files in `database/migrations/`. They run in numbered order, each inside a transaction, and are tracked in the `schema_migrations` table. Re-running is safe — applied migrations are skipped. See `database/README.md` for schema details.

### Seed the demo plan catalog

```bash
cd backend
npm run db:seed     # idempotent: unique slugs via ON CONFLICT DO NOTHING
```

Seeds only the public hosting/VPS plan catalog (Starter/Business/Pro and VPS-1/VPS-2/VPS-4) with clearly labeled sample/demo data. It never creates users, orders, or infrastructure. Production (`NODE_ENV=production`) is refused unless `SEED_ALLOW_PRODUCTION=true` is set explicitly.

## Running the Backend

Development (auto-restart on file changes):

```bash
cd backend
npm run dev
```

Production:

```bash
cd backend
npm start
```

The API listens on `http://localhost:5000` by default.

## Testing the Health Check

```bash
curl http://localhost:5000/api/health
```

Example response:

```json
{
  "status": "ok",
  "service": "flare-hosting-api",
  "timestamp": "2026-09-23T00:00:00.000Z",
  "uptimeSeconds": 12,
  "environment": "development",
  "database": "up"
}
```

`database` is `up` or `down` based on a live connectivity probe. You can also open `http://localhost:5000/` in a browser (the backend serves the static frontend).

## Authentication (customer)

- **Password hashing:** Argon2id (`argon2` package). Passwords must be 12–128 characters and include at least one uppercase letter, one lowercase letter, and one digit.
- **Sessions:** a random 32-byte `base64url` token is set in an `HttpOnly; SameSite=Lax; Path=/` cookie (`fh_session`). Only a SHA-256 hash of the token is stored in PostgreSQL (`sessions` table). `Secure` is added automatically when `NODE_ENV=production`.
- **Endpoints** (all JSON, prefix `/api/auth`):
  - `POST /register` — create a customer account (`201`; `409 EMAIL_EXISTS`; `400 VALIDATION_ERROR`).
  - `POST /login` — returns a session cookie (`200`; `401 INVALID_CREDENTIALS` with generic message; `403 ACCOUNT_DISABLED`).
  - `GET /me` — current user for a valid session (`200`; `401 UNAUTHORIZED`).
  - `POST /logout` — destroys the session and clears the cookie (`200`, safe when logged out).
- **Rate limiting:** in-memory fixed window per IP (defaults above) → `429 RATE_LIMITED` with `Retry-After`.
- **CSRF/origin:** auth `POST` routes reject requests whose `Origin` header (when present) does not match `Host` (`403 CSRF_INVALID`). SameSite=Lax provides additional browser protection.
- **Security headers:** CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, COOP; HSTS only when production + HTTPS.

## Public Plan API

Read-only catalog endpoints for the marketing pages. No authentication required. Only rows with `status = 'active'` are returned.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/plans/hosting` | List active web hosting plans |
| `GET` | `/api/plans/vps` | List active VPS plans |
| `GET` | `/api/plans/hosting/:slug` | One hosting plan by slug |
| `GET` | `/api/plans/vps/:slug` | One VPS plan by slug |

Slug format: lowercase letters, digits, and single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`, max 100 chars).

**List example**

```bash
curl http://localhost:5000/api/plans/hosting
```

```json
{
  "success": true,
  "data": [
    {
      "id": "c9867c19-…",
      "name": "Starter",
      "slug": "starter",
      "description": "Sample demo tier…",
      "price": "299.00",
      "currency": "BDT",
      "billingCycle": "monthly",
      "storageGb": 5,
      "bandwidthGb": 50,
      "domains": 1,
      "emailAccounts": 5,
      "databases": 2,
      "ssl": true
    }
  ]
}
```

- `price` is a string (from `NUMERIC`) so clients never do float money math.
- `null` on resource fields (`domains`, `emailAccounts`, `databases`, `bandwidthGb`) means **unlimited**.
- Single-plan success: `{"success":true,"data":{…}}`.

**Errors**

| Case | Status | Code |
|---|---|---|
| Malformed slug | `400` | `VALIDATION_ERROR` |
| Valid slug but missing/inactive | `404` | `PLAN_NOT_FOUND` |

```json
{
  "success": false,
  "error": {
    "code": "PLAN_NOT_FOUND",
    "message": "Plan not found."
  }
}
```

DB failures go through the global handler and return a generic message — SQL details are never leaked. Lists are cached in-process for `CATALOG_CACHE_TTL_MS` (default 30s).

The web/VPS plan pages load these endpoints from `frontend/js/plans.js` and link CTAs to `register.html?plan=<slug>`. The `plan` query param is **not** authorization — order creation re-validates the plan server-side against PostgreSQL.

## Customer Dashboard

`dashboard.html` is the authenticated customer area. On load it calls `GET /api/auth/me`:

- **401** → redirects to `login.html?return=dashboard.html…` (same-origin relative return path only).
- **200** → shows the signed-in user (name, email, account status, email verification) and enables sections.

### Sections

| Section | Hash | Behavior |
|---|---|---|
| Overview | `#overview` | Stat cards: Active Services **live count from `/api/services`** (`status = active`; `None yet` / `Unavailable` when applicable), Pending Orders **live total from `/api/orders`**, Support Tickets `0` (placeholder), Account Status **real** from `/api/auth/me`. |
| Hosting Plans | `#hosting` | Live `GET /api/plans/hosting`; each card CTA → `checkout.html?type=hosting&plan=<slug>` (“Select Plan”). |
| VPS Plans | `#vps` | Live `GET /api/plans/vps`; CTA → `checkout.html?type=vps&plan=<slug>`. |
| Account | `#account` | Read-only: first/last name, email, status, email verification, registration date. |
| Services | `#services` | Live `GET /api/services` — the caller's service instances (type, status badge, order number) with loading/error/empty states. A service appears here once provisioning has created it; an empty list never implies a hidden service. |
| Support | `#support` | Explicit **Coming soon** panel — no fake data, no pretend functionality. |
| Billing | `#billing` | Live `GET /api/payments` payment-attempt history (status badge, order number, amount, date, provider) with pagination and an empty state. Entries are attempts only — never proof of payment. |
| Orders | `#orders` | Live `GET /api/orders` with pagination (`page`, `limit` ≤ 50). Each row shows order number, product, plan, amount, friendly status badge (text, not color-only), and date. **Paid orders additionally show the matching service state** from the services API (pending / provisioning / active / failed / suspended / terminated); if the services fetch fails, no service claim is shown at all. Empty state when there are no orders. “View Order” opens `GET /api/orders/:id` detail for the signed-in owner (foreign/missing → identical safe `404`). |

Logout uses `POST /api/auth/logout` then returns to `login.html`.

Desktop shows a sticky sidebar; below ~992px the sidebar collapses behind a menu button (`aria-expanded`). Keyboard: skip link, focusable `main`, Escape closes the mobile menu.

## Checkout (order preparation + sandbox payment redirect)

`frontend/checkout.html` + `frontend/js/checkout.js`:

1. Reads `?type=` (`hosting` | `vps`) and `?plan=` (slug).
2. Validates type and slug client-side; always fetches the canonical plan from `/api/plans/:type/:slug`. **Canonical data comes only from the API** — query-string `?price=` / `?name=` are never used for display.
3. Requires sign-in (`GET /api/auth/me`); unauthenticated users get a Sign In CTA that returns to the same checkout URL.
4. **Place Order** posts `{ productType, planSlug }` only to `POST /api/orders` with a per-page `Idempotency-Key` header. The button is disabled during submit (double-submit guard).
5. On `201`/`200`, shows confirmation: order number, amount, status **Awaiting Payment**, plan, and a “Next step” notice.
6. **Payment handoff** posts `{ orderId }` only to `POST /api/payments`. With payments disabled (`PAYMENT_PROVIDER=disabled`, the default) the API answers `503 PAYMENT_PROVIDER_NOT_CONFIGURED` and the UI shows “Payment processing is not available yet.” — no fake success, no card form, no redirect. With the UddoktaPay gateway (`PAYMENT_PROVIDER=uddoktapay`), placing the order goes straight from order creation into the gateway hand-off: the confirmation panel and “Proceed to Payment” button are never shown (gateway-only providers hide both), one click produces a single browser redirect to the gateway host the server advertised via `GET /api/payments/provider`, and a failed hand-off can be retried without duplicates (the per-page `Idempotency-Key` returns the original order with `200`; a pending gateway session within its 30-minute TTL is reused). With the SSLCommerz sandbox enabled, a `201` returns `{ paymentId, gatewayUrl }` and the browser is redirected to the sandbox gateway (the confirmation panel is labeled “Sandbox checkout”); on return, `payment-success.html` / `payment-failed.html` / `payment-cancelled.html` load `payment-status.js`, which polls `GET /api/orders/:id` and shows a safe text status. The attempt is recorded and appears in dashboard **Billing**.

**It does not** collect card details, trust query-string prices, or mark orders paid. Canonical data comes only from the API. The browser also never follows a redirect to a host the server did not advertise: the client guard requires a verbatim match with the `gatewayHost` returned by `GET /api/payments/provider`, and a refused or failed hand-off shows a truthful message on the form — never a success card.

## Orders API

All routes require an authenticated session (`fh_session`). Responses use `{success:true,data}` / `{success:false,error:{code,message[,details]}}`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/orders` | Create an order (`201`; `200` when an existing Idempotency-Key is reused) |
| `GET` | `/api/orders?page=&limit=` | List the caller's orders, newest first (`limit` max `50`) |
| `GET` | `/api/orders/:id` | One order owned by the caller (`404 ORDER_NOT_FOUND` if missing or owned by someone else) |

### POST /api/orders

**Body (strict — unexpected fields → `400`)**

```json
{
  "productType": "hosting",
  "planSlug": "starter"
}
```

- `productType`: `"hosting"` or `"vps"`.
- `planSlug`: lowercase slug (`^[a-z0-9]+(-[a-z0-9]+)*$`, max 100).
- Optional header `Idempotency-Key`: `^[A-Za-z0-9_-]{8,64}$`, unique per user — a repeat returns the original order (`200`) instead of creating a duplicate.

**Server-side price snapshot (transaction):** `BEGIN` → load active plan row (`price`, `currency`, `billing_cycle` from PostgreSQL) → insert order with `status = 'awaiting_payment'` and a generated `FLR-YYYYMMDD-XXXXXX` order number (DB UNIQUE is the collision guarantee) → `COMMIT` / `ROLLBACK` on failure. Client-supplied amount/currency/userId/status are never accepted.

**Success (`201`)**

```json
{
  "success": true,
  "data": {
    "id": "…uuid…",
    "orderNumber": "FLR-20260923-A1B2C3",
    "productType": "hosting",
    "plan": { "id": "…uuid…", "name": "Starter", "slug": "starter" },
    "amount": "299.00",
    "currency": "BDT",
    "billingCycle": "monthly",
    "status": "awaiting_payment",
    "createdAt": "2026-09-23T…Z"
  }
}
```

**Errors**

| Case | Status | Code |
|---|---|---|
| Not signed in | `401` | `UNAUTHORIZED` |
| Invalid/missing/extra body fields | `400` | `VALIDATION_ERROR` |
| Invalid `Idempotency-Key` | `400` | `VALIDATION_ERROR` |
| Plan missing or not active | `404` | `PLAN_NOT_FOUND` |
| Cross-origin `Origin` header on POST | `403` | `CSRF_INVALID` |
| Too many creates (`ORDER_RATE_LIMIT_MAX`) | `429` | `RATE_LIMITED` |

### GET /api/orders

Query: `page` (≥ 1, default 1), `limit` (1–50, default 10). Unknown query parameters → `400`.

```json
{
  "success": true,
  "data": {
    "orders": [ /* newest first, same shape as create */ ],
    "pagination": { "page": 1, "limit": 10, "total": 3, "totalPages": 1 }
  }
}
```

### Lifecycle & payment boundary

- New orders always start as **`awaiting_payment`**.
- Allowed statuses in the schema: `pending`, `awaiting_payment`, `paid`, `cancelled`, `refunded`, `failed`.
- There is **no** `POST /api/orders/:id/pay` (or any other client-controlled paid mechanism). Status can never become `paid` without a verified server-side payment validation (see [Payment Architecture](#payment-architecture-foundation--sslcommerz-sandbox) below).
- **Order creation does not process payment or provision services.**
- Without an `Idempotency-Key`, two identical POSTs create two orders; the frontend prevents double-submit by disabling the button, and when a key is supplied the backend deduplicates per user.

## Payment Architecture (foundation + SSLCommerz sandbox)

> **Live/production payments are not enabled.** The default remains `PAYMENT_PROVIDER=disabled`. An SSLCommerz **sandbox** integration is implemented below and activates only with `PAYMENT_PROVIDER=sslcommerz` + sandbox credentials (the provider refuses missing credentials and any non-`sandbox` mode). Payment success can only ever come from a verified server-to-server Order Validation result — never from the browser, a query string, or any client-supplied field. A UddoktaPay gateway adapter (see [UddoktaPay gateway handoff](#uddoktapay-gateway-handoff)) provides the browser hand-off to a configured gateway host only — paid state still requires server-side gateway verification.

### Transaction model

- Every payment attempt lives in `payment_transactions` (migration `010_create_payment_transactions.sql`).
- **One order → many payment attempts; at most one verified successful payment per order** (partial unique index `payment_transactions_one_success_per_order`).
- `amount` / `currency` are copied from the **order row** at attempt creation — never accepted from the client.
- Payment statuses (schema CHECK): `initiated`, `pending`, `successful`, `failed`, `cancelled`, `expired`, `refunded`.
- No card numbers, CVVs, passwords, tokens, or provider secrets are ever stored — only ids, amounts, status timestamps, and a minimal `metadata` JSONB that is never populated with secrets.
- Webhook idempotency is enforced by the partial unique index on `(provider, provider_transaction_id)`.
- Provider detail columns (migration `011_add_payment_provider_details.sql`): `provider_session_key`, `validation_id`, `bank_transaction_id` — sandbox identifiers for audit/reconciliation, never secrets.

### Provider abstraction

```
backend/src/services/payments/
├── paymentProvider.js          # base class, PaymentProviderError, registry (getProvider)
├── paymentService.js           # create/list/get + gateway-session TTL reuse + internal markOrderPaidFromVerifiedPayment
├── sslcommerzService.js        # SSLCommerz callback/IPN/validation orchestration
├── uddoktapayService.js        # UddoktaPay gateway re-verification orchestration
└── providers/
    ├── disabledProvider.js     # default provider — rejects everything
    ├── sslcommerzClient.js     # sandbox HTTP client (timeouts, safe errors, TLS verify on)
    ├── sslcommerzProvider.js   # session + Order Validation API adapter, gateway-URL allowlist
    ├── uddoktapayClient.js     # gateway HTTP client (timeouts, safe errors, TLS verify on)
    └── uddoktapayProvider.js   # gateway session adapter, trusted-host allowlist + advertised gatewayHost
backend/src/controllers/sslcommerzController.js   # browser 302 redirects + IPN responses
backend/src/controllers/paymentController.js      # POST/GET /api/payments + GET /api/payments/provider
backend/src/controllers/uddoktapayController.js   # gateway return callbacks (success/fail/cancel)
```

Every provider implements the same interface:

| Method | Purpose |
|---|---|
| `createPayment({ payment, order })` | Start a payment for an already-recorded attempt |
| `verifyPayment(…)` | Verify payment facts against provider data |
| `handleWebhook({ headers, body })` | Verify signature → look up payment → return verified facts |

The active provider is selected by `PAYMENT_PROVIDER` (default `disabled`). The disabled provider throws `503 PAYMENT_PROVIDER_NOT_CONFIGURED` from **all three** operations, so nothing can be initiated, verified, or marked paid through it. Setting `PAYMENT_PROVIDER=sslcommerz` registers the sandbox adapter described below; `PAYMENT_PROVIDER=uddoktapay` registers the gateway hand-off adapter described below.

### Endpoints

| Method | Path | Guards | Description |
|---|---|---|---|
| `POST` | `/api/payments` | session + same-origin + rate limit + strict body | Body `{ orderId }` only. Verifies ownership and `awaiting_payment`, records an `initiated` attempt with the order's amount/currency, then calls the provider. Disabled → `503 PAYMENT_PROVIDER_NOT_CONFIGURED`; sandbox success → `201 { paymentId, gatewayUrl }`; gateway/session problems → `502 PAYMENT_PROVIDER_ERROR` (attempt stays `initiated`). |
| `GET` | `/api/payments/provider` | none (public, read-only) | Provider discovery for the checkout client: `{ provider }` plus `gatewayHost` (host-only string derived from server config) when a gateway is configured. Never exposes keys, configuration, or full gateway URLs. Registered before `GET /:id` so `provider` is never read as a payment id. |
| `GET` | `/api/payments?page=&limit=` | session | The caller's attempts, newest first (`limit` max 50; unknown query params → `400`). |
| `GET` | `/api/payments/:id` | session | One attempt owned by the caller — foreign, missing, or invalid id → **identical** safe `404 PAYMENT_NOT_FOUND`. |
| `POST` | `/api/payments/webhook/:provider` | provider signature (future) | External webhook — no session, no CSRF. Unknown/invalid provider → `404`; the disabled provider → `503` **before any DB write**, so this endpoint can never mark an order paid while payments are disabled. |
| `GET\|POST` | `/api/payments/sslcommerz/success` | callback rate limit only | Browser return from the gateway. Requires `val_id` → server-side Order Validation API; VALID + `tran_id`/`value_a`/amount/currency match → payment `successful` + order `paid` (atomic, idempotent); then `302` to `payment-success.html`, or `payment-failed.html` on any shaped failure (no state change). |
| `GET\|POST` | `/api/payments/sslcommerz/fail` | callback rate limit only | Failure-direction only (`failed`) keyed by the pattern-checked `tran_id`. `302` → `payment-failed.html`. Never marks paid; never downgrades `successful`. |
| `GET\|POST` | `/api/payments/sslcommerz/cancel` | callback rate limit only | Failure-direction only (`cancelled`). `302` → `payment-cancelled.html`. |
| `GET\|POST` | `/api/payments/sslcommerz/ipn` | callback rate limit only | Server-to-server IPN. A VALID `val_id` can mark the order paid with no browser return; always answers HTTP `200 {success:true,data:{received:true}}` — valid, invalid, disabled, and internal outcomes are never distinguished. |

Callback routes carry **no session and no CSRF** — the Order Validation API (`val_id`, fetched server-side) is the trust boundary. They are only loose-rate-limited (`sslcommerz-callback`, `PAYMENT_CALLBACK_RATE_LIMIT_*`).

**Safe payment payload:** `id`, `orderId`, `orderNumber`, `provider`, `amount`, `currency`, `status`, `initiatedAt`, `paidAt`, `createdAt`. Never exposed: `user_id`, `provider_transaction_id`, `provider_session_key`, `validation_id`, `bank_transaction_id`, `payment_method`, `metadata`, `failed_at`.

**Errors:** `401 UNAUTHORIZED` · `400 VALIDATION_ERROR` (bad/extra fields) · `400 PAYMENT_VERIFICATION_FAILED` · `403 CSRF_INVALID` · `404 ORDER_NOT_FOUND` / `PAYMENT_NOT_FOUND` / `NOT_FOUND` (webhook) · `409 ORDER_NOT_PAYABLE` (order not `awaiting_payment` on create) / `ORDER_ALREADY_PAID` (internal verified path; converted to a success redirect on the browser callback) · `429 RATE_LIMITED` · `502 PAYMENT_PROVIDER_ERROR` (safe generic message — never upstream body/details) · `503 PAYMENT_PROVIDER_NOT_CONFIGURED`.

### SSLCommerz sandbox flow

Enabled only when `PAYMENT_PROVIDER=sslcommerz` **and** sandbox credentials are present (`SSLCOMMERZ_STORE_ID` / `SSLCOMMERZ_STORE_PASSWORD` from `.env`, placeholders in `.env.example`). The provider refuses missing credentials and any non-`sandbox` `SSLCOMMERZ_MODE` with `503`, so live/production payments can never be executed by this codebase.

**Initiation (`POST /api/payments`)**

- Records the attempt, fetches the customer name/email server-side, then asks the gateway for a session with `tran_id = "FLR" + 27 hex chars` (the payment UUID without dashes, 30 chars max) and `value_a = order.id`. The `tran_id` is stored as the payment's `provider_transaction_id` immediately.
- Success/fail/cancel/IPN callback URLs are built **only** from `APP_PUBLIC_URL` + the API prefix — never from `Host`, `Origin`, `Referer`, or `X-Forwarded-Host` (host-spoofing is covered by tests).
- Returns `201 { paymentId, gatewayUrl }`. The frontend redirects the browser to `gatewayUrl` — but only after an allowlist check: HTTPS on `*.sslcommerz.com`, or exactly the configured sandbox base URL host (a local HTTP mock matches only when it equals the configured base URL). Anything else → `502` and **no redirect**.
- Session API problems (connect/request timeout — defaults 10s/15s, non-JSON, >64KB, non-`SUCCESS` status) → `502 PAYMENT_PROVIDER_ERROR` with a generic message; the attempt stays `initiated`. TLS verification is never disabled; upstream error bodies are never echoed to clients.

**Callbacks (trust boundary = Order Validation API)**

- No session, no CSRF, no client secrets on any callback route. Payment truth comes only from the server-to-server Order Validation API (`val_id`) — never from query/body fields supplied by the browser.
- **Success:** requires `val_id`. Validation must be `VALID`, `tran_id` must equal the callback's `tran_id`, `value_a` must equal the payment's order id, and amount/currency must match the order row — only then does `markOrderPaidFromVerifiedPayment` run in one transaction (`BEGIN → lock payment → lock order → verify → payment successful → order paid → COMMIT`). Idempotent on verified replay (re-validation returns the same outcome without double-paying); the DB partial unique index allows at most one `successful` payment per order; a second verified attempt on an already-paid order converts `ORDER_ALREADY_PAID` into a success redirect.
- **Fail / cancel:** failure-direction only (`failed` / `cancelled`), keyed by the unguessable `tran_id`, which must match `^FLR[0-9a-f]{27}$` **before any DB lookup** — hostile values (including SQL-injection attempts) are rejected with a safe shaped error and no state change. These routes can never mark an order paid and can never downgrade a `successful` payment (`markTerminal` only transitions `initiated`/`pending`).
- **IPN:** always HTTP `200` with a uniform body whether the event was valid, invalid, disabled-provider, or internal — outcomes are never distinguished to the IPN caller (failures are swallowed server-side). A VALID `val_id` IPN can mark the order paid with no browser return; status-only IPNs (`FAILED`/`CANCELLED`/`EXPIRED`) only move attempts in the failure direction.
- **Disabled guard:** while `PAYMENT_PROVIDER` is not `sslcommerz`, initiation answers `503` and browser callbacks make no state change (the customer lands on the failed/cancelled result page); IPN still answers `200`. Callbacks can never mark an order paid on a disabled deployment.
- **Browser redirects:** verified-paid → `payment-success.html`; anything else → `payment-failed.html` / `payment-cancelled.html`. Result pages read only `GET /api/orders/:id` (signed-in owner; foreign/missing → safe generic message), render text status (success / still-verifying / not-found), and contain **no inline scripts** (CSP-compatible; `payment-status.js` is external).
- `risk_level` / `risk_flag` from validation are stored in the payment `metadata` for review — `risk_level = 1` should be held for manual review (there is no automatic provisioning in this project).

**Security notes**

- Store credentials live only in `.env` — placeholders in `.env.example`, never committed, never logged, never returned by any API (suite scans responses and logs).
- No blind retries of money-moving operations; every transition is idempotent on verified replay and double-enforced by the one-success-per-order index.
- `tran_id` pattern enforcement, `value_a` order-id cross-check, and amount/currency verification all happen server-side before any state transition.
- **Localhost limitation:** SSLCommerz servers cannot deliver IPN to `localhost`. Set `APP_PUBLIC_URL` to an externally reachable `https` URL in staging/production. Browser return redirects work locally, but treat the Order Validation API / IPN as required for paid state — a browser redirect alone can never confirm payment.

**Docs:** [SSLCommerz developer docs (v4)](https://developer.sslcommerz.com/doc/v4/) · [Sandbox account registration](https://developer.sslcommerz.com/registration/)

### UddoktaPay gateway handoff

Enabled when `PAYMENT_PROVIDER=uddoktapay` **and** `UDDOKTAPAY_API_URL` / `UDDOKTAPAY_API_KEY` are present (the provider refuses missing configuration). The adapter hands the browser to a configured gateway and back — it can never mark anything paid by itself.

**Initiation (`POST /api/payments`)**

- Records an `initiated` attempt, then asks the gateway for a session. Success → `201 { paymentId, gatewayUrl }`; the order stays `awaiting_payment`.
- **Server trust:** the gateway URL must be `https` on exactly the configured gateway host (`isTrustedPaymentUrl`) — anything else → `502 PAYMENT_PROVIDER_ERROR` and **no redirect**. Session API problems behave the same; the attempt stays `initiated`.
- **Client agreement (STEP 47):** the checkout page fetches `GET /api/payments/provider` at load and stores `window.__trustedGatewayHost` — the host-only string the server derives from its own configuration (`trustedGatewayHost()`), never a full URL, key, or secret. The browser navigates only when the target URL's host equals that string **verbatim** (after the vendor `https://*.uddoktapay.com` rule, before own-origin/loopback rules), so host-suffix tricks are refused. If the guard refuses, the form shows a truthful error and the page never navigates.
- **Session reuse:** a pending session within `GATEWAY_SESSION_TTL_MS` (30 min) is reused — same payment row, same gateway URL (a retry adds no rows); past the TTL the old session is marked `expired` and a fresh one is created with a new URL. Order retries reuse the per-page `Idempotency-Key` (`200` + original order), so a failed hand-off can be retried without duplicate orders.
- **Truthful errors:** `502 PAYMENT_PROVIDER_ERROR` → “We couldn't start the payment session. Please try again.”; expired session → “The payment session has expired. Please try again.”; `503` → “Payment processing is not available yet.”. Failures render on the form — never as a success card, and never with upstream response bodies.
- **Returns & verification:** the gateway returns the browser to `GET|POST /api/payments/uddoktapay/success|fail|cancel` (callback rate limit only — no session, no CSRF; callback URLs are built exclusively from `APP_PUBLIC_URL`). Payment truth comes only from the server-side Verify Payment API (`invoice_id`) invoked by the authenticated webhook (`RT-UDDOKTAPAY_API_KEY`) or the success return — the browser can never confirm payment, a redirect failure never marks paid, and admins can force re-verification (`POST /api/admin/payments/:id/verify-uddoktapay`).

### State transitions

```
order:   awaiting_payment ──(verified payment only)──► paid
payment: initiated → pending → successful | failed | cancelled | expired | refunded
```

- `POST /api/payments` **never** changes the order. With the disabled provider the order stays `awaiting_payment` and the attempt stays `initiated` (visible in dashboard Billing as an attempt, not a payment). With the sandbox enabled it returns `gatewayUrl`, but the order still stays `awaiting_payment` until validation.
- The **only** code path that can mark an order `paid` is the internal `markOrderPaidFromVerifiedPayment()` in `paymentService.js`:
  `BEGIN → lock payment row → lock order row → verify amount + currency (provider values vs DB rows) → mark payment successful → mark order paid → COMMIT`, rolling back on any failure. It is idempotent on verified replay and double-enforced by the one-success-per-order unique index. **It is not routed to any client-controllable HTTP endpoint** — the only HTTP paths that can reach it are (1) the SSLCommerz success callback / IPN after a server-side VALID Order Validation result, and (2) the TextBee incoming-SMS webhook **after** a parsed bKash payment SMS is matched and verified (only when `BKASH_PAYMENT_ENABLED=true`; with the disabled provider / flag off, nothing reaches it).
- There is no `POST /api/orders/:id/pay`, no `POST /api/payments/:id/confirm`, and no client-controlled field that can set a status to `paid` or `successful` (strict validation rejects unexpected fields with `400`).

### Webhook / validation requirements (any real provider)

These apply to any provider confirmation; the SSLCommerz sandbox satisfies them with its Order Validation API (`val_id`) instead of an HMAC signature:

1. Confirm the event against the provider's server-side API (or verify a signature/HMAC over the raw body using a server-side secret) — environment only, never committed.
2. Look up the payment server-side by the provider transaction/event id — never trust client-supplied order/status data. Idempotent via `(provider, provider_transaction_id)` unique index.
3. Verify **amount and currency** against the database order row before any transition.
4. Process each event at most once; a replay of an already-verified event must succeed without re-processing (replay-safe).
5. Commit the transaction before acknowledging the callback; unknown event types are acknowledged as no-ops (IPN always `200`).
6. Never treat a browser redirect or any client callback as proof of payment.

**Live/production payment processing is not enabled.** The SSLCommerz **sandbox** flow above is the only code that can confirm payment, it activates only when `PAYMENT_PROVIDER=sslcommerz` with sandbox credentials, and the provider refuses non-sandbox mode. The default remains `PAYMENT_PROVIDER=disabled`.

## SMS (TextBee gateway integration — infrastructure only)

> **SMS sending is not available unless configured.** The default is `SMS_PROVIDER=disabled`, which refuses every send with `503 SMS_PROVIDER_NOT_CONFIGURED`. No registration, login, password-reset, order, or payment flow sends SMS today — only the reusable service exists for future steps.

> **Incoming SMS is not trusted payment proof by itself.** The webhook below stores inbound messages for operator review. Without `BKASH_PAYMENT_ENABLED=true` it never marks an order paid and never touches `orders` / `payment_transactions` (stored reason `BKASH_DISABLED`). With the flag enabled (Step 17), a message that **exactly matches** the supported bKash format, has a unique TrxID, and matches exactly one `awaiting_payment` BDT order of the exact amount may be verified through `markOrderPaidFromVerifiedPayment()` — never through a raw `UPDATE orders SET status='paid'`. Ambiguous or unmatched messages are never auto-paid.

### Overview

A provider-abstracted SMS service (mirroring the payment provider architecture) that later steps will use for OTPs, account notifications, order notifications, and other transactional SMS. The application always calls `smsService.sendSms(...)` — never TextBee directly.

```
backend/src/services/sms/
├── smsService.js        # validation, E.164 enforcement, audit logging, rate limiter
├── smsProvider.js       # SmsProvider base, SmsError, registry (getProvider)
├── smsTemplates.js      # generic transactional templates — NOT wired to any workflow
├── textbeeWebhook.js    # incoming MESSAGE_RECEIVED: HMAC auth, validate, store (no payment state)
└── providers/
    ├── disabledSmsProvider.js   # default — honest 503, nothing sent
    └── textbeeProvider.js       # official TextBee REST API adapter
backend/src/models/smsMessageModel.js   # sms_messages audit rows (parameterized SQL)
backend/src/models/smsIncomingModel.js  # sms_incoming_events rows (masked list helpers)
backend/src/controllers/textbeeWebhookController.js
backend/src/routes/webhookRoutes.js     # POST /api/webhooks/textbee/sms
```

Interface: `sendSms({ recipients, message, deviceId?, simSubscriptionId?, userId?, messageType? })` and `getStatus()`. The service handles provider selection, strict input validation, error normalization, and audit logging — it contains no business/OTP logic.

### TextBee requirements

1. **Account:** create one at [textbee.dev](https://textbee.dev) and copy an API key from the [dashboard](https://app.textbee.dev/dashboard).
2. **Android device:** pair a phone with the TextBee app — the REST API relays through that phone (the TextBee app/dashboard owns device pairing; this app has no device UI).
3. **API key setup:** put it in `.env` only — `SMS_PROVIDER=textbee` + `TEXTBEE_API_KEY=...` (placeholders live in `.env.example`; never commit a real key).

The provider talks to the official REST API: `POST {TEXTBEE_BASE_URL}/gateway/send-sms` with the `x-api-key` header (see the [TextBee docs](https://textbee.dev/docs) and [API reference](https://textbee.dev/docs/api-reference)). It is implemented with direct `fetch` rather than `@textbee/sdk` because the SDK exposes no per-request timeout option and every outbound SMS request here must be bounded by `SMS_REQUEST_TIMEOUT_MS`.

### Phone numbers (strict E.164)

Recipients must be strict E.164: `+` then a first digit `1-9` then 6–14 more digits (7–15 total), e.g. `+8801712345678`. Local formats are **rejected, never guessed**: `01712345678`, `8801712345678`, `+880 1712345678`, `01712-345678` all fail with `400 VALIDATION_ERROR`. Max 10 recipients per call; max message length 1600 characters; messages must be non-empty strings with no null bytes and must never contain the API key.

### Security

- API key: environment only — never in source, frontend HTML/CSS/JS, localStorage, cookies, API responses, logs, or the database (test suites scan all of these).
- HTTPS required for non-local base URLs — the provider refuses to send the API key over plain `http` to a non-localhost host (local test mocks excepted).
- Every request: timeout (`SMS_REQUEST_TIMEOUT_MS`, default 10s), single attempt, **no automatic retries** (duplicate SMS are harmful), redirects not followed (the key is never re-sent elsewhere), 64KB response cap, TLS verification never disabled.
- Provider failures (HTTP 400/401/404/429/5xx, timeout, network, malformed body) collapse into one safe `502 SMS_PROVIDER_ERROR` — upstream bodies and the key are never echoed.
- **No public SMS endpoint.** There is no `POST /api/sms/send` — `/api/sms/*` answers `404`. Only future internal features call `smsService.sendSms()`; an abuse/spam API is intentionally impossible from the outside.
- `smsSendLimiter` (in-memory fixed window, `SMS_RATE_LIMIT_*`, default 10/15 min per IP) is exported for future internal endpoints to mount — nothing is mounted today.
- Audit table `sms_messages` (migration `012`) stores `recipient_hash` (SHA-256), never raw phone numbers; **no message body column** (no OTP/code plaintext), no credentials; provider ids + status timestamps only; all SQL parameterized.

### Incoming SMS webhook + bKash verification (Steps 16–17)

| Method | Path | Guards | Description |
|---|---|---|---|
| `POST` | `/api/webhooks/textbee/sms` | HMAC `X-Signature` over raw body + rate limit | TextBee server-to-server `MESSAGE_RECEIVED`. No session, no CSRF, no same-origin check — authenticity is the signature. Stores one row in `sms_incoming_events` (migration `015`, status vocabulary extended by `016`). Idempotent on `(provider, idempotency_key)` and `(provider, provider_message_id)`. When `BKASH_PAYMENT_ENABLED=true`, the stored message is then parsed/matched/verified (Step 17); when disabled (default), the row stays `received` and no payment code runs. |
| `GET` | `/api/admin/sms/incoming?page=&limit=` | admin session | Read-only list of stored inbound events. Sender masked (`***5678`); message truncated to a short preview; verification fields (`amount`, `transactionId`, `parseReason`, `verifyReason`, `orderNumber`, `candidateCount`) exposed; no full bodies, no secrets. |

- **Auth:** `HMAC-SHA256(rawBody, TEXTBEE_WEBHOOK_SECRET)` hex in `X-Signature`, timing-safe compare. Missing/empty secret → `503 SMS_PROVIDER_NOT_CONFIGURED`. Bad/missing signature → `401 WEBHOOK_UNAUTHORIZED`. Invalid payload → `400 VALIDATION_ERROR`.
- **Trusted device (optional, Step 21):** runs **only after** successful HMAC — never replaces it. If `TEXTBEE_DEVICE_ID` is non-empty, `payload.deviceId` must be present and exactly equal that value; otherwise (or on mismatch/missing) → `401 WEBHOOK_UNAUTHORIZED` with a generic message (expected id is never echoed). If `TEXTBEE_DEVICE_ID` is empty, deviceId is not enforced (legacy behavior).
- **Raw body:** captured only for this path in `express.json` `verify` so the signature matches TextBee’s exact bytes (not a re-serialized object).
- **Payload fields used:** `smsId`, `message`, `deviceId`, `webhookSubscriptionId`, `webhookEvent` (must be `MESSAGE_RECEIVED`), `idempotencyKey`, `sender`, `receivedAt`.
- **Secrets:** the webhook secret, API key, and configured device id are never returned in responses, never logged, never stored in the database.

### bKash SMS payment parser & auto-verification (Step 17 — OFF by default)

> **`BKASH_PAYMENT_ENABLED` defaults to `false`.** With the flag off (the committed default), the webhook stores the SMS with status `received` and persists `metadata.reason = 'BKASH_DISABLED'` (also returned as `verification.reason`) — no parse, no order lookup, no payment row, no order status change. `SMS_PROVIDER` also remains `disabled` unless configured. **No real TextBee/bKash payment SMS has ever been observed or verified.**

**Supported SMS format (regex-locked — no other layouts are parsed):**

```
You have received Tk 2,470.00 from 01917210879. Fee Tk 0.00. Balance Tk 2,633.06. TrxID DFD09UPC86 at 13/06/2026 12:10
```

| Field | Rule |
|---|---|
| Amount / fee / balance | Optional thousands commas; 0–2 decimal places. Normalized to integer cents (never IEEE floats). Zero **amount** → `INVALID_AMOUNT`. Zero fee/balance are valid. |
| Sender | Strict Bangladesh mobile `01[3-9]XXXXXXXX` (11 digits). |
| TrxID | ASCII alphanumeric, 4–50 chars. Unique per payment via `(provider, provider_transaction_id)`. |
| Timestamp | `dd/mm/yyyy HH:MM` with basic calendar range checks (display only — not trusted for money). |
| Everything else | Message must match the layout exactly; anything else → `parsed: false` / `UNSUPPORTED_FORMAT`. |

**Pipeline (`processBkashIncomingPayment`):**

1. Gate: `config.payments.bkash.enabled` — if false, record `metadata.reason = 'BKASH_DISABLED'` and leave status `received` (no payment code path).
2. Parse pure message → on failure, store `parseReason`, leave status `received`.
3. On success, mark SMS `parsed` (amount, TrxID, sender, fee recorded in metadata).
4. **Duplicate TrxID first:** existing payment row → amount mismatch → `rejected` / `TRX_AMOUNT_MISMATCH`; already `successful` → `verified` / `TRX_REPLAY` (idempotent); non-successful → `rejected` / `TRX_ALREADY_USED`.
5. Match orders: `status='awaiting_payment' AND currency='BDT' AND amount = $::numeric`. Zero matches → `rejected` / `NO_MATCHING_ORDER`. More than one → `ambiguous` / `AMBIGUOUS_AMOUNT` (**never guessed, never auto-paid**). Exactly one → create `payment_transactions` row with `provider_transaction_id` set at INSERT (unique index is the race/replay guard).
6. Call the existing trusted `markOrderPaidFromVerifiedPayment({ paymentId, amount, currency, providerTransactionId, … })`. **No raw `UPDATE orders SET status='paid'` exists anywhere under `services/sms` or the bKash services.**
7. Concurrent duplicate inserts: unique-violation (`23505`) is re-read — winner `successful` → `verified` / `TRX_REPLAY`; otherwise `rejected` / `TRX_ALREADY_USED`.
8. Transition failures (400/409) mark the orphan payment `failed` and the SMS `rejected` with a safe reason (`ORDER_ALREADY_PAID` / `ORDER_NOT_PAYABLE` / `VERIFICATION_FAILED`).

**SMS `status` vocabulary (migration `016`):** `received` → `unverified` | `parsed` → `matched` | `verified` | `rejected` | `ambiguous`. Admin list surfaces the matching verification metadata without secrets.

**Receiver number:** `BKASH_RECEIVER_NUMBER` is the payment SIM (server-side). It is optional metadata only; matching does not depend on it. It is never treated as the SMS sender and is never returned to clients as a secret.

### Timeouts, rate limiting, templates

- One controlled provider request per `sendSms()` — no retry loops; deliberate retry/idempotency can be added later if needed.
- `smsTemplates.js` provides generic transactional templates (`verificationCode`, `passwordReset`, `orderConfirmation`, `paymentNotification`, `serviceNotification`) — pure string builders, **not wired** to registration, auth, orders, or payments. No OTP generation exists yet.
- `getStatus()` is honest: it returns `{ supported: false, status: 'unknown' }` — acceptance is never claimed as delivery. Delivery/status webhooks remain future work; Steps 16–17 added only the **incoming** `MESSAGE_RECEIVED` store plus optional bKash parse/verify (gated by `BKASH_PAYMENT_ENABLED`, default off).

### Testing strategy & real SMS

`npm test` runs `test/sms.test.js` against a **local mock TextBee server** — no real account, key, device, or network. It covers: registry/disabled behavior, missing-key and non-HTTPS refusal, E.164 and message validation, endpoint/`x-api-key`/payload shape, optional `deviceId`/`simSubscriptionId`, 400/401/404/429/5xx/timeout/network/malformed/redirect handling, audit rows (hash-only schema, user FK), no-public-endpoint, log/frontend/source secret scans, SQL-injection attempts, templates hygiene, rate limiter, and auth/health regressions.

To try a **real** send: put real credentials in `.env` (`SMS_PROVIDER=textbee`, `TEXTBEE_API_KEY=...`), pair an Android device, and invoke `smsService.sendSms()` from a short local script with your own E.164 test number. Only claim delivery if TextBee actually accepted a real message — the automated suite never does this.

## Service Provisioning (architecture foundation)

> **No real provisioning happens.** The default is `PROVISIONING_PROVIDER=disabled`, which refuses every provisioning operation with `503 PROVISIONING_PROVIDER_NOT_CONFIGURED` **before any service-instance row is written** — a disabled deployment creates zero fake services. The `proxmox` / `whm` provider slots exist but their Step 12 implementations validate configuration and then refuse with `503 PROVISIONING_NOT_IMPLEMENTED` — no Proxmox/cPanel API call, no VM, no hosting account, no SSH key, no credentials anywhere. Payment success does **not** auto-provision: provisioning is only reachable through internal trusted code (`provisionOrder`), never through any HTTP endpoint.

### Overview

A provider-abstracted provisioning service (mirroring the payment/SMS provider architecture) that later steps will wire to real infrastructure. The application always calls `provisioningService` — never a provider directly.

```
backend/src/services/provisioning/
├── provisioningErrors.js        # ProvisioningError, error codes, transition matrix (canTransition)
├── provisioningProvider.js      # base class, ProvisioningProviderError, registry + test seam
├── provisioningService.js       # provisionOrder (idempotent) + suspend/unsuspend/terminate + list
├── serverSelectionService.js    # VPS server placement (first active server; null when none/disabled)
└── providers/
    ├── disabledProvisioningProvider.js  # default — honest 503, zero rows
    ├── proxmoxProvider.js               # placeholder — config check then NOT_IMPLEMENTED
    └── whmProvider.js                   # placeholder — config check then NOT_IMPLEMENTED
backend/src/models/serviceInstanceModel.js   # service_instances rows (parameterized SQL)
backend/src/controllers/serviceController.js # read-only GET /api/services
backend/src/routes/serviceRoutes.js
```

### Lifecycle & state machine

Reuses the existing `service_instances.status` column (migration `006`); migration `013_add_provisioning_details.sql` adds `provider`, lifecycle timestamps (`provisioned_at` / `suspended_at` / `terminated_at`), safe failure diagnostics (`failure_code` / `failure_message_safe`), and a **unique partial index on `order_id`** (one service instance per order — the idempotency guarantee).

```
(no row)  ── paid order + successful provision ──►  provisioning ──► active
                                                       │                │
                                                       ▼                ├─► suspended ──► active | terminated
                                                    failed              └─► terminated
                                                  (terminal)                (terminal)
```

- **“Pending” is the absence of a row** — order `paid`, provisioning has not created a service yet (no `pending` status exists in the schema).
- Transitions are enforced twice: in code (`canTransition` matrix in `provisioningErrors.js`) and in the database (guarded `UPDATE … WHERE status = <expected>`; zero rows → `409 PROVISIONING_INVALID_STATE`).
- `provisioning → active | failed` only after the provider call resolves; lifecycle ops (`suspend`/`unsuspend`/`terminate`) call the provider **first** — a provider failure means **no state change**.
- `failed` / `terminated` are terminal in Step 12 (retry/reconciliation is future work).

### provisionOrder(orderId) — internal trusted workflow

Never routed to HTTP. Order of operations:

1. Validate the order id (UUID) → load order (`404 PROVISIONING_ORDER_NOT_FOUND`; with an explicit `userId`, foreign/missing → **identical** 404, no existence leak).
2. Order must be `paid` (`409 PROVISIONING_ORDER_NOT_ELIGIBLE`) and `product_type` hosting/vps.
3. Plan row must exist and be `active` (`409 PROVISIONING_INVALID_PLAN`) — prices/resources come from the plan row, never the client.
4. **Idempotency:** an existing instance for this order returns `{ created: false, replayed: true }` — the provider is never re-called (the unique `order_id` index also converts a concurrent duplicate insert into the same replay).
5. Provider readiness **precheck** (`getStatus()`) **before any INSERT** — disabled/unconfigured → `503`, zero rows.
6. Build the payload from database rows only:
   - VPS: `{ serviceType, planId, planSlug, userId, orderId, resources: { cpu, ram, storage, bandwidth } }`
   - Hosting: `{ …, resources: { storage, bandwidth, databases, emailAccounts, domains } }`
7. VPS only: `selectServer()` — no active server → `503 PROVISIONING_CAPACITY_UNAVAILABLE`, zero rows (and when `PROVISIONING_PROVIDER=disabled` the selector returns `null` even if servers exist — no fake placement).
8. INSERT the `provisioning` row, then call `provider.provision(payload)` with **no open DB transaction**.
9. Success → `active` + `external_id` (provider resource id) + `provisioned_at`. Failure → `failed` + `failure_code`/`failure_message_safe`, and the normalized error is thrown. A later call for the same order replays the recorded `failed` row — no blind retry of the provider call.

**Provider failure normalization:** only *our* typed errors with authored messages (≤ 255 chars, `PROVISIONING_*` codes) are stored/returned. Raw exceptions (timeouts, connection resets, unexpected shapes) collapse into `502 PROVISIONING_PROVIDER_ERROR` with the fixed message `Provisioning failed. Please contact support.` — provider response bodies, URLs, hostnames, tokens, and stack details are never persisted, logged into columns, or returned.

### API surface (read-only)

| Method | Path | Guards | Description |
|---|---|---|---|
| `GET` | `/api/services?page=&limit=` | session + strict query validation | The caller's services, newest first (`limit` max 50; unknown query params → `400`). |

**Safe payload per service:** `id`, `orderId`, `orderNumber`, `serviceType`, `status`. Never exposed: `user_id`, `server_id`, `external_id`, `provider`, `hostname`, plan FKs, `failure_code`, `failure_message_safe`, timestamps beyond what is listed.

There is **no** `POST /api/provision`, `POST /api/services`, `POST /api/services/:id/suspend`, or any other HTTP trigger for provisioning or lifecycle changes — those paths answer `404`. Dashboard rendering uses text nodes only (`textContent`), never `innerHTML`, and paid-order service lines are omitted entirely if the services API fetch failed (no guessed states).

**Errors:** `401 UNAUTHORIZED` · `400 VALIDATION_ERROR` · `404 PROVISIONING_ORDER_NOT_FOUND` / `PROVISIONING_INSTANCE_NOT_FOUND` · `409 PROVISIONING_ORDER_NOT_ELIGIBLE` / `PROVISIONING_INVALID_PLAN` / `PROVISIONING_INVALID_STATE` · `503 PROVISIONING_PROVIDER_NOT_CONFIGURED` / `PROVISIONING_NOT_IMPLEMENTED` / `PROVISIONING_CAPACITY_UNAVAILABLE` · `502 PROVISIONING_PROVIDER_ERROR` · `501 PROVISIONING_PROVIDER_UNSUPPORTED`.

### Security model

- Provider credentials (`PROXMOX_*`, `WHM_*`) live only in the server environment — never in source, the database, logs, API responses, or frontend files (suite scans all of them). The database stores only the provider *name* and a failure diagnostic authored by us.
- Proxmox/WHM configuration must be `https:` — plain `http` endpoints are treated as unconfigured (credentials are never sent in cleartext), and future HTTP calls must pin to the server-side URL only (no client-controlled endpoints — SSRF guard).
- Hostname/resource values flow through parameterized SQL only; hostile order/instance ids are rejected by UUID validation before any query.
- Server selection is intentionally simple today (first `active` server). It is the documented extension point for future capacity-aware placement: available CPU/RAM/storage/bandwidth, node health, maintenance/drain state, and fair distribution — none of which the schema tracks yet.

### Known limitations (documented, intentional)

- **Payment ≠ active service.** Paying an order does not auto-provision; there is no background job or reconciliation loop yet — an operator (or a later step) invokes the internal workflow.
- No real Proxmox/WHM calls, no SSH, no generated hosting/VPS credentials, no control-panel integration, no SMS notifications for service events, no invoices/subscriptions, no admin service CRUD, no retry of `failed` services.
- `selectServer` has no load balancing or capacity scoring (no capacity metrics exist in the schema).
- Admin surface is **read-mostly** for operations: dashboard metrics + order list/detail exist; STEP 48 adds customer account controls (suspend/reactivate with session revocation, one-time Argon2id password reset) and per-customer order/payment history. Admin CRUD (create/update/delete customers, plans, orders, services), refunds, order status mutations, role changes, and provisioning triggers do not.

## Frontend JavaScript structure

```
frontend/js/
├── main.js           # public header nav, accordion, year
├── auth.js           # login/register forms + safe ?return= redirect
├── plans.js          # catalog fetch helpers (window.FlareCatalog) + public plan pages
├── dashboard.js      # auth gate, sections, plan cards, services list, orders list/detail, billing payments history
├── checkout.js       # plan preview, place order (POST /api/orders), provider discovery (GET /api/payments/provider), payment handoff (POST /api/payments → verbatim trusted-host redirect; single-click auto-redirect when the provider is gateway-only, truthful form errors, idempotent retry)
└── payment-status.js # payment result pages: UUID-guarded ?order= + poll GET /api/orders/:id, safe text status

frontend/admin/js/
├── admin-auth.js        # shared FlareAdmin namespace (apiRequest, messages, admin gate, shell)
├── admin-dashboard.js   # metrics + recent orders + health poll
├── admin-orders.js      # order list filters/search/pagination (URL state)
├── admin-order-detail.js# read-only order detail (order, customer, service, payments)
├── admin-customers.js   # customer list filters/search/pagination (URL state)
└── admin-customer-detail.js # customer profile + summary + account controls + order/payment history
```

All scripts are external files (`script-src 'self'`); no CSP change was required. The payment result pages (`payment-success.html`, `payment-failed.html`, `payment-cancelled.html`) share `payment-status.js` and contain no inline scripts.

## Admin panel (foundation + dashboard/orders)

Secure admin surface built on the existing `users.role` column (`customer` | `admin`). No separate admin users table, no auto-promotion API. All authorization is server-side (`requireAdmin`); the browser only mirrors what the API already allows.

### Clean URLs (canonical)

| Path | Behavior |
|---|---|
| `/admin` | `301` → `/admin/dashboard` |
| `/admin/login` | Admin sign-in page (`frontend/admin/login.html`) |
| `/admin/dashboard` | Admin dashboard overview (`frontend/admin/dashboard.html`) |
| `/admin/orders` | Admin order management list (`frontend/admin/orders.html`) |
| `/admin/orders/:uuid` | Admin order detail (`frontend/admin/order-detail.html`, UUID validated before `sendFile`) |
| `/admin/customers` | Admin customer list (`frontend/admin/customers.html`) |
| `/admin/customers/:uuid` | Admin customer detail (`frontend/admin/customer-detail.html`, UUID validated before `sendFile`) |
| `/admin/index.html` · `/admin/login.html` · `/admin/dashboard.html` · `/admin/orders.html` · `/admin/customers.html` | `301` → matching clean path |
| `/admin/`, `/admin/login/`, `/admin/dashboard/`, `/admin/orders/`, `/admin/customers/` | `301` → trailing-slash-free path |

Legacy empty `admin/` folder at the repo root is **not** served. Assets are `/admin/css/admin.css` and `/admin/js/*` (static, never redirected).

### API

| Method | Path | Guards | Description |
|---|---|---|---|
| `GET` | `/api/admin/me` | `requireAdmin` + same-origin + no body | Safe admin identity `{ id, email, firstName, lastName, role, status, … }` — never `password_hash` / session material |
| `GET` | `/api/admin/health` | `requireAdmin` + same-origin + no body | Minimal `{ status: 'ok', timestamp, role: 'admin' }` — no env, DB, or secrets |
| `GET` | `/api/admin/dashboard` | same as above | Aggregate metrics only: `{ customers, orders, awaitingPayment, paid, failedOrders, activeServices, provisioningServices, failedServices }` — all non-negative integers from a single query |
| `GET` | `/api/admin/orders?page=&limit=&status=&productType=&search=` | same as above | Paginated order list joined with customer + plan. `limit` default 20, **max 50**. Whitelisted `status` (`pending\|awaiting_payment\|paid\|cancelled\|refunded\|failed`) and `productType` (`hosting\|vps`). `search` ≤ 100 chars, ILIKE on `order_number` or customer email (LIKE-escaped). Unexpected query params → `400`. Ordering: `created_at DESC, id DESC` |
| `GET` | `/api/admin/orders/:id` | same as above | Read-only detail: order + customer (safe fields) + latest service + payment attempts with **safe projection only** (`provider`, `providerTransactionId`, `status`, `amount`, `currency`, `paymentMethod`, timestamps — never `metadata` or credentials). Invalid UUID → `400`; unknown → `404` |
| `GET` | `/api/admin/customers?page=&limit=&status=&search=` | same as above | Paginated customer list. `limit` default 20, **max 50**. Whitelisted `status` (`active\|suspended\|pending`). `search` ≤ 100 chars, ILIKE on email, `TRIM(CONCAT_WS(' ', first_name, last_name))`, or the raw customer id (LIKE-escaped). Includes lateral order/service counts and `latestOrderAt`. Unexpected query params → `400`. Ordering: `created_at DESC, id DESC` |
| `GET` | `/api/admin/customers/:id` | same as above | Read-only detail: safe profile + summary `{ orders, paidOrders, services }` + up to 10 recent orders + up to 10 recent services. Never exposes `password_hash`, session material, `external_id`, `hostname`, or payment `metadata`. Invalid UUID → `400`; unknown → `404` |
| `GET` | `/api/admin/customers/:id/orders?page=&limit=&status=&search=` | same as above | Complete, paginated order history for one customer. `limit` default 20, **max 50**. Whitelisted order `status`; `search` ≤ 100 chars on order number (LIKE-escaped). Each row carries plan name (per product type) and `paymentStatus` (latest attempt). Unexpected query params → `400`. Ordering: `created_at DESC, id DESC` |
| `GET` | `/api/admin/customers/:id/payments?page=&limit=` | same as above | That customer's payment history only, paginated (`limit` default 20, **max 50**). Safe projection with `verificationSource` extracted server-side from `metadata->>'verification_source'` — the raw `metadata` row never leaves the database. Manual rows expose `rawStatus` plus an aliased `status` (`pending` → `awaiting_verification`, `successful` → `verified`, `failed` → `rejected`). Unexpected query params → `400`. Ordering: `created_at DESC, id DESC` |
| `POST` | `/api/admin/customers/:id/suspend` | `requireAdmin` + same-origin + empty JSON body `{}` | Sets `status='suspended'` and revokes **all** of the target's sessions in the same request. Idempotent. Refuses self (`403 ADMIN_SELF_ACTION`) and the last active administrator (`403 LAST_ADMIN_PROTECTED`). Never deletes or mutates user/order/payment rows. Invalid UUID → `400`; unknown → `404`; unexpected body fields → `400` |
| `POST` | `/api/admin/customers/:id/reactivate` | same as above | Sets `status='active'`. Revokes nothing, creates nothing, touches no other row — safe on an already-active account (returns `sessionsRevoked: 0`) |
| `POST` | `/api/admin/customers/:id/reset-password` | same as above | Customer accounts only: generates a 16-char one-time temporary password (`crypto.randomBytes`), stores **only** its Argon2id hash through the existing password architecture, revokes every session of the target, and returns the temporary password exactly once with a `notice` (never logged, not retrievable again). Administrator targets (including yourself) → `403 PASSWORD_RESET_NOT_ALLOWED` |
| `GET` | `/api/admin/sms/incoming?page=&limit=` | same as above | Read-only inbound TextBee events (Step 16). `limit` default 20, **max 50**. Sender masked (`***5678`); message truncated to a short preview (never full bodies). Unexpected query params → `400`. Ordering: `created_at DESC, id DESC` |

`requireAdmin` (`backend/src/middleware/admin.js`): missing/invalid session → `401 UNAUTHORIZED`; non-active → `403 ACCOUNT_DISABLED`; authenticated non-admin → `403 FORBIDDEN`. Unexpected methods on the read paths → `404` (the only mutations on `/api/admin/customers/:id` are the three account-control `POST`s listed above; any other body field on them → `400`). JSON body on GET → `400 VALIDATION_ERROR`. Cross-origin `Origin` → `403 CSRF_INVALID` (shared `requireSameOrigin` in `backend/src/middleware/csrf.js`, also used by auth and order routes).

### Role model & promotion (SQL procedure)

- Registration always inserts `role = 'customer'`; `POST /api/auth/register` rejects unexpected fields including `role`.
- Promote an existing active account **only** via an operator-run SQL statement (never through a public API):

```sql
-- Promote one account to admin (idempotent for that email)
UPDATE users
SET role = 'admin', updated_at = now()
WHERE lower(email) = 'admin@example.com'
  AND status = 'active';

-- Demote back to customer
UPDATE users
SET role = 'customer', updated_at = now()
WHERE lower(email) = 'admin@example.com';
```

- Migration `014_harden_admin_role.sql` re-asserts the default + CHECK and promotes nobody.

### Security notes

- Admin pages are `noindex, nofollow`; CSP-compliant (external scripts/styles only, no inline handlers).
- Admin login uses the existing customer session cookie (`fh_session`) + `POST /api/auth/login`, then gates on `GET /api/admin/me`. A customer who logs in on `/admin/login` is signed back out with an explicit “not administrator” message.
- No secrets in admin HTML/JS or API responses; identity and rows render via `textContent` (never `innerHTML`).
- Order list/detail, customer list/detail, and dashboard metrics are **read-only**; STEP 48 adds three confirm-guarded customer account controls (suspend + session revocation, reactivate, one-time password reset — self-suspend and admin targets refused server-side). Still absent from the admin surface: create/edit/delete customer, role change, refund, order status change, or provisioning HTTP trigger.
- Payment/SSLCommerz/callback logic is untouched by the admin surface.
- Dashboard metrics and order queries are parameterized SQL; status/productType are whitelisted before they reach the database; search input is LIKE-escaped.

### Frontend structure

```
frontend/admin/
├── index.html           # meta-refresh → /admin/dashboard (not a canonical URL)
├── login.html           # /admin/login
├── dashboard.html       # /admin/dashboard — 8 metric cards + recent orders
├── orders.html          # /admin/orders — filters, table, pagination
├── order-detail.html    # /admin/orders/:id — order/customer/service/payments
├── customers.html       # /admin/customers — status/search, table, pagination
├── customer-detail.html # /admin/customers/:id — profile, summary, recent orders/services
├── css/admin.css        # dark admin shell (responsive; orders/customers tables → cards <768px)
└── js/
    ├── admin-auth.js         # FlareAdmin namespace + shared shell (gate, identity, logout, menu)
    ├── admin-dashboard.js    # metrics + recent orders + health poll
    ├── admin-orders.js       # list state in URL (?page=&limit=&status=&productType=&search=)
    ├── admin-order-detail.js # UUID from pathname → safe detail render
    ├── admin-customers.js    # list state in URL (?page=&limit=&status=&search=)
    └── admin-customer-detail.js # UUID from pathname → profile/summary/recent orders+services
```

Sidebar includes Dashboard, Orders, and Customers as live links; Payments / Services / Hosting / VPS / Minecraft / Support / Settings appear as disabled placeholders (no fake routes).

## Testing

```bash
cd backend
npm test          # 25 suites — auth, auth-nav, plans, dashboard, orders, payments, sslcommerz, uddoktapay, sms, textbee-webhook, bkash-payment, provisioning, admin, admin-orders, admin-customers, clean-urls, bkash-instructions, manual-payment, admin-products, step46-purchase-gate, step47-purchase, step47-verify, step47-admin, step48-customers, step47-regression (546 tests)
```

Tests require a reachable PostgreSQL (set `DATABASE_*` in `.env`, or export `DATABASE_PORT=5433` to use a local test cluster) and a running API on the **client test port** (`TEST_BASE_URL=http://127.0.0.1:5056` — see "Client environment"; never `5055`, which serves the inherited FLARE harness). They apply pending migrations on startup, then exercise health, registration, login, session, CSRF, rate-limit middleware, public plan catalog (list/lookup/404/400/idempotent seed), dashboard/checkout (auth gate, plan selection, invalid input), the orders suite (auth, create snapshots, validation, idempotency, ownership 404, pagination, no pay endpoint), the payments suite (schema constraints, disabled-provider `503`, attempt recording, ownership-safe list/detail, webhook cannot mark paid, internal paid-transition verification/idempotency, frontend regressions), the SSLCommerz suite (see below), the SMS suite (see below), the **textbee-webhook suite** (see below), the **bkash-payment suite** (see below), the provisioning suite (see below), the admin suite (role schema, 401/403 authz, GET-only/body/CSRF, clean admin URLs, CSP markup, no auto-promote), the **admin-orders suite** (dashboard metrics authz + numeric shape + no secret leaks; order list pagination/limit-cap/filters/search/deterministic ordering; order detail 200/400/404/403 + safe payment projection; clean order UI routes + CSP; app.js route registration; migration count now **18**), the **admin-customers suite** (customer list authz/validation/pagination/search/LIKE-escape; detail 200/400/404/403 with no password/session/external_id leaks; clean customer UI routes + CSP; no mutation endpoints/UI; migration count now **18**), the **uddoktapay suite** (provider-discovery contract for `GET /api/payments/provider`, server/client trusted gateway-host agreement, host-suffix-trick refusal, session reuse in and out of the TTL, secret/URL leak scans), the **bkash-instructions / manual-payment / admin-products suites**, the **step46-purchase-gate / step47-purchase / step47-verify / step47-admin suites** (purchase gate, live hand-off, payment verification, admin payment surface), the **step48-customers suite** (account controls + order history), the **step47-regression suite** (13 live hand-off regression tests — gatewayHost advertisement, client-guard agreement, single-button flow, truthful error copy, idempotent retry, session TTL refresh), and clean-URL regressions. Rate limits are **never raised** for this project: the committed defaults (`REGISTER_RATE_LIMIT_MAX=10`/hour, `LOGIN_RATE_LIMIT_MAX=10`/15 min) stay exactly as they are and the app's limits are never loosened. `test/_hooks.cjs` (loaded by `npm test`) clears in-memory limiter counters before every test — on the test server through the `NODE_ENV=test`-only, loopback-only `POST /api/_test/reset-rate-limits` hook, and in-process for limiters the test files create themselves — so tests never wait out a window and never share throttling state. Every `429` assertion still drives the real limiter (auth/order/payment/sms suites verify pass → threshold → `429` + `Retry-After` → reset → next request passes again). Start the test server with `PAYMENT_PROVIDER=disabled` and `BKASH_PAYMENT_ENABLED=false` (the disabled-provider / bKash-off tests observe that state regardless of what the ambient `.env` enables for the dev server).

The `sslcommerz` suite runs in-process against a **mock sandbox gateway** (a local HTTP server posing as the session and Order Validation endpoints) — no live SSLCommerz account, real credentials, or external network calls are used. It covers migration 011 idempotency, session initiation shape and stored fields, callback URLs built only from `APP_PUBLIC_URL` (host-header spoofing), CSRF, VALID validation → paid (atomic, idempotent, metadata recorded), IPN-only success, amount/currency mismatch rejection, fail/cancel/downgrade protection, hostile `tran_id` handling, FAILED-validation failure direction, one-success-per-order on second attempts, session API failure → `502`, evil gateway URL → `502`, missing credentials / non-sandbox mode → `503`, no-auth/no-CSRF callbacks, disabled-provider behavior, store-password log/response scanning, and the frontend result pages.

The `sms` suite runs against a **local mock TextBee server** — no real TextBee account, API key, device, or network. It covers the provider registry and disabled-provider honesty, missing-key / non-HTTPS refusal, strict E.164 and message validation (no DB or HTTP on invalid input), `POST /gateway/send-sms` shape with `x-api-key`, optional `deviceId`/`simSubscriptionId` precedence, HTTP 400/401/404/429/500 + timeout + network + malformed + redirect → safe `502`, audit rows (`recipient_hash` only — no message body/phone/credentials columns), user FK linkage, absence of any public `/api/sms/*` endpoint, secret scans (logs, frontend, backend source), SQL-injection attempts, template hygiene, the `smsSendLimiter`, and auth/health/page regressions.

The `textbee-webhook` suite (Step 16) covers HMAC `X-Signature` verification (valid/invalid/missing/length-mismatch), HTTP validation (`400` bad JSON / missing fields / wrong `webhookEvent` / oversized / null byte), idempotent duplicate delivery (`200` + single row), response secret scans (API key + webhook secret never leak), **no order becomes paid** when bKash verification is off, `toPaymentCandidate` always `confidence: 'unknown'`, `SMS_PROVIDER=disabled` still refuses sends, missing secret → `503` (unit), migration count **18**, admin `GET /api/admin/sms/incoming` requires a session (401), mask helpers, and a source scan that no file under `services/sms/` issues a raw `UPDATE orders SET status='paid'`.

The `bkash-payment` suite (Step 17) covers the pure parser (exact sample SMS, comma-normalized integer cents, non-fixture phone/TrxID still parse, missing TrxID/amount/random/oversized/zero-amount rejection, never-throws on malformed input), `BKASH_PAYMENT_ENABLED` default-off no-op, exact-amount match → order `paid` + one `successful` payment row, wrong amount → `NO_MATCHING_ORDER` with order untouched, duplicate TrxID replay (idempotent, one payment, no second paid), same TrxID different amount → `TRX_AMOUNT_MISMATCH`, multiple matching orders → `ambiguous` / `AMBIGUOUS_AMOUNT` with **zero payments created**, cancelled and already-paid orders never pay, concurrent duplicate verification safe under the unique TrxID index, webhook with the flag off still stores SMS but does not pay, admin projection secret scan, migration count **18**, `016` status CHECK allows `ambiguous`, no raw `UPDATE orders SET status='paid'` under `services/sms`, and backend secret scans.

The `provisioning` suite runs in-process against a **mock provisioning provider** injected through the registry test seam — no Proxmox/cPanel account, credentials, VMs, or external network calls. It covers migration 013 (columns + unique `order_id` index, re-run no-op), provider registry and placeholder honesty (unconfigured → `NOT_CONFIGURED`, configured → `NOT_IMPLEMENTED`, plain-http URL refusal), disabled/unknown provider → `503` with **zero service rows**, eligibility (awaiting/cancelled orders, inactive/missing plans), ownership 404s with no existence leak, successful hosting/VPS provisioning (plan-derived payloads, server assignment, row audit fields), idempotent replay (one row, one provider call, failed rows never retried), the full lifecycle state machine (happy path + invalid transitions rejected with no provider call/DB change), provider failure normalization (shaped/raw/capacity/malformed results → safe stored diagnostics only), capacity exhaustion → `503` with zero rows and the disabled selector never placing, the read-only `GET /api/services` surface (401/400/exact keys/no internal fields), absence of any HTTP provisioning/lifecycle trigger, secret scans (backend + frontend), dashboard markup/JS hygiene (safe `textContent`, no `innerHTML`), and health/page regressions.

## npm Scripts

| Script | Purpose |
|---|---|
| `npm start` | Run the server (production) |
| `npm run dev` | Run the server with file watching |
| `npm run db:create` | Create the database if missing |
| `npm run db:check` | Verify database connectivity |
| `npm run db:migrate` | Apply pending SQL migrations |
| `npm run db:status` | List applied/pending migrations |
| `npm run db:seed` | Seed demo plan catalog (idempotent) |
| `npm test` | Run the automated test suite (25 suites: `auth` + `auth-nav` + `plans` + `dashboard` + `orders` + `payments` + `sslcommerz` + `uddoktapay` + `sms` + `textbee-webhook` + `bkash-payment` + `provisioning` + `admin` + `admin-orders` + `admin-customers` + `clean-urls` + `bkash-instructions` + `manual-payment` + `admin-products` + `step46-purchase-gate` + `step47-purchase` + `step47-verify` + `step47-admin` + `step48-customers` + `step47-regression` — 546 tests) |

## Not Yet Implemented (intentionally deferred)

- Email verification / password reset
- Live/production payment execution (SSLCommerz **sandbox** is implemented; the UddoktaPay **gateway hand-off** creates and redirects to gateway sessions only — a real payment is never executed by the test suite or verification probes, paid state still requires server-side gateway verification, live mode is refused, and `PAYMENT_PROVIDER` defaults to `disabled`)
- SMS-based flows (registration OTP, password-reset SMS, order/payment notification SMS) — the TextBee SMS **infrastructure** exists (`SMS_PROVIDER=disabled` by default) but nothing sends SMS yet. Incoming SMS storage (Step 16) and gated bKash auto-verification (Step 17, `BKASH_PAYMENT_ENABLED=false` by default) exist; with both at their committed defaults, inbound SMS is operator-review only and **not** wired to payment verification.
- Production-ready bKash auto-pay at scale: the Step 17 parser/verification path is implemented and unit-tested against the exact sample format, but **no real TextBee/bKash SMS has ever been delivered or verified**, the feature flag is off, and broader SMS layout coverage / operator approve-reject UI remain deferred.
- Invoices / subscriptions
- Real VPS / Proxmox integration (the `proxmox` provider slot exists but refuses with `PROVISIONING_NOT_IMPLEMENTED` until implemented)
- Real WHM / cPanel integration (the `whm` provider slot exists but refuses with `PROVISIONING_NOT_IMPLEMENTED` until implemented)
- Automatic provisioning after payment (provisioning is an internal workflow today — no job/reconciliation loop)
- Admin CRUD for plans and services (admin **read** surface exists: dashboard metrics, order list/detail, customer list/detail; plan/service management mutations and plan/service admin screens are not implemented — sidebar items beyond Dashboard/Orders/Customers are disabled placeholders). Customer management includes STEP 48 account controls (suspend/reactivate + one-time password reset) plus order/payment history; create/edit/delete-customer and role-change endpoints do not exist.
- Profile editing
- Support dashboard panel
