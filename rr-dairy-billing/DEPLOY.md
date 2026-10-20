# Deploying Krishna Collection (Vercel + Neon)

One Vercel project, two services, one domain (see `vercel.json`):

| Service | Folder | Public path | Notes |
|---|---|---|---|
| `app` | `.` (Vite web app) | everything except `/api/*` | built with `VITE_API_URL=/api`, so the site talks to the API on its own domain |
| `backend` | `backend/` (NestJS) | `/api/*` | runs from `backend/Dockerfile.vercel` (Vercel Container Images, beta) — Vercel's own NestJS bundler left `node_modules` out of the function ("Cannot find module 'reflect-metadata'"). The service receives the full `/api/...` path, which matches the app's `api` global prefix. Listens on port 80 (`ENV PORT=80`). Migrations are **not** run on start — apply them by hand (step 2). |

`src-tauri/` is the Windows desktop shell. It is **not** deployed to Vercel; installers come from the
`Desktop release` GitHub workflow.

No service calls another service server-side (the browser calls `/api` directly), so there are no bindings.

## 1. Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string (`…-pooler….neon.tech/…?sslmode=require`) |
| `JWT_SECRET` | a long random string (`openssl rand -hex 32`) — never reuse the dev one |
| `JWT_TTL_SECONDS` | `43200` |
| `CORS_ORIGINS` | the production URL, e.g. `https://your-project.vercel.app` (add the custom domain too) |
| `DATABASE_POOL_MAX` | `5` (each serverless instance keeps its own small pool) |

## 2. One-time database setup (run from your PC, against Neon)

Secrets stay on your machine; nothing here runs on Vercel.

```bash
cd backend
npm ci && npm run build
DATABASE_URL="<neon pooled url>" npm run migrate:prod
DATABASE_URL="<neon pooled url>" npm run provision:prod -- --store "Krishna Collection" --owner "<name>" --email <email> --password "<strong password>" --pin <4 digits>
```

Re-run `migrate:prod` after any release that adds a file to `backend/migrations/` (the backups feature needs `002_backups.sql`).
Do **not** run `seed-demo.ts` against this database.

## 3. Windows desktop installer (built online by GitHub Actions — nothing to install locally)

1. GitHub repo → Settings → Secrets and variables → Actions → **Variables** → New repository variable:
   `VITE_API_URL` = `https://<your-domain>/api` (absolute — the desktop app is not on your domain).
2. Settings → Actions → General → Workflow permissions → **Read and write permissions** (so it can attach the installer).
3. Push a version tag (or Actions → *Desktop release* → Run workflow):
   `git tag app-v0.1.0 && git push origin app-v0.1.0`
4. Wait ~10–15 min (first run is slowest — it compiles the Rust shell). Repo → **Releases** → open the *draft* release →
   download `Krishna Collection_0.1.0_x64-setup.exe` (or the `.msi`) → publish the draft if you want to share the link.
5. Install on the counter PC. The app opens **full screen**; **F11** toggles it. First launch: "Sign in with email".

For each new version, bump `version` in `src-tauri/tauri.conf.json` (and `src-tauri/Cargo.toml`) and push a new `app-v…` tag.
Windows may show a SmartScreen warning because the installer is not code-signed — "More info → Run anyway".

## Limits to know about

* **Vercel Functions cap request *and* response bodies at 4.5 MB.** Cloud backups upload as one compressed body and a
  new device downloads the store as one snapshot. A shop with years of heavy history could eventually exceed this
  (the dev store's 383 bills compress to ~57 KB, so there is a lot of headroom). If the app reports "too large for the cloud",
  the fix is to move the backend to a host without that cap (the `backend/Dockerfile` is ready for that) — the app only
  needs a new `VITE_API_URL`.
* **The Hobby plan is for personal, non-commercial use.** A shop's billing system is commercial use, so use a paid plan.
* Functions run in one region by default (`iad1`); pick the region closest to the Neon database and the shop.

## 4. Making yourself a super admin (to see Settings → Diagnostics)

After `npm run migrate` has applied `004_super_admin_and_device_health.sql`:

```bash
cd backend && DATABASE_URL="<neon url>" npm run super-admin -- --email <your account email>
```

Sign out and in again (or wait for the next token refresh). See DATA-SAFETY.md → "How we see failed syncs and backups".
