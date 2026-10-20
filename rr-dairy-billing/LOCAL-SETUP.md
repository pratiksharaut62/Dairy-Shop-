# Local setup (Krishna Collection)

- DB: Docker container `krishna-billing-pg` (postgres:17, port 5433, volume `krishna_billing_pgdata`)
  `docker start krishna-billing-pg`
- API: `cd backend && npm run start:dev` -> http://localhost:8080/api/health  (config in backend/.env, git-ignored)
- App: `VITE_API_URL=http://localhost:8080/api npm run dev` -> http://localhost:5173
- Store ID: store_e01dc1804c
- Web login: owner@krishna.local / krishna-dev-2026   (local dev only), staff PIN 1234
- Re-provision: `cd backend && npx ts-node src/cli/provision.ts --store "..." --owner "..." --email ... --password ... --pin ...`
- Demo data (dev only): `cd backend && npx ts-node src/cli/seed-demo.ts --store-id store_e01dc1804c [--days 45] [--reset]`
  (--reset wipes that store's catalogue/bills/expenses first). Then clear the app's local data and sign in again to pull it.
