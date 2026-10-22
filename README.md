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

API tạo event hiện chưa có phân quyền organizer. Baseline này phục vụ học tập và kiểm thử nội bộ.

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

Test bắt buộc database có tên kết thúc bằng `_test`, tạo schema ngẫu nhiên, áp dụng migration rồi xóa schema đó sau khi chạy. Không dùng database từ `.env` để kiểm thử integration. Test kiểm tra auth, validation, inventory, replay, mismatch, rollback, key giữa các user và request đồng thời.

Dừng database kiểm thử sau khi dùng:

```bash
docker compose --profile test stop test-db
```

## Kiểm tra thủ công / Postman

1. `POST /auth/register`: `{ "email": "buyer@example.com", "password": "test-password" }`.
2. `POST /auth/login` với cùng body; lấy `data.accessToken`.
3. `POST /events`: `{ "title": "Test event", "totalTickets": 3, "price": 100000 }`.
4. `POST /bookings`: body `{ "eventId": "<EVENT_ID>" }`, Bearer token và header `Idempotency-Key: <unique-key>`.
5. Gửi lại bước 4 giữ nguyên key để kiểm tra replay; thay key cho một lần mua mới.

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
