#!/usr/bin/env bash
# End-to-end check through the gateway: register -> browse -> cart -> order -> saga result.
set -euo pipefail
BASE="${BASE:-http://localhost:8080/api}"
EMAIL="smoke$(date +%s)@example.com"

j() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

echo "1) register $EMAIL"
TOKEN=$(curl -fsS -X POST "$BASE/users/register" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Smoke Test\",\"email\":\"$EMAIL\",\"password\":\"password123\"}" | j "d['token']")
AUTH="Authorization: Bearer $TOKEN"

echo "2) list products"
PID=$(curl -fsS "$BASE/products?q=keyboard" | j "d['items'][0]['id']")
echo "   first match: $PID"

echo "3) add to cart"
curl -fsS -X POST "$BASE/cart/items" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"productId\":\"$PID\",\"qty\":2}" | j "'cart total = %s' % d['total']"

echo "4) place order"
OID=$(curl -fsS -X POST "$BASE/orders" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"shippingAddress":"1 Test Street, Bengaluru"}' | j "d['id']")
echo "   order $OID"

echo "5) wait for inventory saga (Kafka)"
for _ in $(seq 1 20); do
  STATUS=$(curl -fsS "$BASE/orders/$OID" -H "$AUTH" | j "d['status']")
  [ "$STATUS" != "PENDING" ] && break
  sleep 1
done
echo "   final status: $STATUS"
[ "$STATUS" = "CONFIRMED" ] || { echo "expected CONFIRMED"; exit 1; }

echo "6) unauthenticated access must be rejected"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/orders")
[ "$CODE" = "401" ] && echo "   got 401 as expected" || { echo "expected 401, got $CODE"; exit 1; }

echo "SMOKE TEST PASSED"
