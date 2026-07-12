#!/bin/bash

# Kiểm tra tham số đầu vào
if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Cách dùng: ./tests/idempotency.sh <EVENT_ID> <JWT_TOKEN>"
  echo "Ví dụ: ./tests/idempotency.sh 550e8400-e29b-41d4-a716-446655440000 eyJhbGciOi..."
  exit 1
fi

EVENT_ID=$1
TOKEN=$2
URL="http://localhost:3000/bookings"
KEY="test-idemp-key-$(date +%s)" # Sinh key duy nhất theo thời gian

echo "🚀 BẮT ĐẦU TEST IDEMPOTENCY KEY: $KEY"
echo "--------------------------------------------------"

echo "1️⃣ Gửi Request Lần 1 (Tạo booking mới):"
res1=$(curl -s -w "\nHTTP_STATUS: %{http_code}" -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\": \"$EVENT_ID\"}")
echo "$res1"
echo "--------------------------------------------------"

echo "2️⃣ Gửi Request Lần 2 (Trùng Key, Trùng Payload - Phải trả về kết quả cũ & HTTP 201):"
res2=$(curl -s -w "\nHTTP_STATUS: %{http_code}" -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\": \"$EVENT_ID\"}")
echo "$res2"
echo "--------------------------------------------------"

echo "3️⃣ Gửi Request Lần 3 (Trùng Key, KHÁC Payload - Phải báo lỗi Payload Mismatch & HTTP 400):"
res3=$(curl -s -w "\nHTTP_STATUS: %{http_code}" -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\": \"550e8400-e29b-41d4-a716-446655440000\"}")
echo "$res3"
echo "--------------------------------------------------"
