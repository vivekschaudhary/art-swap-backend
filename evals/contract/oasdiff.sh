#!/usr/bin/env bash
# E2 breaking-change check against main. Requires oasdiff (https://github.com/oasdiff/oasdiff).
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
NEW="${1:-$ROOT/openapi/openapi.json}"
BASE="$(mktemp -t kt-openapi-main.XXXXXX.json)"
trap 'rm -f "$BASE"' EXIT
if ! git -C "$ROOT" show "origin/main:openapi/openapi.json" > "$BASE" 2>/dev/null; then
  echo "No openapi/openapi.json on origin/main yet; skipping breaking-change check."
  exit 0
fi
oasdiff breaking "$BASE" "$NEW" --fail-on ERR
