-- Krishna Collection — PostgreSQL schema (Neon).
--
-- Mirrors the client's IndexedDB model (src/db/types.ts) table-for-table so the
-- offline sync is a straight mapping. Every table carries store_id: isolation
-- between tenants is enforced in the API layer (every query is scoped by the
-- store_id in the caller's JWT).
--
-- IDs are TEXT generated client-side (src/lib/id.ts) so a record has its ID
-- before it ever reaches the server and sync is a plain upsert.
-- Money is NUMERIC, never float. Dates are BIGINT epoch millis, matching
-- Date.now() on the client — no timezone conversion in either direction.

CREATE TABLE IF NOT EXISTS stores (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  tagline                   TEXT NOT NULL DEFAULT '',
  address                   TEXT NOT NULL DEFAULT '',
  city                      TEXT NOT NULL DEFAULT '',
  phone                     TEXT NOT NULL DEFAULT '',
  email                     TEXT NOT NULL DEFAULT '',
  gstin                     TEXT NOT NULL DEFAULT '',
  invoice_prefix            TEXT NOT NULL DEFAULT 'INV-',
  next_invoice_no           INTEGER NOT NULL DEFAULT 1,
  slabs                     JSONB NOT NULL DEFAULT '[{"upto":1000,"rate":5},{"upto":9007199254740991,"rate":12}]',
  price_includes_tax        BOOLEAN NOT NULL DEFAULT TRUE,
  receipt_width             TEXT NOT NULL DEFAULT '80mm' CHECK (receipt_width IN ('58mm','80mm')),
  return_policy             TEXT NOT NULL DEFAULT '',
  footer_note               TEXT NOT NULL DEFAULT '',
  loyalty_earn_pct          NUMERIC(6,2) NOT NULL DEFAULT 0,
  loyalty_redeem_value      NUMERIC(10,2) NOT NULL DEFAULT 0,
  max_cashier_discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 10,
  low_stock_default         INTEGER NOT NULL DEFAULT 3,
  plan                      TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial','active','suspended')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  store_id              TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  pin_hash              TEXT NOT NULL,
  -- Web login (email + password). Optional: cashiers normally only use the PIN at the counter.
  email                 TEXT,
  password_hash         TEXT,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_store ON users (store_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (lower(email)) WHERE email IS NOT NULL;

-- Category ids are the client's static ids (cat_mshirt, ...) which every tenant shares,
-- so uniqueness is per store, and products reference them without a cross-table FK.
CREATE TABLE IF NOT EXISTS categories (
  id              TEXT NOT NULL,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  category_group  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (store_id, id)
);
CREATE INDEX IF NOT EXISTS idx_categories_store ON categories (store_id);

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  style_code   TEXT NOT NULL,
  name         TEXT NOT NULL,
  category_id  TEXT,
  brand        TEXT NOT NULL DEFAULT '',
  fabric       TEXT NOT NULL DEFAULT '',
  season       TEXT NOT NULL DEFAULT '',
  hsn          TEXT NOT NULL DEFAULT '',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   BIGINT NOT NULL,
  UNIQUE (store_id, style_code)
);
CREATE INDEX IF NOT EXISTS idx_products_store ON products (store_id);

CREATE TABLE IF NOT EXISTS variants (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku            TEXT NOT NULL,
  barcode        TEXT NOT NULL,
  size           TEXT NOT NULL,
  color          TEXT NOT NULL,
  cost           NUMERIC(10,2) NOT NULL DEFAULT 0,
  mrp            NUMERIC(10,2) NOT NULL DEFAULT 0,
  price          NUMERIC(10,2) NOT NULL DEFAULT 0,
  stock          INTEGER NOT NULL DEFAULT 0,
  reorder_level  INTEGER NOT NULL DEFAULT 3,
  UNIQUE (store_id, barcode),
  UNIQUE (store_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_variants_store ON variants (store_id);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants (product_id);

CREATE TABLE IF NOT EXISTS suppliers (
  id               TEXT PRIMARY KEY,
  store_id         TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL DEFAULT '',
  gstin            TEXT NOT NULL DEFAULT '',
  address          TEXT NOT NULL DEFAULT '',
  opening_balance  NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_suppliers_store ON suppliers (store_id);

CREATE TABLE IF NOT EXISTS purchases (
  id            TEXT PRIMARY KEY,
  store_id      TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  no            TEXT NOT NULL,
  supplier_id   TEXT NOT NULL REFERENCES suppliers(id),
  date          BIGINT NOT NULL,
  invoice_ref   TEXT NOT NULL DEFAULT '',
  total         NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid          NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes         TEXT,
  user_id       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchases_store ON purchases (store_id, date);

CREATE TABLE IF NOT EXISTS purchase_items (
  id           BIGSERIAL PRIMARY KEY,
  purchase_id  TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  variant_id   TEXT NOT NULL REFERENCES variants(id),
  qty          INTEGER NOT NULL,
  cost         NUMERIC(10,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pitems_purchase ON purchase_items (purchase_id);

CREATE TABLE IF NOT EXISTS customers (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  dob             TEXT NOT NULL DEFAULT '',
  anniversary     TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  gstin           TEXT NOT NULL DEFAULT '',
  loyalty_points  INTEGER NOT NULL DEFAULT 0,
  store_credit    NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  notes           TEXT,
  UNIQUE (store_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_customers_store ON customers (store_id);

CREATE TABLE IF NOT EXISTS bills (
  id                    TEXT PRIMARY KEY,
  store_id              TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  no                    TEXT NOT NULL,
  date                  BIGINT NOT NULL,
  customer_id           TEXT REFERENCES customers(id),
  gross_mrp             NUMERIC(12,2) NOT NULL DEFAULT 0,
  item_discount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  bill_discount_type    TEXT NOT NULL DEFAULT 'amt' CHECK (bill_discount_type IN ('pct','amt')),
  bill_discount_value   NUMERIC(10,2) NOT NULL DEFAULT 0,
  bill_discount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  coupon                TEXT NOT NULL DEFAULT '',
  subtotal              NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable_total         NUMERIC(12,2) NOT NULL DEFAULT 0,
  cgst_total            NUMERIC(12,2) NOT NULL DEFAULT 0,
  sgst_total            NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_total             NUMERIC(12,2) NOT NULL DEFAULT 0,
  round_off             NUMERIC(6,2) NOT NULL DEFAULT 0,
  total                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid                  NUMERIC(12,2) NOT NULL DEFAULT 0,
  change_due            NUMERIC(12,2) NOT NULL DEFAULT 0,
  loyalty_earned        INTEGER NOT NULL DEFAULT 0,
  loyalty_redeemed      INTEGER NOT NULL DEFAULT 0,
  credit_used           NUMERIC(12,2) NOT NULL DEFAULT 0,
  cashier_id            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','held','returned','partial-return')),
  refund_of_bill_id     TEXT REFERENCES bills(id),
  refund_amount         NUMERIC(12,2),
  notes                 TEXT,
  UNIQUE (store_id, no)
);
CREATE INDEX IF NOT EXISTS idx_bills_store_date ON bills (store_id, date);

CREATE TABLE IF NOT EXISTS bill_items (
  id                BIGSERIAL PRIMARY KEY,
  bill_id           TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  variant_id        TEXT NOT NULL REFERENCES variants(id),
  -- Snapshot of the product at sale time: a historical bill must read the same
  -- way even if the product is renamed or repriced later.
  sku               TEXT NOT NULL,
  barcode           TEXT NOT NULL,
  name              TEXT NOT NULL,
  size              TEXT NOT NULL,
  color             TEXT NOT NULL,
  hsn               TEXT NOT NULL DEFAULT '',
  qty               INTEGER NOT NULL,
  mrp               NUMERIC(10,2) NOT NULL DEFAULT 0,
  price             NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_type     TEXT NOT NULL DEFAULT 'amt' CHECK (discount_type IN ('pct','amt')),
  discount_value    NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_amount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  net               NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxable           NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_rate          NUMERIC(5,2) NOT NULL DEFAULT 0,
  cgst              NUMERIC(10,2) NOT NULL DEFAULT 0,
  sgst              NUMERIC(10,2) NOT NULL DEFAULT 0,
  line_total        NUMERIC(12,2) NOT NULL DEFAULT 0,
  returned_qty      INTEGER NOT NULL DEFAULT 0,
  price_overridden  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_bitems_bill ON bill_items (bill_id);

CREATE TABLE IF NOT EXISTS bill_payments (
  id       BIGSERIAL PRIMARY KEY,
  bill_id  TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  mode     TEXT NOT NULL CHECK (mode IN ('cash','card','upi','credit')),
  amount   NUMERIC(12,2) NOT NULL,
  ref      TEXT
);
CREATE INDEX IF NOT EXISTS idx_bpay_bill ON bill_payments (bill_id);

CREATE TABLE IF NOT EXISTS stock_moves (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  variant_id  TEXT NOT NULL REFERENCES variants(id),
  qty         INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('opening','purchase','sale','return','adjust','audit','transfer')),
  ref         TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  at          BIGINT NOT NULL,
  user_id     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_store ON stock_moves (store_id, at);
CREATE INDEX IF NOT EXISTS idx_moves_variant ON stock_moves (variant_id, at);

CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  date        BIGINT NOT NULL,
  category    TEXT NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('cash','card','upi','bank')),
  vendor      TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  recurring   BOOLEAN NOT NULL DEFAULT FALSE,
  user_id     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_store_date ON expenses (store_id, date);

CREATE TABLE IF NOT EXISTS audit_log (
  id        TEXT PRIMARY KEY,
  store_id  TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  at        BIGINT NOT NULL,
  user_id   TEXT NOT NULL,
  action    TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_store ON audit_log (store_id, at);

CREATE TABLE IF NOT EXISTS day_sessions (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  opened_at      BIGINT NOT NULL,
  opened_by      TEXT NOT NULL,
  opening_cash   NUMERIC(12,2) NOT NULL DEFAULT 0,
  closed_at      BIGINT,
  closed_by      TEXT,
  counted_cash   NUMERIC(12,2),
  expected_cash  NUMERIC(12,2),
  variance       NUMERIC(12,2),
  note           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_store ON day_sessions (store_id, opened_at);
