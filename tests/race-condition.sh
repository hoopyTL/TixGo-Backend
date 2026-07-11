#!/bin/bash

# Kiểm tra tham số đầu vào
if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Cách dùng: ./tests/race-condition.sh <EVENT_ID> <JWT_TOKEN>"
  echo "Ví dụ: ./tests/race-condition.sh 550e8400-e29b-41d4-a716-446655440000 eyJhbGciOi..."
  exit 1
fi

EVENT_ID=$1
TOKEN=$2
URL="http://localhost:3000/bookings"

echo "🚀 Bắt đầu bắn 50 request song song đặt vé cho Event: $EVENT_ID..."
echo "--------------------------------------------------"

# Bắn 50 request song song
for i in $(seq 1 50); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"eventId\": \"$EVENT_ID\"}" &
done

# Chờ tất cả tiến trình con hoàn thành
wait

echo "--------------------------------------------------"
echo "🎉 Đã bắn xong! Hãy kiểm tra lại:"
echo "1. Số lượng bản ghi trong bảng 'bookings' của Event này."
echo "2. Giá trị 'remain_tickets' trong bảng 'events' xem có bị âm không."
