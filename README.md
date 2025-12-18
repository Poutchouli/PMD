# PingMeDaddy

Async network telemetry platform that keeps a rolling eye on hundreds of IP targets, stores their latency/packet-loss traces in TimescaleDB, and exposes fast analytics through a FastAPI backend, CLI, and React dashboard.

## Highlights
- Track hundreds of IPv4/IPv6 targets concurrently with an asyncio scheduler.
- Persist raw ping samples in Timescale hypertables, then auto-contract them into 1-minute and 1-hour aggregates for long-term trend analysis.
- Drill into uptime, percentile latency, packet-loss, and hop counts via `/targets/{id}/insights` or export every raw ping as CSV.
- Launch on-demand traceroute diagnostics directly from the API or dashboard.
- Drive everything via REST (see [API_GUIDE.md](API_GUIDE.md)), the authenticated CLI (`python -m app.cli`), or the React + Vite frontend located in [frontend/](frontend).

## System Architecture
```
┌────────────┐      ┌───────────────────────┐      ┌─────────────────────┐
│ React SPA  │◀────▶│ FastAPI + Scheduler  │◀────▶│ TimescaleDB (Postgres)│
│ (Vite/Tailwind)   ││ Auth, CLI, tracing   ││ Raw + continuous aggs    │
└────────────┘      └───────────────────────┘      └─────────────────────┘
        ▲                      │                              │
        │                      ▼                              │
        └────── docker-compose networking + shared env ───────┘
```

## Tech Stack
- Backend: FastAPI, SQLAlchemy, asyncpg, JWT auth, asyncio scheduler, traceroute subprocess integration.
- Storage: PostgreSQL with TimescaleDB extension, hypertables seeded by [scripts/timescale_init.sql](scripts/timescale_init.sql).
- Frontend: React 19, Vite, TailwindCSS, Recharts, lucide-react icons.
- Tooling: Docker Compose, pytest, ESLint, GitHub Actions-ready CLI/tests.

## Prerequisites
- Docker + Docker Compose (for the recommended workflow).
- Python 3.11+ and Node 20+ if you plan to run backend/frontend directly.
- Access to a TimescaleDB-compatible Postgres instance (Docker compose spins one up automatically).

## Quick Start (Docker Compose)
1. Duplicate `.env.example` into `.env` and adjust credentials, ports, and CORS origins.
2. Build and run the stack:
   ```bash
   docker compose up --build
   ```
3. Backend becomes available at `http://localhost:${APP_PORT:-6666}` and ships with live docs at `/docs`.
4. Login via `POST /auth/login` (default `admin/changeme`) to obtain a bearer token for subsequent calls.
5. Optional: run `docker compose exec app python scripts/seed_historical_data.py --targets 12 --years 2.5 --interval-seconds 60` to backfill demo data.

## Local Development (without Docker)
### Backend
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # adjust DATABASE_URL, auth secret, etc.
uvicorn main:app --reload --port 6666
```
By default the service falls back to SQLite (`sqlite+aiosqlite:///./pingmedaddy.db`). Point `database_url` to Postgres/Timescale for production parity.

### Frontend
```bash
cd frontend
npm install
npm run dev
```
The dev server listens on `http://localhost:5173`; update `VITE_API_URL` in `frontend/.env` (create one if needed) so the UI hits the FastAPI host.

## Environment Variables
Configure once in `.env` (shared by FastAPI and Docker):
- `DATABASE_URL` – e.g. `postgresql+asyncpg://pingmedaddy:pingmedaddy@db:5432/pingmedaddy`
- `APP_PORT` – default `6666`.
- `PING_TIMEOUT`, `PING_CONCURRENCY_LIMIT` – control scheduler behavior.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` – seed credentials for `POST /auth/login`.
- `AUTH_SECRET`, `AUTH_TOKEN_MINUTES` – JWT signing and TTL.
- `CORS_ORIGINS` – comma-separated origins for the SPA.
- `TRACEROUTE_BINARY` – override if traceroute lives outside the default path.
See [app/config.py](app/config.py) for the full list and defaults.

## Data Lifecycle
- Raw hypertable keeps every second-level ping for 3 days (≈4 GB for 300 targets).
- Continuous aggregates down-sample into 1-minute buckets (retained 1 month) and 1-hour buckets (5 years) per [project.md](project.md).
- Metrics shipped by `/targets/{id}/insights` are computed from those aggregates, while `/logs` surfaces raw samples for recent debugging windows.

## Database Utilities
- Initial schema + hypertables: automatically loaded from [scripts/timescale_init.sql](scripts/timescale_init.sql) when the DB container boots.
- Synthetic telemetry: [scripts/seed_historical_data.py](scripts/seed_historical_data.py) populates multi-year traces to showcase charts and validate aggregation jobs.

## CLI Cheatsheet
The CLI mirrors the HTTP surface and is ideal for scripting:
```bash
python -m app.cli target add 1.1.1.1 --frequency 5 --json
python -m app.cli target list
python -m app.cli target pause 42
python -m app.cli target logs 42 --limit 20 --json
python -m app.cli traceroute 42 --max-hops 30
```
Add `--help` to any subcommand for usage details. The CLI shares the same DB and scheduler as the API, so actions sync instantly.

## API Documentation
Comprehensive request/response payloads live in [API_GUIDE.md](API_GUIDE.md). You can also explore the autogenerated OpenAPI docs at `/docs` or `/redoc` once the server is running.

## Testing
- Backend tests: `pytest` (see [tests/](tests)).
- CLI smoke tests: `pytest tests/test_cli.py`.
- Frontend lint: `npm run lint` inside [frontend/](frontend).
Add `--maxfail=1 -x` for quicker feedback loops during active development.

## Project Structure
```
.
├── app/                 # FastAPI app, settings, models, services
├── frontend/            # React dashboard (Vite)
├── scripts/             # Timescale init + historical seeding
├── tests/               # pytest suites (API, CLI, analytics)
├── docker-compose.yml   # App + Timescale stack
├── API_GUIDE.md         # REST reference
├── project.md           # architecture notes + data-strategy
└── README.md            # you are here
```

## Troubleshooting
- **Traceroute missing**: install `traceroute` inside the backend container or set `TRACEROUTE_BINARY` to the correct executable path.
- **JWT failures**: regenerate `AUTH_SECRET` and restart the app; tokens issued with the old secret become invalid.
- **Slow dashboards**: verify continuous aggregates exist (`\d+ continuous_agg_*` in psql) and that retention policies are running; reseed via `scripts/seed_historical_data.py` if you need fresh data.

Happy monitoring! 🚀
