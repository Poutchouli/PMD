<div align="center">
        <h1>PingMeDaddy</h1>
        <p><strong>Async network telemetry platform that pings hundreds of targets, keeps long-term analytics in TimescaleDB, and ships insights via FastAPI, CLI, and a React dashboard.</strong></p>
</div>

## Why it exists
- Keeps 250–300 IPv4/IPv6 targets under watch at 1-second cadence without blocking thanks to an asyncio scheduler.
- Stores every raw ping, then contracts into 1-minute and 1-hour aggregates so dashboards stay fast even after years of history.
- Surfaces latency percentiles, packet loss, hop counts, uptime, and on-demand traceroute in both API and UI.
- Runs anywhere with Docker Compose; also works locally with Python + Node if you prefer bare-metal.

## Screenshots
- Login (default creds in `.env`):
        <img width="640" alt="Login screen" src="https://github.com/user-attachments/assets/1bd1b6fa-5cf9-4fd9-9a09-294bb0d46784" />
- Dashboard overview:
        <img width="1180" alt="Dashboard" src="https://github.com/user-attachments/assets/6c1e1243-c536-487c-8fc5-d4543f46e3c4" />
- Target details with timeline:
        <img width="1180" alt="Target details" src="https://github.com/user-attachments/assets/b05cb016-7d73-4f68-8599-8ef171585664" />
- Event / latency graph:
        <img width="820" alt="Event graph" src="https://github.com/user-attachments/assets/61183629-a789-48c9-9edd-229825467b96" />
- On-demand traceroute:
        <img width="420" alt="Traceroute" src="https://github.com/user-attachments/assets/a73de5b4-0c22-4541-b2ad-3c5b8fd1e094" />
- ^^graph of event^^ (drop in any missing view we should highlight)

## Architecture
```
┌────────────┐      ┌───────────────────────┐      ┌─────────────────────┐
│ React SPA  │◀────▶│ FastAPI + Scheduler  │◀────▶│ TimescaleDB (Postgres)│
│ (Vite/Tailwind)   ││ Auth, CLI, tracing   ││ Raw + continuous aggs    │
└────────────┘      └───────────────────────┘      └─────────────────────┘
                                ▲                      │                              │
                                │                      ▼                              │
                                └────── docker-compose networking + shared env ───────┘
```

## What you get
- **API + CLI parity**: everything in the REST surface is also scriptable via `python -m app.cli`.
- **Scheduler**: async pinger with configurable concurrency, timeouts, and per-target frequencies.
- **Analytics**: continuous aggregates for 1-minute and 1-hour buckets; insights endpoint feeds the UI.
- **Diagnostics**: on-demand traceroute from API/CLI/UI; raw logs exportable as CSV for recent windows.
- **Security**: JWT auth, seed admin credentials, CORS whitelist, configurable secrets.

## Run with Docker Compose (recommended)
1. Copy `.env.example` to `.env` and set secrets, CORS origins, and database URL.
2. Start everything:
         ```bash
         docker compose up --build
         ```
3. Backend: `http://localhost:${APP_PORT:-6666}` with live docs at `/docs` or `/redoc`.
4. Seed demo telemetry (optional):
         ```bash
         docker compose exec app python scripts/seed_historical_data.py --targets 12 --years 2.5 --interval-seconds 60
         ```

## Local development (no Docker)
### Backend
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --port 6666
```
Defaults to SQLite for convenience; point `DATABASE_URL` to Postgres/Timescale for production parity.

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Dev server runs on `http://localhost:5173`; set `VITE_API_URL` in `frontend/.env` to hit the backend.

## Environment variables
- `DATABASE_URL` (e.g. `postgresql+asyncpg://pingmedaddy:pingmedaddy@db:5432/pingmedaddy`)
- `APP_PORT` (default `6666`)
- `PING_TIMEOUT`, `PING_CONCURRENCY_LIMIT`, per-target frequency fields
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- `AUTH_SECRET`, `AUTH_TOKEN_MINUTES`
- `CORS_ORIGINS`
- `TRACEROUTE_BINARY` (override path if needed)
Full list and defaults live in app/config.py.

## Data lifecycle
- Raw pings kept for 3 days ($300 \text{ targets} \times 86{,}400 \text{ pings/day}$ ≈ 4 GB).
- Continuous aggregates: 1-minute buckets retained 1 month; 1-hour buckets retained 5 years (see project.md for policy details).
- Insights endpoint reads from aggregates; `/logs` exposes the recent raw window for debugging.

## CLI cheatsheet
```bash
python -m app.cli target add 1.1.1.1 --frequency 5 --json
python -m app.cli target list
python -m app.cli target pause 42
python -m app.cli target logs 42 --limit 20 --json
python -m app.cli traceroute 42 --max-hops 30
```
Add `--help` to any subcommand for usage details. CLI shares state with the API and scheduler.

## API reference
- Browse autogenerated docs at `/docs` or `/redoc` once running.
- See API_GUIDE.md for request/response payloads and examples.

## Repo map
```
.
├── app/                 # FastAPI app, settings, models, services
├── frontend/            # React dashboard (Vite + Tailwind)
├── scripts/             # Timescale init + historical seeding
├── tests/               # pytest suites (API, CLI, analytics)
├── docker-compose.yml   # App + Timescale stack
├── API_GUIDE.md         # REST reference
├── project.md           # Architecture notes + data strategy
└── README.md            # You are here
```

## Troubleshooting
- Traceroute missing: install `traceroute` in the backend container or set `TRACEROUTE_BINARY` to your binary path.
- JWT rejected: rotate `AUTH_SECRET` and restart; old tokens become invalid.
- Slow dashboards: verify continuous aggregates exist (`\d+ continuous_agg_*` in psql) and retention jobs are running; reseed with scripts/seed_historical_data.py if you want fresh data.

Happy monitoring! 🚀
