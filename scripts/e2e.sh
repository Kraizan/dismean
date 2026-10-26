#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
export API_URL="${API_URL:-http://localhost:3000}"
PY="${ROOT}/worker/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  PY=python3
fi
exec "$PY" "$ROOT/scripts/e2e.py"
