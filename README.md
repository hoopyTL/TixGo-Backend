# TixGo

Backend Express + TypeScript + Prisma + PostgreSQL, kèm giao diện test nội bộ để thử luồng tài khoản → sự kiện → đặt vé.

## Chạy tại máy

Yêu cầu: Node.js 22 trở lên, npm, Docker Desktop đang chạy.

```bash
npm ci
test -f .env || cp .env.example .env
```

Nếu đã có `.env`, giữ file đó và kiểm tra `DATABASE_URL`, `JWT_SECRET`. Đổi `JWT_SECRET` trong file mẫu trước khi dùng.

```bash
docker compose up -d db redis
npx prisma generate
# Stop all API/worker writers and back up existing data before this migration.
npx prisma migrate deploy
npm run dev
```

API mặc định tại `http://localhost:3000`. Dùng Postman collection `tests/postman/booking-reservations.postman_collection.json` để thực hành luồng giữ chỗ → xác nhận → hủy. PostgreSQL lưu trạng thái chính thức; Redis là cache tùy chọn, không quyết định quyền mua.

Mỗi lần mua bắt đầu bằng `POST /bookings/hold` với `{ eventId, seatId, reservationId }`;
client tạo UUID mới cho reservation. Hold giảm một vé, mặc định 300 giây. Confirm
`POST /bookings` gửi cùng ba field và `Idempotency-Key` mới; không giảm tồn thêm.

- Hold mới / confirm mới: `201`; retry hold còn hạn: `200`, không gia hạn.
- Confirm replay: `200`, `Idempotent-Replayed: true`, cùng booking ID.
- Cùng user/key khác operation hoặc payload: `400`.
- Ghế bị chiếm / đã confirm / hết hạn: `409` với `code` phân biệt.
- Chờ khóa hết ngân sách: `503 BOOKING_BUSY` và `Retry-After: 1`; retry cùng identity.

Key/result lưu bền vững trong cùng transaction với booking, PK `(userId,key)`;
fingerprint chứa operation `booking.confirm.v2` và payload canonical. Chặng này
không tự xóa key; retention bằng vòng đời dữ liệu lab, gồm sau cancel/restart.
Cùng key đang chạy chờ advisory lock có giới hạn; record `PROCESSING` đã commit
trả `409 REQUEST_IN_PROGRESS`. Không tạo key mới khi outcome chưa rõ.

Request cũ chỉ có `{eventId}` chỉ được **replay kết quả legacy đã commit** với
operation `booking.create.v1`; không còn tạo booking trực tiếp. Key cũ dùng payload
mới bị mismatch. Cached response giữ snapshot lịch sử, GET booking đọc hiện tại.

Giao diện test nội bộ trong working tree local có thể chưa theo contract hold;
Postman và test scripts là đường kiểm chứng reservation được hỗ trợ. UI/wiring
nội bộ không là dependency của checkout backend dùng để chạy lại.

## Ownership migration

Migration mới giữ nguyên owner NULL cho Event lịch sử; Event mới bắt buộc có owner qua trigger DB. FK chặn xóa owner đang được tham chiếu; CHECK chặn sức chứa không dương hoặc tồn ngoài khoảng. Nếu inventory cũ sai, migration dừng và rollback, không tự sửa tồn/booking. Kiểm kê và xử lý ngoại lệ trước khi triển khai; không dùng `db push` để thay migration vì trigger/CHECK nằm trong SQL.

Create không có idempotency: retry sau mất response có thể tạo Event trùng. API quản trị role, claim/transfer và xóa Event chưa được bổ sung. Luồng cập nhật metadata qua `PATCH /events/:id` được mô tả riêng bên dưới.

## Kiểm tra

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` build TypeScript và chạy smoke test với API thật qua Supertest, không cần kết nối database. `lint` kiểm tra cú pháp JavaScript/Bash; `typecheck` kiểm tra TypeScript. Project chưa cấu hình ESLint.

Integration test dùng PostgreSQL riêng trên cổng `55432`:

```bash
docker compose --profile test up -d --wait test-db test-redis
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/tixgo_test npm run test:integration
```

Test bắt buộc database có tên kết thúc bằng `_test`, tạo schema ngẫu nhiên, áp dụng migration rồi xóa schema đó sau khi chạy. Không dùng database từ `.env` để kiểm thử integration. Test kiểm tra auth, current role/ownership, money, cursor, cancellation/rollback, replay, mismatch, key giữa các user và request đồng thời. Login limiter có thêm HTTP tests không cần DB.

Bài thực hành SQL và query plan dùng cùng DB test riêng, tự tạo/xóa schema:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/tixgo_test npm run test:sql
```

