#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
export DATABASE_URL="${DATABASE_URL:-postgresql://dismean:dismean@localhost:5432/dismean}"
export AMQP_URL="${AMQP_URL:-amqp://guest:guest@localhost:5672}"
PY="${ROOT}/worker/.venv/bin/python"
API_PID=""

mkdir -p "$DATA_DIR"

echo "==> docker compose"
docker compose -f "$ROOT/docker-compose.yml" up -d
for _ in $(seq 1 40); do
  if docker compose -f "$ROOT/docker-compose.yml" exec -T postgres pg_isready -U dismean -d dismean >/dev/null 2>&1 \
    && docker compose -f "$ROOT/docker-compose.yml" exec -T rabbitmq rabbitmqctl await_startup >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

for _ in $(seq 1 30); do
  if "$PY" "$ROOT/scripts/verify-rabbitmq.py" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

STARTED_API=0

health_ok() {
  "$PY" -c "import urllib.request; urllib.request.urlopen('http://localhost:3000/health', timeout=2)"
}

if ! health_ok >/dev/null 2>&1; then
  echo "==> start API"
  (cd "$ROOT/api" && npx tsx src/server.ts) &
  API_PID=$!
  STARTED_API=1
  for _ in $(seq 1 30); do
    health_ok >/dev/null 2>&1 && break
    sleep 1
  done
  health_ok >/dev/null 2>&1 || { echo "API failed to start"; exit 1; }
fi

if ! pgrep -f "dismean_worker.supervisor" >/dev/null 2>&1; then
  echo "==> start worker supervisor"
  (cd "$ROOT/worker" && "$PY" -m dismean_worker.supervisor) &
  sleep 2
fi

echo "==> api npm test"
(cd "$ROOT/api" && DISMEAN_INTEGRATION=1 npm test)

echo "==> worker pytest"
(cd "$ROOT/worker" && "$PY" -m pytest -q)

echo "==> verify rabbitmq"
"$PY" "$ROOT/scripts/verify-rabbitmq.py"

echo "==> e2e"
"$PY" "$ROOT/scripts/e2e.py"

echo "==> e2e matrix"
"$PY" "$ROOT/scripts/e2e-matrix.py"

echo "==> e2e api errors + cancel"
"$PY" "$ROOT/scripts/e2e-api-errors.py"

echo "==> e2e fleet scaling (configurable W)"
"$PY" "$ROOT/scripts/e2e-fleet.py"

echo "==> chaos recovery"
"$PY" "$ROOT/scripts/chaos-recovery.py"

if [[ "${RUN_BENCHMARK:-0}" == "1" ]]; then
  echo "==> benchmark"
  BENCHMARK_F="${BENCHMARK_F:-500}" "$PY" "$ROOT/scripts/benchmark-job.py"
fi

if [[ "${STARTED_API:-0}" == 1 && -n "${API_PID:-}" ]]; then
  kill "$API_PID" 2>/dev/null || true
fi

echo "==> verify-all passed"
