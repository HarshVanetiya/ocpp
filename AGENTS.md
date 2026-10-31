# AGENTS.md — Project context for AI assistants

Read this whole file before writing any code in this repo.

## What we are building

A **multi-tenant EV charging platform MVP** (India, ₹ INR).

- **Chargers** (hardware) connect to our server over **OCPP 1.6J** WebSockets.
- **Drivers do NOT have a mobile app.** They use a **Telegram bot**. Each connector has a printed **QR code** that opens the bot with a deep link: `https://t.me/<BOT_USERNAME>?start=cp_<ocppId>_conn_<connectorNo>`.
- **Tenants** are our client companies: fleet operators, housing societies (RWAs), offices, CPOs. Each owns chargers and a list of members.
- **Tenant admins** use a **Next.js dashboard** to manage their chargers, members, tariffs, QR codes and sessions.
- **Super admin** (us) creates tenants and registers chargers.

The developer is learning while building. Prefer simple, readable code over clever abstractions. Explain non-obvious decisions briefly.

## Tech stack (do not change without asking)

| Area | Choice |
|---|---|
| Package manager | **pnpm** workspaces (never npm/yarn) + Turborepo |
| Backend | Node.js 26, pnpm 12, **Express 5**, TypeScript, run with `tsx` |
| OCPP | `ws` library, OCPP **1.6J** only, subprotocol `ocpp1.6` |
| Telegram | **grammY** |
| Database | PostgreSQL 16 **hosted (Neon/Aiven)** + **Prisma 6** (pinned); never a Postgres container |
| Deploy | API runs as a **Docker image** (scaled to N containers); dev runs with `pnpm dev`, no local Docker |
| Validation | zod |
| Payments | Razorpay Payment Links + webhook |
| Frontend | Next.js (App Router) + Tailwind |
| Auth | JWT in httpOnly cookie, issued by Express |
| Tests | vitest |

## Repo layout

```
AGENTS.md            ← this file
guide/               ← day-by-day HTML build guide (open guide/index.html)
Dockerfile           ← API image (built by GitHub Actions → GHCR; the developer cannot run Docker locally)
.github/workflows/   ← docker.yml builds/pushes the API image
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
apps/
  api/               ← @ev/api : Express + OCPP gateway + Telegram bot (single process, port 4000)
    src/
      index.ts       ← boots HTTP server, attaches OCPP WS, starts bot, mounts routes
      env.ts         ← zod-validated env
      events.ts      ← typed EventEmitter (OCPP layer emits, bot layer listens)
      jobs.ts        ← offline watchdog, stale PENDING cleanup
      ocpp/gateway.ts   ← WS server, sockets Map, call(), sendRemoteStart/Stop
      ocpp/handlers.ts  ← Boot, Heartbeat, Status, Authorize, Start/Meter/StopTransaction
      services/access.ts  ← decideAccess (pure) + checkAccess (loads DB)
      services/session.ts ← startSession / stopSession
      services/billing.ts ← finishSession (kWh × locked price, wallet debit)
      bot/bot.ts     ← grammY bot, onboarding, scan handling, start/stop buttons
      bot/notify.ts  ← events → Telegram (live pinned message, receipt)
      bot/topup.ts   ← /topup → Razorpay payment link
      middleware/auth.ts ← requireRole(), sets req.auth and req.db
      routes/auth.ts, admin.ts, tenant.ts, webhooks.ts
    scripts/sim.ts   ← fake OCPP charger for local testing
  web/               ← @ev/web : Next.js dashboard (port 3000, proxies /api/* → :4000)
packages/
  db/                ← @ev/db : Prisma schema, client, tenantDb(), normalizePhone()
```

## Domain model (Prisma, `packages/db/prisma/schema.prisma`)