Script kiểm chứng money migration, JOIN/FK/unique/CHECK và seed 50.000 Event để so EXPLAIN ANALYZE trước/sau index. `SQL_EVIDENCE_DIR` tùy chọn lưu JSON plans vào thư mục local.

Dừng database kiểm thử sau khi dùng:

```bash
docker compose --profile test stop test-db test-redis
```

## Giá, catalog và quyền trên tài nguyên

`price` lưu bằng PostgreSQL `NUMERIC(12,2)`, API trả chuỗi như `"100000.00"`. Gửi price dạng chuỗi decimal (tối đa 2 chữ số thập phân); numeric input cũ chỉ được nhận nếu biểu diễn không cần làm tròn. Vượt `9999999999.99`, sub-cent, NaN/Infinity và exponent strings bị từ chối. Migration dừng nếu giá lịch sử không biểu diễn được, không âm thầm round.

`GET /events?limit=50` vẫn trả public array, theo `createdAt DESC, id DESC`; limit1–100, mặc định50. Khi còn trang, đọc header `X-Next-Cursor` rồi gửi `?limit=50&cursor=<value>`; khi hết trang header không có. Owner/account fields vẫn không xuất hiện.

| Endpoint | Quyền hiện hành trong DB |
| --- | --- |
| `POST /bookings` | buyer/organizer/admin, buyer identity lấy từ server |
| `GET /bookings/:id` | booking owner hoặc admin |
| `PATCH /events/:id` | organizer sở hữu Event hoặc admin; chỉ title/description/location/price |
| `POST /bookings/:id/cancel` | booking owner hoặc admin, body trống hoặc `{}` |

Object không có quyền/missing trả404; role không hợp lệ403, account bị xóa401. PATCH không nhận owner/capacity/inventory. Organizer không tự claim Event legacy thiếu owner.

Cancel chuyển CONFIRMED→CANCELLED và hoàn1vé trong cùng transaction; retry không hoàn thêm. Create replay bằng key cũ vẫn trả snapshot create gốc (có thể CONFIRMED dù booking hiện đã CANCELLED), không tạo mua mới. Dùng GET booking để đọc trạng thái hiện hành. Cancel không triển khai payment/refund.

`POST /auth/login` giới hạn5 attempts/(IP,email trim/lowercase),100/IP trong15phút; tính cả success và payload validation-invalid. Vượt giới hạn trả429 và `Retry-After`. Trust proxy mặc định false; không dùng forwarded IP do client tự khai. Store bounded/TTL trong một process, reset khi restart; multi-instance cần shared store. JSON parser từ chối malformed JSON trước router nên loại request đó không đi vào limiter.

## Kiểm tra thủ công / Postman

1. `POST /auth/register`: `{ "email": "buyer@example.com", "password": "test-password" }`.
2. `POST /auth/login` với cùng body; lấy `data.accessToken`.
3. Đăng ký một tài khoản organizer riêng qua `/auth/register`. Người quản trị lab cấp role ngoài API signup, ví dụ qua SQL console của DB lab: `UPDATE users SET role = 'organizer' WHERE id = '<registered-user-id>';` (thay placeholder bằng ID vừa đăng ký, giữ dấu nháy). Đăng nhập tài khoản đó để lấy token.
4. `POST /events` với Bearer token organizer: `{ "title": "Test event", "totalTickets": 3, "price": 100000 }`. Organizer không gửi `organizerId`. Admin phải thêm `"organizerId": "<organizer-uuid>"` của tài khoản có role organizer hiện hành.
5. Public `GET /events` không trả owner; create response có `organizerId`. `role`, `remainTickets` và trường lạ bị từ chối. `totalTickets` là số nguyên dương, tối đa `MAX_EVENT_SEATS` (mặc định 10.000). Đây là giới hạn kỹ thuật của việc tạo ghế đồng bộ; storage vẫn là PostgreSQL INTEGER. Tăng cấu hình cần đo chi phí ghi/transaction; không gửi hàng tỷ ghế trong một request.
6. Thiếu/token sai → `401`; buyer/role không được cấp quyền → `403`; owner/input sai policy → `400`; tạo thành công → `201`. Role create được đọc từ DB trong transaction, không dùng role claim cũ để quyết định quyền.
7. `GET /events/<EVENT_ID>/seats` lấy seat ID đang AVAILABLE; client tạo reservation UUID mới.
8. `POST /bookings/hold` với `{ "eventId": "<EVENT_ID>", "seatId": "<SEAT_ID>", "reservationId": "<UUID>" }` và Bearer token buyer.
9. `POST /bookings` giữ nguyên body bước 8, thêm `Idempotency-Key: <unique-key>`. Gửi lại cùng key/body để replay; lượt mua khác phải giữ chỗ mới và key mới.
10. `GET /bookings/holds/<UUID>` đọc hold; `DELETE` cùng URL nhả hold chưa confirm. `POST /bookings/<BOOKING_ID>/cancel` hủy booking đã confirm, trả lại ghế một lần.

