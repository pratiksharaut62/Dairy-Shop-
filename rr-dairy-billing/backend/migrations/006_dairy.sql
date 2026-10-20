-- Dairy ERP: farmers, milk collection, rate charts, farmer ledger and settlements, lots with expiry, production
-- batches, deliveries and approved wastage. Idempotent like the earlier migrations (safe to re-run).

-- Quantities become fractional: litres and kilograms are not whole numbers.
ALTER TABLE variants       ALTER COLUMN stock        TYPE NUMERIC(12,3);
ALTER TABLE stock_moves    ALTER COLUMN qty          TYPE NUMERIC(12,3);
ALTER TABLE purchase_items ALTER COLUMN qty          TYPE NUMERIC(12,3);
ALTER TABLE bill_items     ALTER COLUMN qty          TYPE NUMERIC(12,3);
ALTER TABLE bill_items     ALTER COLUMN returned_qty TYPE NUMERIC(12,3);

-- New kinds of stock movement.
ALTER TABLE stock_moves DROP CONSTRAINT IF EXISTS stock_moves_type_check;
ALTER TABLE stock_moves ADD CONSTRAINT stock_moves_type_check
  CHECK (type IN ('opening','purchase','sale','return','adjust','audit','transfer','collection','production','receipt','wastage'));

-- Dairy product attributes: unit, shelf life, and the product's own GST rate (NULL = use the store's price slabs).
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit            TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS shelf_life_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_rate        NUMERIC(5,2);

CREATE TABLE IF NOT EXISTS farmers (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL DEFAULT '',
  village         TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  milk_type       TEXT NOT NULL DEFAULT 'cow' CHECK (milk_type IN ('cow','buffalo','mixed')),
  payout_details  TEXT NOT NULL DEFAULT '',
  opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      BIGINT NOT NULL,
  UNIQUE (store_id, code)
);
CREATE INDEX IF NOT EXISTS idx_farmers_store ON farmers (store_id);

