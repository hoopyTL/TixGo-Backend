# TixGo Backend

[![CI](https://github.com/hoopyTL/tixgo-backend/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hoopyTL/tixgo-backend/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A TypeScript ticket-booking backend focused on inventory correctness, durable seat reservations, and safe retries under concurrent demand.

## The problem

Booking a ticket becomes more than a CRUD operation when buyers compete for the same seat, a client retries after losing a response, or a process stops before a hold expires. TixGo handles these cases through database transactions, explicit concurrency control, and recoverable reservation state.

## Highlights

- **Consistent inventory:** PostgreSQL row locks, conditional transitions, and database constraints coordinate competing holds, confirmations, and cancellations.
- **Durable reservations:** seat holds survive API and Redis restarts; a separate worker reclaims expired holds from PostgreSQL.
- **Safe retries:** user-scoped idempotency keys and payload hashes replay committed booking results without creating another booking.
- **Resource-level access:** current database roles and ownership checks protect organizer actions and private booking resources.
- **Exact money and stable pagination:** decimal prices and a keyset-paginated event catalog backed by a composite index.
- **Reproducible verification:** real database tests, crash/restart scenarios, multi-process load labs, CI, and container runtime checks.

## Architecture

TixGo is a monolith with two entry points: an HTTP API and a reservation expiry worker. Both share the domain model and PostgreSQL database.

```mermaid
flowchart LR
    Client[API client] --> API[Express API]
    API --> DB[(PostgreSQL)]
    Worker[Expiry worker] --> DB
    API -.->|Post-commit cache updates| Redis[(Redis)]
    Worker -.->|Post-commit cache cleanup| Redis
```

**PostgreSQL is the source of truth.** Redis stores best-effort reservation cache updates after commit; it is not consulted to grant a seat. Cache loss or an outage does not invalidate a database-backed hold. The worker polls PostgreSQL rather than relying on Redis expiry notifications.

| Layer | Technology |
| --- | --- |
| Application | Node.js 22, TypeScript, Express, Zod |
| Persistence | PostgreSQL, Prisma, explicit SQL locking |
| Authentication | JWT, bcrypt, role and ownership policies |
| Cache | Redis |
| Verification and delivery | Mocha, Supertest, Postman/Newman, k6, Docker, GitHub Actions |

### Booking lifecycle

```text
Available seat → HELD reservation → CONFIRMED booking → CANCELLED booking
                       ↓
                RELEASED / EXPIRED
```

A hold reserves one seat for 300 seconds by default and decrements inventory. Confirmation creates the booking without decrementing again. Release, expiry, and cancellation restore inventory only when their state transition succeeds.

The invariant at committed states is:

```text
remaining tickets + HELD reservations + CONFIRMED bookings = total tickets
```

Expired holds count until reclaimed. Transactions coordinate all writers, and confirmation checks the database clock after acquiring locks. Booking data and its idempotent replay result commit together.

## Verification

The [verified main CI baseline](https://github.com/hoopyTL/TixGo-Backend/actions/runs/40176096220) from **25 October 2026** passed eight gates: generation, syntax, types, smoke, integration, reservation/recovery, SQL, and Postman.

| Scenario | Recorded result |
| --- | --- |
| Backend regression | 113 tests passed, plus SQL checks and 12 Postman assertions |
| Booking contention | One- and two-API-process scenarios each confirmed 100 distinct seats with consistent final inventory |
| Recovery | API/worker crash, Redis outage, migration, and dump/restore scenarios passed |
| Container runtime | 10 checks passed on Linux/arm64, including non-root execution, booking flows, expiry, and shutdown |

Load scenarios used 100 virtual users: 5,000 confirmation requests or 5,000 holds plus 100 winning confirmations. These results establish correctness for the tested workloads, rather than production throughput or availability guarantees.

## Getting started

Requires **Node.js 22**, npm, and Docker with Compose. From the repository root:

```bash
npm ci --ignore-scripts
test -f .env || cp .env.example .env
```

Set a long, random `JWT_SECRET` in `.env` and review the database URL. For existing data, back up the database and stop all writers before applying migrations.

```bash
docker compose up -d db redis
npx prisma generate
npx prisma migrate deploy
npm run dev
```

The API listens on `http://localhost:3000`; `GET /health` reports HTTP liveness. Run background expiry recovery in another terminal:

```bash
npm run build
npm run worker:reservations
```

Use the tracked [Postman collection](tests/postman/booking-reservations.postman_collection.json) to exercise the reservation workflow. Configuration defaults are listed in [.env.example](.env.example).

## Developer reference

<details>
<summary>API workflow and access policies</summary>

Register and log in through `/auth/register` and `/auth/login`, then use a Bearer access token for protected routes. Signup creates a buyer; organizer/admin provisioning is outside the public API.

| Resource | Operations |
| --- | --- |
| Events | `GET /events`, `POST /events`, `PATCH /events/:id` |
| Seats | `GET /events/:id/seats` |
| Holds | `POST /bookings/hold`, `GET /bookings/holds/:id`, `DELETE /bookings/holds/:id` |
| Bookings | `POST /bookings`, `GET /bookings/:id`, `POST /bookings/:id/cancel` |

Choose an available seat, generate a reservation UUID, and send `{ eventId, seatId, reservationId }` to the hold endpoint. Confirm through `POST /bookings` with the same body and an `Idempotency-Key`. Retry unchanged after an unknown outcome; a committed replay returns the original booking. Read the booking endpoint for current state after cancellation.

Organizers create their own Events; admins specify an existing organizer. Event edits require owner/admin access. Booking reads/cancellations require booking owner/admin access; hold reads/releases remain owner-only. Business permissions use the current database role, while `/auth/me` returns signed token claims.

Prices are decimal strings such as `"100000.00"`. The catalog returns a public array; pass `X-Next-Cursor` back as the `cursor` query parameter for the next page. PATCH does not change ownership or inventory.

Application errors use a shared JSON contract, including unknown routes and JSON parser failures:

```json
{
  "message": "Seat is unavailable",
  "code": "SEAT_UNAVAILABLE"
}
```

Error bodies contain exactly `message` and `code`, matching the names used by `AppError`. Use `code` for client decisions. Zod validation remains enabled; invalid input returns `400/VALIDATION_ERROR` with a generic message. Existing booking codes remain at the top level. Login throttling returns `429/TOO_MANY_REQUESTS` with `Retry-After`; exhausted booking retries return `503/BOOKING_BUSY` with `Retry-After: 1`. Unexpected errors return a safe `500/INTERNAL_ERROR` without internal diagnostics. HEAD responses have no body, and failures after headers are sent cannot be replaced with a JSON response.

The global error middleware preserves valid HTTP error statuses from `statusCode` or `status` (integers 400–599; `statusCode` takes precedence). Non-`AppError` failures use generic responses: `REQUEST_ERROR` / `Request failed` for 4xx and `INTERNAL_ERROR` / `Internal server error` for 5xx. For example, malformed JSON returns 400 and oversized bodies return 413, both with `REQUEST_ERROR`. Invalid or missing statuses fall back to 500. Async controllers are wrapped with `asyncHandler`; it is exported alongside `notFound` and `errorHandler` from `src/middlewares/error.middleware.ts`.

</details>

<details>
<summary>Tests and local CI</summary>

```bash
npm run typecheck
npm run lint
npm test
```

`lint` checks JavaScript/Bash syntax. The smoke suite does not need a database connection. For the full pipeline:

```bash
docker compose --profile test up -d --wait test-db test-redis
export TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/tixgo_test
export TEST_REDIS_URL=redis://127.0.0.1:56379
npm run test:ci
```

Database suites require a `_test` database and use isolated schemas. Reservation tests deliberately restart test Redis, so run them sequentially without unrelated users of that service. CI logs and summaries are written to `artifacts/ci`.

For load scenarios, install k6 and use `npm run test:booking:load`. The controlled race lab and screenshot prerequisites are described in the [concurrency lab guide](tests/lab/README.md). Load and image tests are separate from the default CI pipeline.

</details>

<details>
<summary>Container and migration notes</summary>

The [Dockerfile](Dockerfile) provides development, migration, and runtime targets. API and worker share the compiled, non-root runtime image; the migration target carries Prisma CLI separately. [Production Compose](compose.production.yml) applies read-only filesystems, dropped capabilities, and graceful stop settings.

Build and tag images from an identified source revision. Provision the external network and runtime database/Redis URLs before using production Compose; it does not provision or migrate the database. Verify built runtime/migration images with `npm run test:image`, supplying `IMAGE_REF` and `MIGRATION_IMAGE_REF`.

Use `prisma migrate deploy`: SQL migrations include constraints, triggers, and legacy backfill not reproduced by `db push`. Stop old writers before the reservation cutover. After new holds exist, reverting application code alone to the previous inventory semantics is unsafe; recovery requires a verified restore or a designed compensating migration.

</details>

## Scope

The current implementation covers single-seat reservations and bookings. Payment/refunds, message-broker workflows, full observability, and verified production deployment are future work. The login limiter is process-local, `/health` is liveness only, and passing tests do not imply a vulnerability-free image.

## Contributing

Report bugs or propose changes through [GitHub Issues](https://github.com/hoopyTL/tixgo-backend/issues). For booking changes, include the affected invariant and a reproducible test. Keep credentials and generated artifacts out of changesets.

## License

[MIT](LICENSE). Existing notices from the original GitLab Node.js/Express template are retained.
