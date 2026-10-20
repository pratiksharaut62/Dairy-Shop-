# RR Dairy — Billing & Inventory (Prototype)

A complete billing, inventory and **dairy operations** system for a dairy shop
(see [DAIRY.md](DAIRY.md) for the dairy modules, rules and API), built as a
working prototype on the same offline-first foundation as the clothing version. It runs entirely in the browser and stores its data locally,
so billing keeps working when the shop's internet doesn't.

**Stack:** React + TypeScript + Vite · Dexie (IndexedDB) · JsBarcode · plain CSS design system · Tauri desktop shell.
**Cloud (optional but how clients ship):** NestJS + PostgreSQL ([Neon](https://neon.tech)) in `backend/` — web login, background cloud sync, restore onto a new device.

---


## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```
```bash
npm run build && npm run preview   # production build
```

### As a desktop app


The same app also runs as a real native Windows/Mac/Linux window via
[Tauri](https://tauri.app) — same React UI, same local IndexedDB storage, a
native File menu (New Bill, Backup Data…), native save/open dialogs for
backup, and a real hardware printer path (see below) — all backed by a small
Rust shell instead of a bundled Chromium, so the installer is ~3.6MB and
starts instantly rather than the 100MB+ a Chromium-based shell needs. Full
setup, prerequisites and a step-by-step printer/cash-drawer guide live in
[`src-tauri/README.md`](src-tauri/README.md).

```bash
npm run tauri:dev      # dev: hot-reloading Vite + a native window
npm run tauri:build    # full installer (.exe/.dmg/.AppImage/.deb) in src-tauri/target/release/bundle/
```

Building requires the Rust toolchain (`rustup.rs`) plus the platform's
webview dependencies — on Linux that's `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `libssl-dev` (see
[Tauri's prerequisites](https://tauri.app/start/prerequisites/) for
Windows/Mac, which need only Visual Studio Build Tools / Xcode
respectively — no extra packages). `tauri:build` targets whichever OS you
run it on. A production icon isn't set up yet — replace the placeholders
under `src-tauri/icons/` before shipping installers to anyone outside the
team.

**Receipt printer.** By default receipts print through the browser dialog,
same as the web app — works with any printer. **Settings → Receipt &
loyalty → Hardware printer** (desktop only) switches to sending raw ESC/POS
bytes straight to a real thermal printer instead: USB (most budget Indian
thermal printers show up as a USB-serial/COM port — pick it from the list),
or Network (any printer with its own IP, port 9100 by default — the
standard raw-print port nearly every network thermal printer listens on).
A cash sale kicks the cash drawer open automatically; there's also a manual
"Open cash drawer" button for a no-sale open. The formatting logic lives in
`src/lib/escpos.ts`; the Rust side (`src-tauri/src/printer.rs`) is a thin,
dumb pipe that just writes whatever bytes it's given to the port or socket
— it doesn't know or care what a receipt looks like.

There is no demo data. A new device starts empty and asks you to sign in with the store's
cloud account; the whole store is then downloaded. Staff are added in **Settings → Staff**
and each person signs in at the counter with a 4-digit PIN (stored scrambled — it can be
changed but never shown). How the data is protected is described in [DATA-SAFETY.md](DATA-SAFETY.md).

### Roles

| Role | Sees |
|---|---|
| Owner | Everything, including profit, settings, restore and backups |
| Manager | Billing, stock, purchases, reports |
| Cashier | Billing counter and customers only |

### Counter shortcuts

`F1` billing · `F2` jump to the scan box · `F3` attach customer · `F4` payment · `F9` dashboard · `F11` full screen on/off (desktop app; it opens maximized with the normal minimize / maximize / close buttons) · `Esc` close

---

## What's built

**Billing (POS)** — barcode scan or type-to-search, cart with per-line quantity, price
override and discount, bill-level discount and coupon, customer attach by mobile,
loyalty redemption and store credit, split payments across cash/card/UPI, cash-tendered
and change calculation, park and resume bills, GST computed per line.

**Bill printing** — 58mm/80mm thermal receipt and an A4 GST tax invoice, both with the
HSN summary, amount in words and a scannable barcode of the bill number for fast returns.
Printing goes through the browser, so any printer works.

**Barcode system** — every size/colour variant gets its own SKU and EAN-13 barcode
(in-store `210` prefix, check digit computed). Label sheets print 3-up on A4 sticker
paper or feed a label roll; the same codes are scanned at billing, goods receipt and
stock audit.

**Inventory** — style master with a size × colour variant matrix, cost/MRP/selling price,
HSN, category, brand, fabric, season. Bulk price edits, CSV import and export.

**Stock control** — live stock per SKU driven by a movement ledger (sale, return,
purchase, adjustment, audit, opening). Adjustments with reasons, low-stock and dead-stock
filters, and a scan-based physical count that posts the variance in one go.

**Purchases** — supplier master, goods-received notes that add stock and update cost,
outstanding payables, and one-click label printing for everything just received.

**Customers** — mobile-number-keyed CRM with purchase history, lifetime spend, loyalty
points, store credit from returns, and a birthdays-this-month list for offers.

**Expenses** — categorised entries with payment mode, vendor, recurring flag, and a
category breakdown against sales for the same period.

**Returns & exchange** — pull up any bill, return part or all of it, refund as cash or
store credit. Stock goes back, a credit note is generated and printed.

**Reports** — daily sales, payment-mode split, GST/HSN summary for GSTR-1, profit & loss
(revenue − cost of goods − expenses), item performance with margins, staff performance,
and a day-close Z-report reconciling the cash drawer.

**Settings** — store and GSTIN details, editable GST slabs, tax-inclusive pricing toggle,
cashier discount cap, receipt width and policy text, loyalty rates, staff logins with
role permissions, audit log, and data safety (scheduled cloud and on-computer backups,
restore, protected backup files).

---

## How the money is calculated

- Tag prices are **GST-inclusive** by default (standard Indian retail); the taxable value
  is back-calculated and CGST/SGST split evenly.
- The apparel slab (5% up to ₹1,000 per piece, 12% above) is chosen on **what the customer
  pays per piece after discount**. Deciding it on the back-calculated ex-tax value instead
  leaves a dead band near the threshold where neither rate is self-consistent — a ₹1,099
  tag is over ₹1,000 at 5% but under it at 12%.
- A bill-level discount is spread across lines in proportion to their value before tax, so
  each line's slab reflects the real amount paid.
- Totals round to the nearest rupee with the difference shown as *Round off*.
- Loyalty points and store credit are treated as tender, not as a discount, so they don't
  reduce the taxable value.

## Data

Everything lives in IndexedDB in the browser (or desktop shell) that runs the app —
billing itself never depends on the network. **Settings → Data** downloads a full JSON
backup and restores from one at any time.

### Cloud backend, web login and sync

`backend/` is a NestJS + PostgreSQL (Neon) API — setup in [`backend/README.md`](backend/README.md).

- **First launch on any device** (browser or desktop installer) shows *Sign in & load my store*: email + password
  → the whole store is downloaded into the local database. No demo data is ever loaded unless you ask for it.
- **After that billing is local-first.** Every bill, product, customer, expense, purchase, supplier, day-close and
  staff change is queued and pushed in order in the background (offline-safe; retried when the connection returns).
  The badge in the top bar shows *Synced / Syncing / Offline*.
- **Counter login stays PIN-based.** A staff PIN downloaded from the cloud is verified by the server the first
  time on a device, then remembered locally for offline use. *Sign in with email* is also available on the lock screen.
- **Point an installer or web build at its backend** with `VITE_API_URL` (build time, e.g.
  `VITE_API_URL=https://api.yourstore.in/api npm run build`). In CI set the repository variable `VITE_API_URL`.
- **Not built yet:** pulling *other* devices' later changes into an already-running device (a new device gets a full
  snapshot; two tills editing the same store at once is not conflict-handled), uploading history created while
  sync was off, and the audit log (local-only).

## Not in this prototype

E-invoicing / IRN portal, e-way bills, SMS or WhatsApp sending, online payment gateways,
Tally export, and alteration/tailoring job tracking. The audit log isn't synced to the
backend yet (see `backend/README.md` for the exact list) — it works fully locally, same
as always.