CREATE TABLE IF NOT EXISTS rate_charts (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  milk_type      TEXT NOT NULL CHECK (milk_type IN ('cow','buffalo','mixed')),
  effective_from BIGINT NOT NULL,
  slabs          JSONB NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     BIGINT NOT NULL,
  created_by     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rate_charts_store ON rate_charts (store_id, milk_type, effective_from);

CREATE TABLE IF NOT EXISTS milk_collections (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  no             TEXT NOT NULL,
  farmer_id      TEXT NOT NULL REFERENCES farmers(id),
  date           BIGINT NOT NULL,
  session        TEXT NOT NULL CHECK (session IN ('morning','evening')),
  milk_type      TEXT NOT NULL CHECK (milk_type IN ('cow','buffalo','mixed')),
  qty_l          NUMERIC(12,2) NOT NULL CHECK (qty_l > 0),
  fat            NUMERIC(5,2) NOT NULL,
  snf            NUMERIC(5,2) NOT NULL,
  rate           NUMERIC(10,2) NOT NULL,
  amount         NUMERIC(12,2) NOT NULL,
  chart_id       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note           TEXT NOT NULL DEFAULT '',
  collected_by   TEXT NOT NULL DEFAULT '',
  decided_by     TEXT,
  decided_at     BIGINT,
  reject_reason  TEXT,
  variant_id     TEXT REFERENCES variants(id),
  lot_expires_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_collections_store_date ON milk_collections (store_id, date);
CREATE INDEX IF NOT EXISTS idx_collections_farmer ON milk_collections (farmer_id, date);
CREATE INDEX IF NOT EXISTS idx_collections_status ON milk_collections (store_id, status);

-- Positive = owed to the farmer, negative = paid out / recovered.
CREATE TABLE IF NOT EXISTS farmer_ledger (
  id        TEXT PRIMARY KEY,
  store_id  TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  farmer_id TEXT NOT NULL REFERENCES farmers(id),
  at        BIGINT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('opening','collection','advance','deduction','settlement')),
  amount    NUMERIC(12,2) NOT NULL,
  ref       TEXT NOT NULL DEFAULT '',
  note      TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ledger_farmer ON farmer_ledger (farmer_id, at);
CREATE INDEX IF NOT EXISTS idx_ledger_store ON farmer_ledger (store_id);

CREATE TABLE IF NOT EXISTS farmer_settlements (
  id                TEXT PRIMARY KEY,
  store_id          TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  no                TEXT NOT NULL,
  farmer_id         TEXT NOT NULL REFERENCES farmers(id),
  period_from       BIGINT NOT NULL,
  period_to         BIGINT NOT NULL,
  litres            NUMERIC(12,2) NOT NULL DEFAULT 0,
  collection_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  advances          NUMERIC(12,2) NOT NULL DEFAULT 0,
  deductions        NUMERIC(12,2) NOT NULL DEFAULT 0,
  payable           NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid              NUMERIC(12,2) NOT NULL CHECK (paid > 0),
  mode              TEXT NOT NULL CHECK (mode IN ('cash','upi','bank')),
  ref               TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT '',
  paid_at           BIGINT NOT NULL,
  user_id           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_settlements_farmer ON farmer_settlements (farmer_id, paid_at);

CREATE TABLE IF NOT EXISTS lots (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  variant_id  TEXT NOT NULL REFERENCES variants(id),
  lot_no      TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('collection','production','receipt')),
  source_ref  TEXT NOT NULL DEFAULT '',
  qty         NUMERIC(12,3) NOT NULL,
  available   NUMERIC(12,3) NOT NULL CHECK (available >= 0),
  produced_at BIGINT NOT NULL,
  expires_at  BIGINT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lots_variant ON lots (variant_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_lots_store_expiry ON lots (store_id, expires_at);

CREATE TABLE IF NOT EXISTS production_batches (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  no           TEXT NOT NULL,
  started_at   BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'in-progress' CHECK (status IN ('in-progress','completed','rejected')),
  inputs       JSONB NOT NULL DEFAULT '[]',
  outputs      JSONB NOT NULL DEFAULT '[]',
  notes        TEXT NOT NULL DEFAULT '',
  qc_note      TEXT NOT NULL DEFAULT '',
  completed_at BIGINT,
  user_id      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_batches_store ON production_batches (store_id, started_at);

CREATE TABLE IF NOT EXISTS deliveries (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  no           TEXT NOT NULL,
  customer_id  TEXT,
  bill_id      TEXT,
  route        TEXT NOT NULL DEFAULT '',
  vehicle      TEXT NOT NULL DEFAULT '',
  driver       TEXT NOT NULL DEFAULT '',
  scheduled_at BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'packed' CHECK (status IN ('packed','dispatched','delivered','failed')),
  items        JSONB NOT NULL DEFAULT '[]',
  notes        TEXT NOT NULL DEFAULT '',
  delivered_at BIGINT,
  created_at   BIGINT NOT NULL,
  user_id      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_deliveries_store ON deliveries (store_id, scheduled_at);

CREATE TABLE IF NOT EXISTS wastage (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  no           TEXT NOT NULL,
  variant_id   TEXT NOT NULL REFERENCES variants(id),
  lot_id       TEXT,
  qty          NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  reason       TEXT NOT NULL CHECK (reason IN ('wastage','damage','expiry','spillage','sample')),
  note         TEXT NOT NULL DEFAULT '',
  value        NUMERIC(12,2) NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  at           BIGINT NOT NULL,
  requested_by TEXT NOT NULL DEFAULT '',
  decided_by   TEXT,
  decided_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_wastage_store ON wastage (store_id, at);

-- New stores start on a flat 5 % fallback; dairy products carry their own GST rate (products.tax_rate).
ALTER TABLE stores ALTER COLUMN slabs SET DEFAULT '[{"upto":9007199254740991,"rate":5}]';
