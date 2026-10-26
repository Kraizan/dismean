# dismean

Distributed Mean: compute per-index means of many files using a worker fleet. See [docs/design-doc.md](docs/design-doc.md).

## Prerequisites

- Docker (Postgres 16 + RabbitMQ 4)
- Node 22+
- Python 3.11+ with `uv` or `pip`

## Quick start

```bash
# Infra
docker compose up -d

export DATA_DIR="$(pwd)/data"   # absolute path

# API
cd api && npm install && npm run dev

# Workers (another terminal)
cd worker && python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python -m dismean_worker.supervisor

# UI (ops dashboard)
cd ui && npm install && npm run dev   # http://localhost:5173 → proxies /api to :3000
```

## Tests

```bash
./scripts/verify-all.sh   # docker, unit+integration tests, e2e matrix, cancel, chaos
RUN_BENCHMARK=1 BENCHMARK_F=20000 ./scripts/verify-all.sh   # optional ITD-027 benchmark
```

Or manually:

```bash
cd api && npm test
cd worker && pytest
./scripts/e2e.sh   # requires API + workers running
DISMEAN_INTEGRATION=1 cd api && npm test   # postgres idempotency test
BENCHMARK_F=20000 ./scripts/benchmark-job.py   # ITD-027 (API + workers up)
```
