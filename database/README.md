# FLARE Hosting Database

PostgreSQL schema, migrations, and seed folder for the FLARE HostiNG platform.

## Structure

```
database/
├── migrations/          # Ordered, numbered SQL migrations (source of truth)
│   ├── 001_create_users.sql
│   ├── 002_create_hosting_plans.sql
│   ├── 003_create_vps_plans.sql
│   ├── 004_create_orders.sql
│   ├── 005_create_servers.sql
│   ├── 006_create_service_instances.sql
│   ├── 007_create_sessions.sql
│   ├── 008_add_plan_currency.sql
│   ├── 009_add_order_idempotency.sql
│   ├── 010_create_payment_transactions.sql
│   ├── 011_add_payment_provider_details.sql
│   ├── 012_add_sms_messages.sql
│   ├── 013_add_provisioning_details.sql
│   ├── 014_harden_admin_role.sql
│   ├── 015_add_sms_incoming_events.sql
│   └── 016_extend_sms_incoming_status.sql
├── seeds/               # Optional seed SQL (empty — demo catalog lives in backend/src/services/seed.js)
└── README.md
```

## Schema overview

| Table | Purpose |
|---|---|
| `users` | Customer/admin accounts. `role` is `customer` (default) or `admin` (CHECK `users_role_check` from 001, re-asserted by 014). Registration always inserts `customer`; admin is granted only by an operator-run `UPDATE users SET role = 'admin'` (never by API). `password_hash` stores modular password hashes only (bcrypt/argon2 style, must start with `$`). Plaintext passwords are rejected by a CHECK constraint. |
| `sessions` | Authenticated customer sessions. Stores only a SHA-256 `session_hash` of the cookie token (never the raw token), plus `expires_at`, `last_seen_at`, `ip_address`, and `user_agent`. `ON DELETE CASCADE` from `users`. |
| `hosting_plans` | Web hosting plan catalog. Prices use `NUMERIC(10,2)`; `currency` is a 3-letter ISO code (default `BDT`). `domains` / `email_accounts` / `databases` are nullable — `NULL` means unlimited. |
| `vps_plans` | VPS plan catalog (CPU, RAM, storage, bandwidth, IPv4). Prices use `NUMERIC(10,2)`; `currency` is a 3-letter ISO code (default `BDT`). |
| `orders` | Customer order records. `product_type` + `product_id` identify the catalog item; `amount`/`currency` are snapshotted at creation inside a transaction. `idempotency_key` (migration 009) is optional and unique per user for safe retries. Status starts as `awaiting_payment`; no client endpoint can mark orders paid. |
| `payment_transactions` | Payment attempts (migration 010). One order → many attempts; at most **one** `successful` per order (partial unique index). `amount`/`currency` copy the order row at attempt creation. Statuses: `initiated`, `pending`, `successful`, `failed`, `cancelled`, `expired`, `refunded`. Partial unique index on `(provider, provider_transaction_id)` for webhook idempotency. Migration 011 adds `provider_session_key`, `validation_id`, and `bank_transaction_id` (SSLCommerz sandbox identifiers for audit/reconciliation — no secrets). No card data or secrets — only ids, amounts, timestamps, and a minimal `metadata` JSONB. |
| `servers` | Physical/virtualization infrastructure nodes (not customer instances). No secrets — `credentials_ref` points to an external secret store. |
| `sms_messages` | SMS send audit log (migration 012). One row per recipient per attempt: `sending` → `accepted` (provider accepted; not delivery) or `failed`. Stores `recipient_hash` (SHA-256 of the E.164 number) — **no raw phone numbers, no message body, no OTP codes, no credentials**; plus optional `user_id` FK (`ON DELETE SET NULL`), `provider`, nullable `provider_batch_id`/`provider_message_id`, `message_type`, timestamps, and minimal `metadata` JSONB (`recipientCount`, `errorCode`). |
| `sms_incoming_events` | Inbound TextBee `MESSAGE_RECEIVED` store (migration 015; status vocabulary extended by 016). One row per webhook delivery: `direction='received'`, `status` `received` \| `unverified` \| `parsed` \| `matched` \| `verified` \| `rejected` \| `ambiguous`, masked-safe `sender` retained for display, message body capped at 1600 chars, `idempotency_key` + `provider_message_id` unique per provider (idempotent replays), `webhook_event`, `webhook_subscription_id`, `device_id`, optional `gateway_id`, `received_at`, and `metadata` JSONB. Still **no** FK to `orders`/`payment_transactions` — order/payment linkage lives only in app metadata (order number, amount cents, TrxID) for audit; payment state changes go through `payment_transactions` + `markOrderPaidFromVerifiedPayment`, never a raw order update. |
| `service_instances` | A customer's actual hosting site or VPS. Uses typed FKs (`hosting_plan_id` / `vps_plan_id`) instead of a polymorphic `plan_id`. Migration 013 adds `provider` (provider name only — never credentials), lifecycle timestamps (`provisioned_at` / `suspended_at` / `terminated_at`), safe failure diagnostics authored by the app (`failure_code` / `failure_message_safe` — never raw provider responses), and a unique partial index on `order_id` (one service instance per paid order). Statuses (CHECK, from 006): `provisioning`, `active`, `suspended`, `terminated`, `failed` — “paid order, not yet provisioned” is represented by the *absence* of a row, not a `pending` status. |
| `schema_migrations` | Migration metadata table managed by the migration runner. |

