#!/usr/bin/env bash
# Wrapper for scripts/e2e.py. See docs/code-map.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
export API_URL="${API_URL:-http://localhost:3000}"
PY="${ROOT}/worker/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  PY=python3
fi
exec "$PY" "$ROOT/scripts/e2e.py"
