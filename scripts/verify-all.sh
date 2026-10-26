#!/usr/bin/env bash
# Full local verification orchestrator. See docs/code-map.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
export DATABASE_URL="${DATABASE_URL:-postgresql://dismean:dismean@localhost:5432/dismean}"
export AMQP_URL="${AMQP_URL:-amqp://guest:guest@localhost:5672}"
export API_URL="${API_URL:-http://localhost:3000}"
PY="${ROOT}/worker/.venv/bin/python"
STARTED=()

cleanup() {
  for pid in "${STARTED[@]:-}"; do
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 30); do
    alive=0
    for pid in "${STARTED[@]:-}"; do
      [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive=1
    done
    [[ "$alive" == 0 ]] && return
    sleep 0.5
  done
}
trap cleanup EXIT

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
  "$PY" "$ROOT/scripts/verify-rabbitmq.py" >/dev/null 2>&1 && break
  sleep 1
done

health_ok() {
  "$PY" -c "import urllib.request; urllib.request.urlopen('$API_URL/health', timeout=2)" >/dev/null 2>&1
}

if ! health_ok; then
  echo "==> start API (restart loop)"
  "$ROOT/scripts/run-api.sh" &
  STARTED+=("$!")
  for _ in $(seq 1 30); do health_ok && break; sleep 1; done
  health_ok || { echo "API failed to start"; exit 1; }
fi

if ! pgrep -f "dismean_worker.supervisor" >/dev/null 2>&1; then
  echo "==> start worker supervisor"
  (cd "$ROOT/worker" && exec "$PY" -m dismean_worker.supervisor) &
  STARTED+=("$!")
  sleep 3
fi

echo "==> api tests (unit + integration)"
(cd "$ROOT/api" && DISMEAN_INTEGRATION=1 npm test)

echo "==> worker tests"
(cd "$ROOT/worker" && "$PY" -m pytest -q)

echo "==> ui tests + build"
(cd "$ROOT/ui" && npm test && npm run build >/dev/null)

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

echo "==> e2e fairness (small job overtakes large job)"
"$PY" "$ROOT/scripts/e2e-fairness.py"

echo "==> chaos recovery (kill workers with tasks in flight)"
"$PY" "$ROOT/scripts/chaos-recovery.py"

if pgrep -f "scripts/run-api.sh" >/dev/null 2>&1; then
  echo "==> broker restart recovery"
  "$PY" "$ROOT/scripts/e2e-broker-restart.py"
else
  echo "==> broker restart recovery: SKIPPED (API not running under scripts/run-api.sh)"
fi

if [[ "${RUN_BENCHMARK:-0}" == "1" ]]; then
  echo "==> benchmark"
  BENCHMARK_F="${BENCHMARK_F:-500}" "$PY" "$ROOT/scripts/benchmark-job.py"
fi

echo "==> verify-all passed"
