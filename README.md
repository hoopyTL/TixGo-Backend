# TixGo

Backend Express + TypeScript + Prisma + PostgreSQL với JWT auth, booking và idempotency.

## Chạy tại máy

Yêu cầu: Node.js 22 trở lên, npm, Docker Desktop đang chạy.

```bash
npm ci
test -f .env || cp .env.example .env
```

Nếu đã có `.env`, giữ file đó và kiểm tra `DATABASE_URL`, `JWT_SECRET`. Đổi `JWT_SECRET` trong file mẫu trước khi dùng.

```bash
docker compose up -d db
npx prisma generate
# Existing databases: review inventory exceptions before applying migrations.
npx prisma migrate deploy
npm run dev
```

API mặc định chạy tại http://localhost:3000. PostgreSQL chạy trong Docker; API chạy trên host.

Mỗi lượt mua mới dùng `Idempotency-Key` mới; retry giữ nguyên key và event.

- Tạo booking: HTTP `201`.
- Replay thành công: HTTP `200`, header `Idempotent-Replayed: true`, booking ID giữ nguyên.
- Cùng key, khác payload: HTTP `400`.
- Hết vé: HTTP `409`.

Key được scope theo user và hiện chỉ dùng cho thao tác tạo booking. Retry phải
giữ cùng key và payload; lượt mua mới dùng key mới. Các request cùng user/key
được xử lý lần lượt qua transaction advisory lock, rồi đọc lại kết quả đã lưu.
Key và cached response hiện được giữ đến khi có thao tác dọn dữ liệu thủ công;
chưa có TTL hoặc cleanup job. Khi thêm operation mới, cần đưa operation/version
vào contract key/hash trước khi tái sử dụng cơ chế này.

Trong luồng bình thường, request trùng đang chạy phải chờ transaction trước.
Nếu gặp record `PROCESSING` đã lưu, API trả `409 Request is processing`.
Chờ transaction không được bảo đảm vô hạn; lỗi kỹ thuật/timeout hiện có thể trả
`500`. Khi kết quả chưa rõ, client retry cùng key/payload, không tạo key mới.

Tạo Event cần Bearer token và role organizer/admin hiện hành trong DB. Buyer không có quyền tạo Event.

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
docker compose --profile test up -d --wait test-db
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
docker compose --profile test stop test-db
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
5. Public `GET /events` không trả owner; create response có `organizerId`. `role`, `remainTickets` và trường lạ trong input create bị từ chối. `totalTickets` nhận số nguyên từ 1 đến 2147483647 (giới hạn PostgreSQL INTEGER, không phải business cap).
6. Thiếu/token sai → `401`; buyer/role không được cấp quyền → `403`; owner/input sai policy → `400`; tạo thành công → `201`. Role create được đọc từ DB trong transaction, không dùng role claim cũ để quyết định quyền.
7. `POST /bookings`: body `{ "eventId": "<EVENT_ID>" }`, Bearer token và header `Idempotency-Key: <unique-key>`.
8. Gửi lại bước 7 giữ nguyên key để kiểm tra replay; thay key cho một lần mua mới.

Các script có assertion tự động (chạy với một event test riêng, không có người khác đang mua):

```bash
bash tests/idempotency.sh "$EVENT_ID" "$ACCESS_TOKEN"
bash tests/race-condition.sh "$EVENT_ID" "$ACCESS_TOKEN" 50
```

Hai script sử dụng Node.js `fetch`, trả exit code khác 0 khi kết quả sai. `BASE_URL` mặc định `http://localhost:3000`, có thể đổi bằng biến môi trường. Script tạo booking thật và tiêu thụ vé.

## Build

```bash
npm run build
npm start
```

`PORT` mặc định `3000`. Đây chưa phải cấu hình triển khai production hoàn chỉnh.

Tài liệu học và playbook được giữ local; README này chứa các bước chạy lại từ repo.

Dự án ban đầu dựa trên GitLab Express project template.
