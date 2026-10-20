# Krishna Collection — Cloud API

NestJS 10 + PostgreSQL (built for [Neon](https://neon.tech)). The React/Tauri app stays **local-first** —
IndexedDB is where billing happens and it works with zero internet. This API is what the app syncs to in the
background (push, via the offline outbox) and what a new device or the web app hydrates from (pull,
`GET /api/sync/snapshot`).

## Run it locally

```bash
cd backend
npm install
cp .env.example .env            # fill in DATABASE_URL (Neon) and JWT_SECRET (openssl rand -hex 32)
npm run migrate                 # creates the tables (safe to re-run)
npm run provision -- --store "Krishna Collection" --owner "Your Name" \
    --email you@example.com --password "a-long-password" --pin 1234
npm run start:dev               # http://localhost:8080/api/health
```

`provision` prints the **Store ID**. In the app: *Settings → Data → Cloud sync* → API URL
`http://localhost:8080/api` + that Store ID.

Local Postgres instead of Neon: set `DATABASE_URL=postgresql://user:pass@localhost:5432/rr` — TLS is skipped
for localhost automatically.

## Tests

```bash
DATABASE_URL=postgresql://postgres@localhost:5432/rr_test npm run test:e2e
```
The suite **drops and recreates the `public` schema** of whatever database it points at — never aim it at real data.

## Auth

| Endpoint | Used by | Body |
|---|---|---|
| `POST /api/auth/login` | counter / desktop (sync client) | `{storeId, userId, pin}` |
| `POST /api/auth/web-login` | web app | `{email, password}` → `{token, user, store}` |

Five wrong secrets lock that user for 15 minutes. JWTs are 12 h by default. Roles (`owner`/`manager`/`cashier`)
are enforced on the server independently of the UI. `store_id` always comes from the token, never the body.

## API surface

`/health` · `/auth/*` · `/users` (public staff list; owner-only create/update) · `/store` · `/categories` ·
`/products` `/variants` `/variants/barcode/:code` · `/customers` · `/suppliers` · `/purchases` · `/bills`
`/bills/:id/return` · `/stock/moves` `/stock/adjust` · `/expenses` · `/sessions` · `/sync/snapshot`

Writes are idempotent for the sync client: a record that already exists answers **409**, which the client
treats as "done" — a lost response can never double-post a sale or a return.

## Deploying

Any Node 20+ host (Render, Railway, Fly.io, a VPS). Build with `npm ci && npm run build`, start with
`npm run migrate:prod && npm start` (new client: `npm run provision:prod -- --store …`). A `Dockerfile` is included. Set `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS`
(your hosted web-app origin). Use Neon's **pooled** connection string.

## Not built yet

Incremental (delta) pull for multi-device conflict handling — today the model is one writer per store with
snapshot restore for additional devices. The audit log is local-only.
