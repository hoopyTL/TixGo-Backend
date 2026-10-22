#!/bin/bash
set -euo pipefail

if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Cách dùng: ./tests/idempotency.sh <EVENT_ID> <JWT_TOKEN>"
  echo "Dùng access token từ /auth/login và sự kiện còn ít nhất một vé."
  exit 1
fi

# The runner asserts replay HTTP 200, matching IDs and inventory delta.
node "$(dirname "$0")/api-scenarios.js" idempotency "$1" "$2"
