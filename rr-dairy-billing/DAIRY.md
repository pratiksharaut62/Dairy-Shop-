# RR Dairy — what was added on top of the billing app

This project started as the clothing billing app. Everything that makes a shop work — POS, bills and returns,
customers and credit, expenses, purchases, stock control, labels, printing, backups, login/PIN, the offline outbox
and the cloud sync — is unchanged. The dairy layer sits beside it.

Run it exactly as before (`npm install`, `npm run dev`; backend: see `backend/` and `DEPLOY.md`). **Run the new
migration** `backend/migrations/006_dairy.sql` on the database (the migration runner picks it up automatically).

## Screens

| Screen | Who (permission) | What it does |
|---|---|---|
| Dashboard | owner, manager (`reports`) | Original sales cards **plus** a dairy panel: litres collected, average Fat/SNF, today's morning/evening litres, amount owed to farmers, collection trend, "needs attention" list, expiry watch |
| Milk Collection | `collection` | Pick farmer by code, enter litres / Fat / SNF; the rate and amount appear live from the rate chart. Morning/evening session, cow/buffalo/mixed. Duplicate-entry warning. Approve / reject pending entries (`quality`) |
| Farmers | `collection` (money: `settlement`) | Farmer master, account ledger, advances, deductions (feed, vet…), pay-out settlement |
| Rate Chart | `quality` | Fat × SNF grid per milk type with an effective-from date. A generator builds the whole grid from a base rate and a rise per 0.1 % of Fat / SNF |
| Production | `production` | Start a batch from raw-milk lots (oldest first), finish it with QC pass/fail and the products made |
| Lots & Expiry | `stock` (write-off: `wastage`) | Every lot with expiry, expired / expiring-soon counts, receive a lot from outside, write off; **Write-offs** tab for approval |
| Delivery | `delivery` | Route / vehicle / driver, items, Packed → Dispatched → Delivered / Failed |
| Products | `inventory` | Replaces the size × colour screen: product, category, unit, shelf life, GST %, pack sizes with price/MRP/cost, archive instead of delete |
| Dairy Reports | `reports` | Collection (by day / farmer / session), production, expiry, farmer dues, wastage — all with CSV export |

Roles: **owner** everything · **manager** everything except settings and approving write-offs · **cashier** POS,
customers, milk collection entry (their entries wait for approval) and delivery.

Responsive: the layout, the bottom navigation on phones and the large touch inputs of the clothing app are reused,
so Android, tablet and laptop behave the same way.

## Counter-grade screens (frontend)

* **Milk Collection** is laid out like a collection-centre counter: a shift banner (date + morning/evening), a big farmer-code
  box, litres → Fat → SNF with Enter moving between them, a live amount band, and a right-hand **shift summary** (litres,
  farmers delivered of active, weighted Fat/SNF, milk-type split) plus **Yet to deliver** chips — tap one to load that
  farmer. After saving, a **milk slip** prints (58/80 mm) and can be reprinted from the banner or any row; "Print slip" can be
  switched off and is remembered.
* **Farmers → Passbook:** pick a 10-day / monthly cycle, see litres, average Fat/SNF, milk value and balance, print an A4
  **farmer statement**, or copy a short summary to paste into WhatsApp/SMS.
* **Payments** (payment register): choose a cycle (1–10, 11–20, 21–end, whole month; this month and last), see every farmer's
  litres, Fat/SNF, milk value, advances/deductions and balance, tick who to pay (amount editable), pick Cash/UPI/Bank and
  pay them all at once. Print or export the register.
* **Dairy Reports → Shift register:** the day's collection sheet for one shift, farmer by farmer with totals — printable.
  Every report tab now has Print as well as CSV.
* **Dashboard:** today's morning and evening shift cards, top suppliers, collection trend, needs-attention list, expiry watch.
* **New look:** a dark navy left sidebar (shop name, grouped sections, **Dairy operations** first) replaces the old top toolbar;
  a slim header shows where you are, today's date and the running shift; panels are flat white with tinted status chips,
  tab-style switches and larger KPI tiles. On tablets the sidebar narrows to an icon rail; phones keep the app bar,
  bottom navigation and slide-out menu. All of it lives in `src/styles.css` (the "v2 — Enterprise look" block at the end)
  and the `Sidebar` / `AppHeader` components in `src/App.tsx`.

## Rules worth knowing

* **Rate chart cells** match when `fatMin ≤ fat < fatMax` and `snfMin ≤ snf < snfMax` (upper bound excluded, so
  cells never overlap or leave gaps). The chart in force is the newest *active* one for that milk type whose start
  date is on or before the collection time.
