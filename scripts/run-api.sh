#!/usr/bin/env bash
# Runs the API and restarts it when it exits non-zero, e.g. after losing RabbitMQ (ITD-005).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
cd "$ROOT/api"

# tsx forwards SIGTERM to the server; npx would not reliably reach it.
TSX="$ROOT/api/node_modules/.bin/tsx"
child=""
stopping=0

on_stop() {
  stopping=1
  [[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null
}
trap on_stop TERM INT

backoff=1
while [[ "$stopping" == 0 ]]; do
  started=$(date +%s)
  "$TSX" src/server.ts &
  child=$!
  wait "$child"
  code=$?
  # `wait` returns early when a trapped signal arrives; wait again for the server to finish shutting down.
  [[ "$stopping" == 1 ]] && wait "$child" 2>/dev/null
  child=""
  [[ "$stopping" == 1 || "$code" == 0 ]] && exit 0
  (( $(date +%s) - started > 60 )) && backoff=1
  echo "run-api: API exited with $code; restarting in ${backoff}s" >&2
  sleep "$backoff" &
  child=$!
  wait "$child"
  child=""
  backoff=$(( backoff * 2 > 30 ? 30 : backoff * 2 ))
done
