BEGIN;

-- Freeze writers during preflight and DDL; never repair historical inventory here.
LOCK TABLE "events" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "events"
    WHERE "total_tickets" <= 0 OR "remain_tickets" < 0
       OR "remain_tickets" > "total_tickets"
  ) THEN
    RAISE EXCEPTION 'Invalid legacy event inventory; inventory exceptions must be reviewed before migration'
      USING ERRCODE = '23514';
  END IF;
END $$;

-- NULL is retained only for existing events; ownership is never inferred from bookings.
ALTER TABLE "events" ADD COLUMN "organizer_id" TEXT;
CREATE INDEX "events_organizer_id_idx" ON "events"("organizer_id");
ALTER TABLE "events" ADD CONSTRAINT "events_organizer_id_fkey"
  FOREIGN KEY ("organizer_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_total_tickets_positive"
  CHECK ("total_tickets" > 0);
ALTER TABLE "events" ADD CONSTRAINT "events_inventory_bounds"
  CHECK ("remain_tickets" >= 0 AND "remain_tickets" <= "total_tickets");

-- A global NOT NULL would reject legacy rows; protect new writes with a trigger.
CREATE FUNCTION require_event_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organizer_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'New events require an organizer' USING ERRCODE = '23502';
    ELSIF OLD.organizer_id IS NOT NULL THEN
      RAISE EXCEPTION 'Event ownership cannot be cleared' USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER events_require_owner BEFORE INSERT OR UPDATE OF organizer_id ON "events"
  FOR EACH ROW EXECUTE FUNCTION require_event_owner();

COMMIT;
