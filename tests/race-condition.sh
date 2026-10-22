#!/bin/bash
set -euo pipefail

if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Cách dùng: ./tests/race-condition.sh <EVENT_ID> <JWT_TOKEN> [REQUEST_COUNT=50]"
  echo "Lưu ý: tham số thứ hai phải là access token trả về từ /auth/login, không phải JWT_SECRET trong .env."
  exit 1
fi

TOKEN=$2
if ! [[ "$TOKEN" =~ ^[^.]+\.[^.]+\.[^.]+$ ]]; then
  echo "Token không hợp lệ."
  echo "Hãy truyền access token JWT từ /auth/login, không phải secret như JWT_SECRET."
  exit 1
fi

# Each independent purchase receives a unique key; the runner checks inventory.
node "$(dirname "$0")/api-scenarios.js" race "$1" "$TOKEN" "${3:-50}"
