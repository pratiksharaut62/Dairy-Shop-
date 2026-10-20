-- GST on apparel changed on 22 September 2025: 5% up to Rs 2,500 per piece, 18% above (the 12% band is gone).
-- New stores start on the current slabs. A store that is still on the *old unmodified default* is moved to the new
-- one; a store whose owner has set their own slabs is left exactly as it is.
ALTER TABLE stores
  ALTER COLUMN slabs SET DEFAULT '[{"upto":2500,"rate":5},{"upto":9007199254740991,"rate":18}]';

UPDATE stores
   SET slabs = '[{"upto":2500,"rate":5},{"upto":9007199254740991,"rate":18}]'::jsonb
 WHERE slabs = '[{"upto":1000,"rate":5},{"upto":9007199254740991,"rate":12}]'::jsonb;