* **The rate is frozen on the collection.** Editing or replacing a chart never changes milk already collected.
* **The server re-derives the rate** from its own copy of the chart and stores its answer, so a device with a stale
  chart cannot misprice milk. A reading outside the chart is refused (422) rather than guessed.
* **Approving milk** (in one transaction, locally and on the server) adds a *lot* of raw milk (default 1 day shelf
  life) to stock, writes the stock move, and credits the farmer's ledger. Rejected milk does nothing.
* **Farmer ledger:** positive = owed to the farmer. Milk credits; advances, deductions and settlements debit.
  A settlement cannot pay more than is owed (checked on the server under a row lock).
* **Production:** starting a batch takes the chosen quantities out of the lots; a *passed* batch turns its outputs
  into new lots with expiry = completion + the product's shelf life; a *failed* batch adds nothing (the milk used is a
  loss).
* **Expiry:** a sale never draws from an expired lot, and POS refuses to sell stock that is only expired stock
  ("write it off in Wastage first"). Sales consume **first-expiry-first-out**; stock that was never put in a lot
  (opening stock, ordinary purchases) is simply sold from the remainder. Returns go back to plain stock, not to a lot.
* **Write-offs** by the owner apply at once; a manager's wait for the owner's approval and change stock only then.
* **Quantities are fractional** (litres, kg): stock, move, purchase and bill quantities are `NUMERIC(12,3)`.
* **GST:** each product can carry its own rate (milk 0 %, paneer 5 %, ghee 12 % …) which wins over the store's price
  slabs; products without one use the slabs (default now a flat 5 %). Confirm rates with your accountant.

## Data sync API

Same offline-first pattern as before: every action writes to the local database and queues one request in the
outbox; the sync client replays them in order. A record's client-generated `id` is its idempotency key — a retry
that already landed answers **409**, which the client treats as done.

| Method & path | Permission | Notes |
|---|---|---|
| `GET /api/sync/snapshot` | any | Now also returns farmers, rateCharts, collections, lots, deliveries (everyone) and ledger, settlements, batches, wastage (managers/owner) |
| `GET/POST /api/dairy/farmers`, `PUT …/:id`, `GET …/:id/ledger` | `collection` | Unique farmer code per store; opening balance becomes the first ledger row |
| `POST /api/dairy/farmer-ledger` | `settlement` | Advances and deductions only |
| `GET/POST /api/dairy/rate-charts` | read `collection`, write `quality` | |
| `GET/POST /api/dairy/collections`, `POST …/:id/decision` | `collection` / `quality` | Server prices the milk; a cashier cannot self-approve |
| `GET/POST /api/dairy/settlements` | `settlement` | |
| `GET/POST /api/dairy/lots` | `stock` | POST = stock received from outside |
| `GET/POST /api/dairy/production/batches`, `POST …/:id/complete` | `production` | Locks the input lots; 422 if not enough is available |
| `GET/POST /api/dairy/deliveries`, `PUT …/:id` | `delivery` | |
| `GET/POST /api/dairy/wastage`, `POST …/:id/decision` | `wastage` / `approveWastage` | |
| `GET /api/dairy/dashboard`, `/reports/collections`, `/reports/expiry`, `/reports/farmer-dues` | `reports` | Server-side aggregates for the web app and exports |

Derived rows (a collection's lot and ledger credit, a settlement's ledger debit, batch output lots) are built from the
causing record's own id (`lot_<collectionId>`, `led_<collectionId>` …) on both the device and the server, so they are
never posted separately and never double-applied.

Product edits now sync too (`PUT /api/products/:id`) — before, a renamed or re-priced product only changed locally.

## Not changed / worth knowing

* Local data lives in a new IndexedDB database (`rr_dairy_billing`), separate from the clothing app's.
* The first install default cloud URL in `src/lib/cloud.ts` is a placeholder (`rr-dairy-billing.vercel.app`) — set your own.
* The e2e tests for the dairy API are in `backend/test/api.e2e-spec.ts` (`npm run test:e2e` needs a local Postgres).

## Trying it without a server

Nothing here needs the cloud API. On first launch choose **Start on this device**, enter a shop name, owner name and a
4-digit PIN, and tick "sample dairy data" to get farmers, a rate chart, milk collections, a paneer batch, lots that are
expiring or expired, and a delivery to look at. Data is kept in the browser (IndexedDB). A server can be connected later
in Settings; "Sign in to a server" on the first screen is only for loading an existing cloud store.