- `AccessMode` enum: `PUBLIC`, `PRIVATE_MEMBER` (society resident/employee), `FLEET` (fleet driver).
- `Tenant` — client company.
- `User` — a Telegram driver. `telegramId` unique, `phone` (E.164, unique, verified via Telegram contact), `walletBalance` Decimal.
- `TenantMembership` — a phone number whitelisted by a tenant with role `FLEET` or `PRIVATE_MEMBER`. `userId` is **nullable**: admins add by phone before the driver ever opens the bot; we fill `userId` when the driver shares their contact. Unique `(tenantId, phone)`.
- `ChargePoint` — `ocppId` unique (e.g. `CP_101`), belongs to one tenant, `allowedModes AccessMode[]` (hybrid support), `isOnline`, `lastSeenAt`.
- `Connector` — `connectorId` Int (1, 2…) per charger, `status` string from OCPP.
- `ChargerTariffRule` — one row per (chargePoint, mode) with `pricePerKwh`.
- `ChargingSession` — `transactionId` Int autoincrement (sent to charger), `idTag` random 20-char hex (sent to charger), `mode` + `pricePerKwh` **locked at start**, status `PENDING → ACTIVE → COMPLETED | FAILED`, Wh meter readings, `energyKwh`, `amount`, `telegramChatId`, `statusMessageId`.
- `AdminUser` — dashboard login, role `SUPER_ADMIN | TENANT_ADMIN`, `tenantId` null for super admin.
- `Payment` — wallet top-up via Razorpay, `razorpayLinkId` unique, status `CREATED → PAID`.

## Core business rules (must never be broken)

1. **Tenant isolation.** Tenant-admin routes must query only through `req.db` = `tenantDb(tenantId)` (a Prisma `$extends` that injects `tenantId` into every where/create). `tenantDb` throws for non-tenant models. Never use the raw `prisma` client with user-supplied ids in tenant routes without first checking ownership via `req.db`.
2. **Access waterfall** (`decideAccess`):
   1. Charger online, connector `Available`/`Preparing`, user has no other PENDING/ACTIVE session — else deny.
   2. **Case A:** user has an active membership in *this charger's tenant* AND that role ∈ `allowedModes` AND a tariff rule exists → that mode/price.
   3. **Case B:** else if `PUBLIC` ∈ `allowedModes` → PUBLIC tariff (deny if no rule configured).
   4. Else deny: "⛔ This charger is restricted to authorized Fleet/Society members only."
   5. If chosen price > 0 → wallet must be ≥ `MIN_WALLET_BALANCE`.
3. **Re-check access when the Start button is pressed** — never trust an old Telegram message.
4. **Price is locked** on the session at creation. Billing uses `session.pricePerKwh`, never the current tariff.
5. **Billing:** `energyKwh = (meterStopWh − meterStartWh) / 1000`, `amount = energyKwh × pricePerKwh` (2 dp), debit wallet in the same DB transaction. Must be idempotent (only bill ACTIVE sessions).
6. **Money** uses Prisma `Decimal` (`@db.Decimal`), never JS floats for storage. Razorpay amounts are in **paise**.
7. **Razorpay webhook:** verify HMAC-SHA256 signature over the **raw** body (mount before `express.json()`); credit only on `CREATED → PAID` flip (idempotent).
8. **Phones** are always normalized with `normalizePhone()` (`+91XXXXXXXXXX`) before saving or comparing.
9. Only accept a Telegram contact where `contact.user_id === ctx.from.id`.

## OCPP 1.6J conventions

- Endpoint: `ws(s)://<host>/ocpp/:ocppId`. Unknown `ocppId` → reject upgrade with 404. Subprotocol must be `ocpp1.6`.
- Frames: CALL `[2, id, action, payload]`, CALLRESULT `[3, id, payload]`, CALLERROR `[4, id, code, description, details]`.
- Active sockets: `Map<ocppId, WebSocket>`. Outgoing calls tracked in a `pending` Map keyed by uniqueId with a timeout.
- Remote start flow: create PENDING session with `idTag` → `RemoteStartTransaction {connectorId, idTag}` → charger may send `Authorize` → `StartTransaction {idTag, meterStart}` → we return our `transactionId` and mark ACTIVE. PENDING sessions fail after 2 minutes.
- `StatusNotification` with `connectorId: 0` refers to the whole charger — ignore for connector status.
- `MeterValues`: read `Energy.Active.Import.Register` (default measurand), convert kWh → Wh if `unit === "kWh"`.
- Always reply to `StopTransaction`, even if billing throws.
- The OCPP layer never imports the bot. It emits `session:started | session:meter | session:stopped | session:failed` on `events`; `bot/notify.ts` listens.