Các script có assertion tự động (chạy với một event test riêng, không có người khác đang mua):

```bash
bash tests/idempotency.sh "$EVENT_ID" "$ACCESS_TOKEN"
bash tests/race-condition.sh "$EVENT_ID" "$ACCESS_TOKEN" 50
```

Hai script sử dụng Node.js `fetch`, trả exit code khác 0 khi kết quả sai. `BASE_URL` mặc định `http://localhost:3000`, có thể đổi bằng biến môi trường. Script tạo booking thật và tiêu thụ vé.

## Reservation, worker và phục hồi

`remainTickets + count(Reservation HELD) + count(Booking CONFIRMED) = totalTickets`.
HELD quá hạn nhưng chưa thu hồi vẫn tính trong công thức; CANCELLED không tính.
Reservation CONFIRMED là lịch sử chuyển thành booking; sau cancel vẫn CONFIRMED,
nhưng Booking CANCELLED không ngăn giữ lại ghế. Unique partial index chặn hai
HELD hoặc hai booking CONFIRMED cùng ghế; mọi writer dùng Event row lock để bảo
vệ cả hai bảng. HTTP lấy User SHARE → advisory identity → Event → Reservation →
Booking; worker Event → Reservation. Isolation READ COMMITTED.

Confirm chỉ chuyển HELD khi `expires_at > clock_timestamp()` sau khi có khóa;
bằng hạn bị từ chối. Expiry/release/cancel chỉ hoàn tồn khi transition thắng trong
cùng transaction. Worker poll PostgreSQL, không phụ thuộc Redis TTL notification.

```bash
npm run build
npm run worker:reservations
# Or use the Compose worker profile after migrations and image dependency refresh:
docker compose --profile worker up -d --build reservation-worker
```

Redis ghi cache best-effort sau commit với TTL tuyệt đối. Mất key, restart, stale
cache hoặc timeout không làm mất hold hoặc đổi quyền mua; timeout cache 250ms kể
cả lệnh đã gửi rồi chờ reply. Cache không nằm trong transaction DB. Config trong
`.env.example`: Redis URL, TTL, poll/batch, lock/transaction timeout, tối đa 3 retry
và deadline tổng. Chỉ retry contention đã phân loại; không retry lỗi nghiệp vụ.

Migration reservation phải backup và dừng toàn bộ writer cũ; backfill CONFIRMED
vào ghế/synthetic reservation, giữ ID/history/cached result; CANCELLED cũ không
có ghế giữ NULL thay vì bịa lịch sử. Invariant sai hoặc status lạ làm migration
rollback. Sau khi có dữ liệu hold mới, không rollback code đơn thuần về writer cũ:
restore snapshot lab đã kiểm chứng hoặc thiết kế migration bù. Restore snapshot
có thể mất thao tác sau mốc backup. Không dùng `prisma db push` thay SQL migration.

## Tái tạo race, tải và fault tests

Cài k6 trên máy chạy tải. Các test sau chỉ nhận database kết thúc `_test` và tạo
schema riêng; không reset DB phát triển. Redis test dùng cổng 56379, tách Redis dev.

```bash
docker compose --profile test up -d --wait test-db test-redis
export TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/tixgo_test
export TEST_REDIS_URL=redis://127.0.0.1:56379
npm run test:reservation
npm run test:postman
npm run test:booking:lab
npm run test:booking:load
```

