#!/usr/bin/env bash
# E2 property-based fuzzing from the live OpenAPI document.
# Requires: schemathesis (pip install schemathesis) and a running API at EVALS_BASE_URL.
set -euo pipefail
BASE="${EVALS_BASE_URL:-http://localhost:3000}"
schemathesis run "$BASE/v1/openapi.json" \
  --base-url "$BASE" \
  --checks all \
  --header "Accept: application/json" \
  --max-examples 50 \
  --exclude-path-regex '^/v1/auth/' \
  --hypothesis-suppress-health-check=too_slow