## Design decisions

- **Primary keys:** UUIDs (`gen_random_uuid()`, built into PostgreSQL 13+).
- **Timestamps:** `TIMESTAMPTZ` everywhere; `updated_at` maintained by a trigger (`set_updated_at()`).
- **Money:** `NUMERIC` only — never floating point.
- **NULL = unlimited:** In plan resource columns (`bandwidth_gb`, and for hosting also `domains`, `email_accounts`, `databases`), `NULL` means "unlimited / not capped". Non-null values are CHECKed `>= 0`.
- **Currency:** both plan tables carry `currency VARCHAR(3)` (`^[A-Z]{3}$`), added in migration `008_add_plan_currency.sql`, defaulted to `BDT`.
- **Orders.product_id** is polymorphic (`hosting` or `vps`), so it cannot carry a foreign key. Application code must validate it against the table matching `product_type`. Financial history is intentionally decoupled from catalog edits.
- **Orders.idempotency_key** (when present) is unique only within the owning user (`orders_user_idempotency_key_unique` partial index), so different customers may reuse the same client-generated key string.
- **Payment attempts vs orders:** `payment_transactions` records attempts; the order row is the financial source of truth. Attempt `amount`/`currency` are copied from the order row by application code (they cannot carry their own FK to a mutable price). One order may have many attempts but at most one `successful` payment (`payment_transactions_one_success_per_order` partial index) — the DB-level guarantee behind "one verified payment per order".
- **Payment status vocabulary differs from orders:** `paid` is an order status and is rejected for payment rows by the status CHECK — payments use `successful`. Payment statuses are `initiated`, `pending`, `successful`, `failed`, `cancelled`, `expired`, `refunded`.
- **Provider detail columns (011):** `provider_session_key`, `validation_id`, and `bank_transaction_id` hold SSLCommerz sandbox identifiers for audit and reconciliation only — they are not secrets, are never returned by the API, and are added with `ADD COLUMN IF NOT EXISTS` so the migration is safely re-runnable.
- **SMS log privacy (012):** `sms_messages` deliberately has no message-body or recipient columns — a sha256 `recipient_hash` plus provider batch/message ids is enough for delivery auditing, retry safety, and debugging, while ensuring OTP codes and phone numbers are never persisted in plaintext. Rows are written *before* the provider call (`sending`) so even failed/disabled attempts leave an honest trail; `accepted` means provider acceptance only, never claimed delivery.
- **Provisioning details (013):** `service_instances` gains `provider` + lifecycle timestamps + `failure_code`/`failure_message_safe` and the `service_instances_order_id_unique` partial index (one instance per order — the idempotency guarantee behind replayed `provisionOrder` calls). `failure_message_safe` stores only app-authored normalized messages (≤ 255 chars); raw provider errors never reach the database. All columns are added with `ADD COLUMN IF NOT EXISTS` and the index with `IF NOT EXISTS`, so the migration is safely re-runnable. No provisioning secrets are stored — only the provider's name.
- **Admin role (014):** re-asserts `users.role DEFAULT 'customer'` and the `users_role_check` CHECK (`customer` | `admin`) so partial schemas cannot admit other roles. Idempotent; **never** promotes a row. Promotion procedure lives in the root README. Admin dashboard metrics and order management (**step 14**) reuse existing tables (`users`, `orders`, `service_instances`, `payment_transactions`) with parameterized aggregates — **no new migration**. Admin customer management (**step 15**, read-only list/detail) likewise reuses `users`, `orders`, and `service_instances` with parameterized joins — **no new migration for step 15**.
- **Incoming SMS (015):** creates `sms_incoming_events` for the TextBee `POST /api/webhooks/textbee/sms` foundation. Unique indexes on `(provider, idempotency_key)` and `(provider, provider_message_id)` make redeliveries no-ops; CHECK limits status to `received`/`unverified` and direction to `received`. Deliberately **no** FK to `orders`/`payment_transactions` — inbound SMS alone is never payment proof. Total migrations after 015: **15**.
- **bKash SMS status vocabulary (016):** re-creates `sms_incoming_events_status_check` to allow `parsed`, `matched`, `verified`, `rejected`, and `ambiguous` alongside `received`/`unverified` (existing rows keep their values). The 7-value vocabulary mirrors the Step 17 verification pipeline; `ambiguous` is the manual-review state and is **never** auto-paid. No new columns, no FKs, no secrets — only the allowed status set grows. Idempotent (`DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`). Total migrations now **16**.
- **Service instances** use two typed FK columns with a pairing CHECK, preserving referential integrity for plan references.
- **Delete behavior:** plan/catalog foreign keys use `ON DELETE RESTRICT` so plans and servers cannot be deleted while referenced. `sessions.user_id` is the exception: it uses `ON DELETE CASCADE` so a deleted user's sessions are removed automatically. Row removal elsewhere must be an explicit, reviewed operation (typically status changes instead).
- **Secrets:** never stored in migrations or schema. Only `credentials_ref` (a pointer) exists on `servers`.
- **No reserved words:** column/table names avoid PostgreSQL reserved keywords (`users`, `orders`, `status`, etc.).

