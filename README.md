# dismean

Distributed Mean: compute per-index means of many files using a worker fleet. See [docs/design-doc.md](docs/design-doc.md). Source orientation: [docs/code-map.md](docs/code-map.md).

## Prerequisites

- Docker (Postgres 16 + RabbitMQ 4)
- Node 22+
- Python 3.11+ with `pip` (venv)

## Quick start

```bash
# Infra
docker compose up -d

export DATA_DIR="$(pwd)/data"   # absolute path

# API (restarts itself if it loses RabbitMQ; see ITD-033)
(cd api && npm install) && ./scripts/run-api.sh

# Workers (another terminal)
cd worker && python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python -m dismean_worker.supervisor

# UI (ops dashboard)
cd ui && npm install && npm run dev   # http://localhost:5173 → proxies /api to :3000
```

## Tests

```bash
./scripts/verify-all.sh   # docker, all tests, e2e, fairness, chaos, broker restart
RUN_BENCHMARK=1 BENCHMARK_F=20000 ./scripts/verify-all.sh   # optional ITD-027 benchmark
```

Or manually:

```bash
(cd api && DISMEAN_INTEGRATION=1 npm test)   # unit + Postgres integration
(cd worker && .venv/bin/pytest)
(cd ui && npm test)
./scripts/e2e.sh   # requires API + workers running
```
