# Deploying the demo to Vercel (frontend only — no server, no database)

The demo build needs nothing but the Vite app. When a visitor opens the site for the first time it creates a complete
sample dairy **inside their own browser** (IndexedDB) and signs them in as the owner — no sign-in, no API, no database.
Nothing is shared between visitors and nothing is sent anywhere.

## What the visitor gets
* **Shree Gokul Dairy** with 6 farmers, a cow-milk rate chart and 12 days of morning/evening milk collections
* A paneer production batch, packaged curd lots (one fresh, one close to expiry, one expired), a write-off to try
* 11 products with pack sizes and GST rates, ~45 counter bills over two weeks, 6 customers, expenses, 2 deliveries
* Farmer ledgers with two settlements paid, an advance and a deduction
* Three users — PINs shown on the lock screen: **Owner 1234 · Manager 2222 · Cashier 3333**
* **Demo data · Reset** (top right) restores the original data at any time

## Deploy
1. Push this folder to a GitHub repository (the `backend/` folder can stay — it is ignored by this build).
2. In Vercel: **Add New → Project → import the repository**.
3. Leave the settings as detected: Framework **Vite**, build command and output directory come from `vercel.json`
   (`VITE_DEMO=1 npx vite build` → `dist`). No environment variables are needed.
4. Deploy. Open the URL — the first load takes a few seconds while the sample data is built.

Or from your PC: `npm install -g vercel`, then `vercel` in this folder (and `vercel --prod` to publish).

The app uses hash URLs (`/#/collection`), so no rewrite rules are needed for page refreshes.

## Notes
* The build uses `vite build` directly (not `npm run build`) so a type-check hiccup cannot block a demo deploy; run
  `npm run build` locally if you want the stricter check.
* Each browser keeps its own copy. Clearing site data, or using a private window, starts fresh.
* To go back to the real two-service deployment (this app + the NestJS API), rename `vercel.fullstack.json` to
  `vercel.json` and follow `DEPLOY.md`.
