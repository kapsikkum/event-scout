#!/usr/bin/env bash
# Boot a Zenith manifest's stack and check it works, not just that it starts:
# the page loads, the app reports its version, it can reach the crawler, and
# the browser answers the app on the address it uses.
#
#   bash scripts/zenith-smoke.sh [zenith-compose.yml]
#
# Needs Docker with Compose. Uses a throwaway project and volumes, removed on
# exit, and a test password rather than anything real.
set -euo pipefail

manifest="${1:-zenith-compose.yml}"
project="zenith-smoke-$$"
port="${ZENITH_SMOKE_PORT:-3901}"
override="$(mktemp)"
cat > "$override" <<YAML
services:
  app:
    ports: ["127.0.0.1:${port}:3001"]
    environment:
      AUTH_PASSWORD: smoke-test-only
      TZ: Australia/Sydney
YAML

compose() { docker compose -p "$project" -f "$manifest" -f "$override" "$@"; }

finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- smoke test failed; container logs follow ---" >&2
    compose logs --no-color --tail 80 >&2 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$override"
  exit "$status"
}
trap finish EXIT

# Retry a check for up to $1 seconds.
within() {
  local seconds="$1"; shift
  local until=$((SECONDS + seconds))
  until "$@"; do
    if [ "$SECONDS" -ge "$until" ]; then return 1; fi
    sleep 3
  done
}

base="http://127.0.0.1:${port}"
compose up -d --quiet-pull

echo "waiting for the app"
within 120 curl -fsS "$base/api/version" -o /tmp/zenith-version.json
grep -q '"version"' /tmp/zenith-version.json
echo "app $(cat /tmp/zenith-version.json)"

echo "checking the page"
curl -fsS "$base/" | grep -q '<div id="root">'

echo "checking the app reaches the crawler"
crawler_reachable() { curl -fsS "$base/api/crawler/status" | grep -q '"reachable":true'; }
within 90 crawler_reachable

echo "checking the browser answers the app"
# By IP, as the app does: Chromium refuses a DevTools request whose Host
# header is a name. See density/cdp.ts.
browser_answers() {
  compose exec -T app node -e "
    require('node:dns').promises.lookup('chromium')
      .then(({ address }) => fetch('http://' + address + ':9222/json/version'))
      .then((r) => r.json())
      .then((j) => { if (!j.Browser) process.exit(1); console.log(j.Browser); })
      .catch(() => process.exit(1));
  "
}
within 90 browser_answers

echo "smoke test passed"
