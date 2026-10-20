-- Full-store backups: a complete, compressed copy of everything on a device (every table, including the audit
-- log and stock ledger), uploaded on a schedule. This is the safety net *behind* the change-by-change sync:
-- it also covers anything created while sync was off, and gives you point-in-time versions to restore.
--
-- payload is gzip(JSON). Old versions are pruned by the API after each upload (see backups.controller.ts),
-- so the table does not grow without bound on Neon's storage.

CREATE TABLE IF NOT EXISTS backups (
  id          BIGSERIAL PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT,
  device      TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'auto' CHECK (kind IN ('auto', 'manual')),
  checksum    TEXT NOT NULL,            -- sha-256 (hex) of the uncompressed data, to skip identical uploads
  size_bytes  INTEGER NOT NULL,         -- compressed size
  raw_bytes   INTEGER NOT NULL DEFAULT 0,
  counts      JSONB NOT NULL DEFAULT '{}',
  payload     BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_store_time ON backups (store_id, created_at DESC);
