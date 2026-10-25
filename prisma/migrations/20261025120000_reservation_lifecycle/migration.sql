BEGIN;
-- Cutover requires all old API/worker writers to be stopped. Fail rather than repair history.
LOCK TABLE events, bookings, idempotency_keys IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM bookings WHERE status NOT IN ('CONFIRMED','CANCELLED')) THEN
    RAISE EXCEPTION 'Unsupported historical booking state';
  END IF;
  IF EXISTS (
    SELECT 1 FROM events e LEFT JOIN bookings b ON b.event_id=e.id AND b.status='CONFIRMED'
    GROUP BY e.id HAVING e.remain_tickets + count(b.id) <> e.total_tickets
  ) THEN RAISE EXCEPTION 'Historical booking/inventory invariant is inconsistent'; END IF;
END $$;

CREATE TABLE seats (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  CONSTRAINT seats_event_id_number_key UNIQUE(event_id,number),
  CONSTRAINT seats_id_event_id_key UNIQUE(id,event_id)
);
CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  seat_id TEXT NOT NULL REFERENCES seats(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status TEXT NOT NULL DEFAULT 'HELD',
  expires_at TIMESTAMPTZ(3) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT reservations_status_check CHECK (status IN ('HELD','CONFIRMED','EXPIRED','RELEASED')),
  CONSTRAINT reservations_time_check CHECK (expires_at > created_at),
  CONSTRAINT reservations_seat_event_fkey FOREIGN KEY(seat_id,event_id) REFERENCES seats(id,event_id) ON DELETE RESTRICT,
  CONSTRAINT reservations_id_user_id_event_id_seat_id_key UNIQUE(id,user_id,event_id,seat_id)
);
CREATE UNIQUE INDEX reservations_one_held_seat ON reservations(seat_id) WHERE status='HELD';
CREATE INDEX reservations_expiry_idx ON reservations(expires_at,id) WHERE status='HELD';
CREATE INDEX reservations_event_id_status_idx ON reservations(event_id,status);

ALTER TABLE bookings ADD COLUMN seat_id TEXT REFERENCES seats(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE bookings ADD COLUMN reservation_id TEXT REFERENCES reservations(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE idempotency_keys ADD COLUMN operation TEXT NOT NULL DEFAULT 'booking.create.v1';

-- Custom UUIDv8 formatting keeps deterministic backfill IDs valid for API UUID validators.
CREATE FUNCTION booking_migration_id(seed TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-8'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12)
  FROM (SELECT md5(seed) h) digest
$$;
INSERT INTO seats(id,event_id,number)
SELECT booking_migration_id('seat:' || e.id || ':' || n),e.id,n
FROM events e CROSS JOIN LATERAL generate_series(1,e.total_tickets) n;

-- Deterministic mapping preserves booking identity. CANCELLED legacy rows have no invented seat history.
WITH numbered AS (
 SELECT b.*,row_number() OVER(PARTITION BY event_id ORDER BY created_at,id) AS seat_number
 FROM bookings b WHERE status='CONFIRMED'
)
INSERT INTO reservations(id,user_id,event_id,seat_id,status,created_at,expires_at,updated_at)
SELECT booking_migration_id('reservation:' || b.id),b.user_id,b.event_id,s.id,'CONFIRMED',
 b.created_at AT TIME ZONE 'UTC',(b.created_at AT TIME ZONE 'UTC')+interval '300 seconds',
 b.created_at AT TIME ZONE 'UTC'
FROM numbered b JOIN seats s ON s.event_id=b.event_id AND s.number=b.seat_number;

UPDATE bookings b SET reservation_id=r.id,seat_id=r.seat_id
FROM reservations r WHERE r.id=booking_migration_id('reservation:' || b.id) AND b.status='CONFIRMED';
DROP FUNCTION booking_migration_id(TEXT);

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK(status IN ('CONFIRMED','CANCELLED'));
ALTER TABLE bookings ADD CONSTRAINT bookings_reservation_presence_check CHECK (
 (seat_id IS NOT NULL AND reservation_id IS NOT NULL) OR
 (status='CANCELLED' AND seat_id IS NULL AND reservation_id IS NULL)
);
ALTER TABLE bookings ADD CONSTRAINT bookings_reservation_identity_fkey
 FOREIGN KEY(reservation_id,user_id,event_id,seat_id) REFERENCES reservations(id,user_id,event_id,seat_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX bookings_reservation_id_key ON bookings(reservation_id);
CREATE UNIQUE INDEX bookings_one_confirmed_seat ON bookings(seat_id) WHERE status='CONFIRMED';
COMMIT;
