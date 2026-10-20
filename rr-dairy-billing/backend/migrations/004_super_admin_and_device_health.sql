-- Super admin: the developer / support account that can see every store's health. It is a flag on a user, and it can
-- only be set directly in the database (npm run super-admin) — there is deliberately no API or screen that grants it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- What each device last told us about its own sync and backups. The devices run on the shop's PC, which we cannot
-- reach, so they report in: one row per device, replaced on every report. `payload` holds the counters and the
-- reasons (never bill contents).
CREATE TABLE IF NOT EXISTS device_health (
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  user_id      TEXT,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload      JSONB NOT NULL,
  PRIMARY KEY (store_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_device_health_reported ON device_health (reported_at DESC);