## Migration runner

Minimal runner: `backend/src/services/migrator.js`.

- Applies `database/migrations/*.sql` in lexicographic (numbered) order.
- Each migration runs inside a transaction; failure rolls back that migration only.
- Tracks applied files (with SHA-256 checksums) in `schema_migrations`.
- Re-running is safe: already-applied migrations are skipped.
- Editing an applied migration file causes a checksum error (create a new migration instead).

## Commands (run from `backend/`)

```bash
npm run db:create    # Create the database (if missing)
npm run db:check     # Verify connectivity
npm run db:migrate   # Apply pending migrations
npm run db:status    # Show applied vs pending migrations
npm run db:seed      # Seed the demo plan catalog (idempotent)
```

## Seeds

Demo catalog data is seeded from `backend/src/services/seed.js` (`npm run db:seed`), not SQL files:

- Hosting: Starter, Business, Pro (slugs `starter`, `business`, `pro`)
- VPS: VPS-1, VPS-2, VPS-4 (slugs `vps-1`, `vps-2`, `vps-4`)
- Prices are original sample BDT figures labeled as demo/placeholder data — not copied from other providers and not a commercial offer.
- Idempotent via unique slug + `INSERT … ON CONFLICT (slug) DO NOTHING`.
- Never seeds users, orders, or infrastructure. Refuses `NODE_ENV=production` unless `SEED_ALLOW_PRODUCTION=true`.
- The seed also runs pending migrations first so a fresh database works with one command.

`seeds/` remains empty for optional future SQL fixtures.
