BEGIN;

-- Keep preflight and the type rewrite atomic; never round invalid legacy prices.
LOCK TABLE "events" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "events"
    WHERE CASE
      WHEN "price"::text IN ('NaN', 'Infinity', '-Infinity') THEN TRUE
      ELSE "price" < 0
        OR "price"::text::numeric > 9999999999.99
        OR "price"::text::numeric <> trunc("price"::text::numeric, 2)
    END
  ) THEN
    RAISE EXCEPTION 'Legacy event price cannot be represented exactly as NUMERIC(12,2); review the price exceptions before migration'
      USING ERRCODE = '23514';
  END IF;
END $$;

ALTER TABLE "events" ALTER COLUMN "price" TYPE NUMERIC(12,2)
  USING "price"::text::numeric(12,2);
ALTER TABLE "events" ADD CONSTRAINT "events_price_nonnegative"
  CHECK ("price" >= 0 AND "price" <= 9999999999.99);

-- Matches the public keyset catalog ordering, including equal-time tie breaking.
CREATE INDEX "events_created_at_id_idx" ON "events"("created_at" DESC, "id" DESC);

COMMIT;