## Telegram conventions

- Deep link payload: `cp_<ocppId>_conn_<n>`; parse with `/^cp_(.+)_conn_(\d+)$/`. Telegram allows only `A-Za-z0-9_-`, max 64 chars.
- Unverified users (no phone) get a `request_contact` keyboard; their QR payload is remembered and resumed after verification.
- Callback data: `start:<ocppId>:<n>` and `stop:<sessionId>` (≤ 64 bytes).
- One live status message per session: send once, pin, then **edit** (throttled to 15 s). Unpin + receipt on stop.
- Dev uses long polling (`bot.start()`); production uses webhook `/webhooks/telegram` with a secret token.
- Plain text messages (no Markdown parse mode) — ocppIds contain underscores.

## API surface (Express, port 4000)

- `GET /health`
- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `/admin/*` (SUPER_ADMIN): `GET/POST /tenants`, `GET/POST /charge-points`
- `/tenant/*` (TENANT_ADMIN, via `req.db`): `GET /chargers`, `PUT /chargers/:id/modes`, `GET/POST /members`, `PATCH /members/:id`, `GET /sessions?from&to&mode`
- `POST /webhooks/razorpay`, `POST /webhooks/telegram`
- WS `/ocpp/:ocppId`

The Next.js app calls these as `/api/...` (rewrite to the API) so cookies are same-origin.

## Commands

```bash
# Postgres is hosted (Neon dev branch) — no local Docker, no docker-compose for the DB
pnpm install
pnpm db:migrate                      # prisma migrate dev
pnpm db:seed                         # super@ev.local / admin@tata.local, password admin123, charger CP_TEST01
pnpm dev                             # api :4000 + web :3000
pnpm --filter @ev/api sim CP_TEST01  # fake charger
pnpm test
```

## Environment variables

`apps/api/.env`: `DATABASE_URL`, `PORT`, `MIN_WALLET_BALANCE`, `TELEGRAM_BOT_TOKEN`, `BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `PUBLIC_URL`, `JWT_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
`packages/db/.env`: `DATABASE_URL` (pooled), `DIRECT_URL` (direct, for migrations)
`apps/web/.env.local`: `API_URL`, `NEXT_PUBLIC_BOT_USERNAME`
Never commit `.env` files.

## Coding conventions

- TypeScript strict. ESM in `apps/api` (`"type": "module"`), `moduleResolution: Bundler`.
- Validate every request body/query with zod. Central Express error handler maps `ZodError → 400`, Prisma `P2002 → 409`.
- Keep business logic in `services/`, keep it testable (pure functions where possible, like `decideAccess`).
- Small files, named exports, no classes unless they clearly help.
- User-facing bot text: short, emoji prefix, ₹ for money.

## Build plan & progress

The step-by-step guide lives in `guide/` (open `guide/index.html`). Update the checkboxes below at the end of each day so the assistant knows where we are.

- [ ] Day 1 — Monorepo setup (pnpm, turbo, Neon Postgres, API Dockerfile)
- [ ] Day 2 — Prisma schema, migration, seed
- [ ] Day 3 — `tenantDb` isolation extension
- [ ] Day 4 — Access & tariff engine + tests
- [ ] Day 5 — Express + OCPP WebSocket gateway + simulator
- [ ] Day 6 — OCPP handlers + billing
- [ ] Day 7 — Remote start/stop, session service
- [ ] Day 8 — Telegram bot, phone onboarding, membership linking
- [ ] Day 9 — QR deep link flow, live status, receipt
- [ ] Day 10 — Wallet top-up with Razorpay
- [ ] Day 11 — Dashboard auth (JWT cookie, RBAC)
- [ ] Day 12 — Super admin pages
- [ ] Day 13 — Tenant dashboard (modes, tariffs, QR, members, sessions)
- [ ] Day 14 — Go live (webhooks, watchdog, deploy)

## Out of scope for the MVP

Mobile app, OCPP 2.0.1, smart charging/load management, invoicing/payouts, multi-currency, charger firmware updates.