`test:postman` chạy collection bằng Newman 6.2.1 trong cache/tool tạm (cần network lần đầu), không thêm Newman vào dependency ứng dụng.

Reservation suite gồm concurrency, rollback từng bước, legacy migration/replay,
restore `pg_dump`, lock timeout/deadlock, kill API/worker trước/sau commit và Redis
restart/treo. Test restart Redis có điều khiển: chạy suite này tuần tự, không dùng
chung Redis test cho việc khác. `pg_dump` chạy trong container test-db để trùng
major version. Lab unsafe là process riêng ở `tests/lab/`, không có route bật lỗi
trong API thật; xem README của lab cho yêu cầu Chrome screenshot và cấu hình.

Load runner chạy cả 1 và 2 API process/pool riêng, chung DB; mỗi biến thể có:

- 100 VU × 50 iteration = **5.000 confirm HTTP**, 100 reservation được giữ sẵn;
  kỳ vọng 100 create + 4.900 ALREADY_CONFIRMED, tồn 0.
- **5.000 hold + 100 confirm = 5.100 HTTP** tranh 100 ghế từ trạng thái trống;
  kỳ vọng 100 booking + 4.900 SEAT_UNAVAILABLE, tồn 0.

Auth/seed đếm riêng. Concurrency tối đa 100 VU, không phải 5.000 request đồng thời.
Raw summaries, DB snapshots, manifest/version/config/source hashes và ảnh
before/after xuất vào `docs/reports/booking-c/<run-id>/` local. Không suy kết quả DB
chỉ từ HTTP count; lỗi mạng cần reconcile bằng identity cũ. Đây là correctness
lab, chưa là kết quả benchmark production/HA/payment hoặc bảo đảm không có lỗi
ngoài các kịch bản đã kiểm chứng.


## Continuous integration

`npm run test:ci` chạy tuần tự Prisma generate, syntax/typecheck, smoke,
PostgreSQL integration, reservation/fault/migration/restore, SQL và Postman.
Lệnh dừng khi một gate lỗi và giữ exit code khác 0; không tự dựng hoặc dọn services.

```bash
npm ci --ignore-scripts
docker compose --profile test up -d --wait test-db test-redis
export TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/tixgo_test
export TEST_REDIS_URL=redis://127.0.0.1:56379
npm run test:ci
```

Dùng Node 22 như workflow/Dockerfile. Runner bắt buộc DB `_test` và Redis test
loopback cổng 56379, ép các child process dùng cấu hình test, không lấy DB dev
trong `.env`. Chạy reservation suite tuần tự vì nó chủ động restart Redis.
`CI_ARTIFACT_DIR` mặc định `artifacts/ci`; summary.json, log từng gate và evidence
được lưu ở đó. Thư mục artifact bị Git/Docker context loại.

Dependency được cài với `--ignore-scripts`; Prisma generate chạy tường minh ở
gate đầu tiên. Smoke/integration kiểm chứng cả bcrypt từ dependency sạch.
Summary lấy commit từ `GITHUB_SHA` trong Actions; chạy local để `sha: null` nếu
không có biến này, không gọi Git qua PATH để suy ra source của patch chưa commit.

Workflow `.github/workflows/ci.yml` chạy trên push, pull request và manual
workflow_dispatch, dùng Ubuntu/Node 22 và Compose test services riêng. Workflow
luôn thu diagnostics, dọn test containers và upload log sau khi thành công hoặc
thất bại. Các action được pin commit SHA; token chỉ có contents:read, không cần
app secrets. Manual dispatch dùng được sau khi workflow có trên default branch.
K6 lab/load tiếp tục chạy qua các command riêng, không thuộc gate PR mặc định.

Lỗi assertion phải làm CI đỏ; sửa assertion làm cùng pipeline xanh. Kiểm chứng
hosted cần publish workflow và đối chiếu GitHub run URL; chạy xanh local hoặc
workflow hợp lệ về syntax chưa chứng minh GitHub Actions đã thực chạy. Dependency
audit là phần riêng: pipeline test không tự sửa hoặc che các advisory baseline.

## Production image

Dockerfile mặc định build target `runtime`: Node 22, user `node`, code JavaScript
đã compile và dependency production (bỏ dev/optional dependencies). Prisma Client được generate lúc build.
Image không cần source mount hoặc npm/TypeScript/Prisma CLI khi khởi động.
API và reservation worker dùng cùng image; migration chạy bằng target riêng.

