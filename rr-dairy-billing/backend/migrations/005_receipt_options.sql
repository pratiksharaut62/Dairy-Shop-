-- What the printed bill shows. A GST tax invoice normally carries the CGST/SGST split and an HSN summary, so those
-- are a choice the owner makes (and the A4 invoice always keeps them); the default is the cleaner receipt.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_show_tax      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_show_hsn      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_show_savings  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_show_loyalty  BOOLEAN NOT NULL DEFAULT TRUE;