```bash
export VCS_REF="$(git rev-parse HEAD)"
export TIXGO_IMAGE="tixgo:$VCS_REF"
export TIXGO_MIGRATION_IMAGE="tixgo:migration-$VCS_REF"
docker build --target runtime --build-arg VCS_REF="$VCS_REF" -t "$TIXGO_IMAGE" .
docker build --target migration --build-arg VCS_REF="$VCS_REF" -t "$TIXGO_MIGRATION_IMAGE" .
```

Build từ checkout đã commit để tag/revision xác định đúng source. Nếu đang thử
patch chưa commit, dùng hậu tố `-wip` và lưu diff/hash cùng evidence. Base image
được pin digest; việc nâng base cần build, scan và kiểm chứng lại.

Chuẩn bị một env file riêng ngoài repo chứa `DATABASE_URL`, `REDIS_URL` và
`JWT_SECRET` thật của môi trường chạy; không truyền secret bằng build arg.
Đặt `TIXGO_ENV_FILE` thành đường dẫn env file đó và `TIXGO_NETWORK` thành tên
external network đã được provision cho app/database; Compose dùng lại network này.
Database/Redis do môi trường cung cấp, URL phải truy cập được từ network của
container. Với dữ liệu có sẵn, kiểm kê/backup và dừng các writer trước migration.
Ví dụ dưới dùng network Docker đã được chuẩn bị cho app và database:

```bash
docker run --rm --network "$TIXGO_NETWORK" --env-file "$TIXGO_ENV_FILE" "$TIXGO_MIGRATION_IMAGE"
docker compose --env-file "$TIXGO_ENV_FILE" -f compose.production.yml up -d
docker compose --env-file "$TIXGO_ENV_FILE" -f compose.production.yml ps
```

`compose.production.yml` chỉ chạy API/worker, không dựng hoặc migrate database.
Database/Redis Docker phải được nối vào `TIXGO_NETWORK`; không dùng `localhost`
để chỉ container DB. Với database ngoài Docker, chuẩn bị một bridge network cho
app và dùng hostname truy cập được của database/Redis.
API bind host loopback, `TIXGO_PORT` mặc định3000. Compose bật read-only rootfs,
tmpfs `/tmp`, bỏ capabilities và no-new-privileges. Healthcheck của image kiểm tra
HTTP `/health`; đây là liveness, chưa kiểm tra readiness DB. Worker tắt HTTP
healthcheck và dừng qua SIGTERM. `stop_grace_period` là20giây.

Kiểm chứng image từ checkout sạch, sau khi đã build hai target:

```bash
npm ci --ignore-scripts
IMAGE_REF="$TIXGO_IMAGE" MIGRATION_IMAGE_REF="$TIXGO_MIGRATION_IMAGE" npm run test:image
```

Verifier tự tạo network, PostgreSQL `_test` và Redis riêng với cổng loopback ngẫu
nhiên; chạy migration thật, auth/bcrypt, booking/replay/cancel, Redis và worker
expiry; kiểm tra non-root, payload image, healthcheck và SIGTERM exit0. Nó chỉ
dọn tài nguyên do chính run tạo. `IMAGE_EVIDENCE_DIR` mặc định `artifacts/image`;
`DOCKER_BIN` cho phép chọn đường dẫn tuyệt đối của Docker CLI.

Scan local bằng Trivy và giữ cả report/SBOM để đối chiếu đúng image:

```bash
trivy image --scanners vuln,secret --format json --output image-scan.json "$TIXGO_IMAGE"
trivy image --format cyclonedx --output image-sbom.json "$TIXGO_IMAGE"
docker image inspect "$TIXGO_IMAGE" --format '{{.Id}} {{.Size}} {{.Architecture}}'
```

Scan phải ghi rõ version/DB timestamp và các finding còn lại; build/test xanh
không đồng nghĩa image không có CVE. Publishing/deployment là bước riêng.
Compose dev hiện có chọn target `development`, giữ source mount và `npm run dev`.

## Build

```bash
npm run build
npm start
```

`PORT` mặc định `3000`. Chạy `NODE_ENV=production npm start` để tắt giao diện test. Đây chưa phải cấu hình triển khai production hoàn chỉnh.

Tài liệu học và playbook được giữ local; README này chứa các bước chạy lại từ repo.

Dự án ban đầu dựa trên GitLab Express project template.
