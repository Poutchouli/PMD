# PingMeDaddy API Guide

Use this guide to integrate the PingMeDaddy monitoring API into any other application or automation. The service exposes a simple REST interface over HTTP (FastAPI) and ships with a CLI companion. This document focuses on the HTTP endpoints but also references the CLI when helpful.

## Getting Started

1. **Configure environment variables** by copying `.env.example` to `.env` and tweaking the values you need (database URL, login credentials, `APP_PORT`, `CORS_ORIGINS`, etc.). The FastAPI app reads them automatically at startup and `docker compose` uses the same file for interpolation.
2. **Run the stack** (FastAPI + TimescaleDB) locally:
   ```bash
   docker compose up --build
   ```
  - App endpoint: `http://localhost:${APP_PORT:-6666}`
   - Database: `postgresql+asyncpg://pingmedaddy:pingmedaddy@db:5432/pingmedaddy`
3. **Health check**: there is no `/health` endpoint; hitting `/docs` will confirm the API is ready.
4. **Authentication**: required. Call `POST /auth/login` with the admin credentials (defaults stored in `.env`) to obtain a bearer token, then pass `Authorization: Bearer <token>` on every request.

> The CLI mirrors these endpoints. For example, `python -m app.cli target add 1.1.1.1 --frequency 5` is equivalent to the POST `/targets/` call described below.

## Endpoints

### 0. Login
- **POST** `/auth/login`
- **Body** (`application/json`):
  ```json
  {
    "username": "admin",
    "password": "changeme"
  }
  ```
- **Response** (`200 OK`):
  ```json
  {
    "access_token": "<jwt>",
    "token_type": "bearer"
  }
  ```
- Use the returned token in the `Authorization` header for all subsequent endpoints. Tokens expire after the duration configured by `AUTH_TOKEN_MINUTES` (default: 24h).

### 1. Create a Target
- **POST** `/targets/`
- **Body** (`application/json`):
  ```json
  {
    "ip": "192.168.1.254",
    "frequency": 5,
    "url": "https://router.lan",
    "notes": "Console admin admin"
  }
  ```
  - `ip`: IPv4 or IPv6 address to monitor (validated).
  - `frequency`: seconds between pings (1-3600, default 1).
  - `url` *(optional)*: HTTP(S) interface shortcut shown in the dashboard.
  - `notes` *(optional)*: free-form details visible in the target drawer.
- **Responses**:
  - `200 OK`:
    ```json
    {
      "message": "Started tracking 192.168.1.254",
      "id": 42
    }
    ```
  - `400 Bad Request`: if the IP is already being monitored.

### 2. List Targets
- **GET** `/targets/`
- **Query params**: none.
- **Response** (`200 OK`):
  ```json
  [
    {
      "id": 42,
      "ip": "192.168.1.254",
      "frequency": 5,
      "is_active": true,
      "created_at": "2025-12-10T22:51:10.456243Z",
      "url": "https://router.lan",
      "notes": "Console admin admin"
    }
  ]

### 2b. Update Target Metadata
- **PATCH** `/targets/{target_id}`
- **Body** (`application/json`): any combination of the fields below
  ```json
  {
    "frequency": 10,
    "url": "https://router.lan",
    "notes": "Console admin admin"
  }
  ```
- **Response** (`200 OK`): the full target document (same shape as `GET /targets/`).
- Use this to adjust notes/URL from the UI without recreating the monitor.
  ```

### 3. Pause Monitoring
- **POST** `/targets/{target_id}/pause`
- **Response** (`200 OK`):
  ```json
  {
    "message": "Tracking paused",
    "id": 42
  }
  ```
- Side effects: cancels the scheduler task, logs a `stop` event.

### 4. Resume Monitoring
- **POST** `/targets/{target_id}/resume`
- **Response** (`200 OK`):
  ```json
  {
    "message": "Tracking resumed",
    "id": 42
  }
  ```
- Side effects: restarts the async ping loop and logs a `start` event.

### 5. Delete Target (Stop Permanently)
- **DELETE** `/targets/{target_id}`
- **Response** (`200 OK`):
  ```json
  {
    "message": "Tracking stopped",
    "id": 42
  }
  ```
- Target remains in DB but is marked inactive, allowing history queries.

### 6. Fetch Ping Logs
- **GET** `/targets/{target_id}/logs`
- **Query params**:
  - `limit` (optional, default 100, range 1-1000)
- **Response** (`200 OK`): sorted oldest → newest:
  ```json
  [
    {
      "time": "2025-12-10T22:55:15.901Z",
      "latency_ms": 12.5,
      "hops": 5,
      "packet_loss": false
    }
  ]
  ```
- Gathers raw pings (from Timescale hypertable). Packet loss is true when ping failed.

### 6b. Export Ping Logs
- **GET** `/targets/{target_id}/logs/export`
- **Response** (`200 OK`, `text/csv` attachment): streamed CSV with the columns `time,target_id,target_ip,latency_ms,hops,packet_loss`.
- Use this for long-term archival or to ingest the full, unpaginated ping history elsewhere.

### 7. Fetch Event Logs
- **GET** `/targets/{target_id}/events`
- **Response** (`200 OK`): newest first:
  ```json
  [
    {
      "id": 1337,
      "target_id": 42,
      "event_type": "start",
      "message": "Tracking resumed",
      "created_at": "2025-12-10T22:57:51.149Z"
    }
  ]
  ```
- Events capture start, pause, resume, and delete actions.

### 8. Fetch Aggregated Insights
- **GET** `/targets/{target_id}/insights`
- **Query params**:
  - `window_minutes` (optional, default 60, range 1-1440) — rolling window for stats.
  - `bucket_seconds` (optional, default 60) — granularity for the timeline series.
- **Response** (`200 OK`):
  ```json
  {
    "target_id": 42,
    "target_ip": "192.168.1.254",
    "created_at": "2025-12-10T22:51:10.456243Z",
    "window_minutes": 60,
    "window_start": "2025-12-10T21:55:00Z",
    "window_end": "2025-12-10T22:55:00Z",
    "sample_count": 120,
    "loss_count": 3,
    "uptime_percent": 97.5,
    "latency_avg_ms": 12.1,
    "latency_min_ms": 7.8,
    "latency_max_ms": 35.0,
    "latency_p50_ms": 11.0,
    "latency_p95_ms": 20.2,
    "latency_p99_ms": 32.5,
    "timeline": [
      {
        "bucket": "2025-12-10T22:30:00Z",
        "avg_latency_ms": 12.5,
        "min_latency_ms": 9.1,
        "max_latency_ms": 17.4,
        "loss_rate": 0.0,
        "sample_count": 5
      }
    ]
  }
  ```
- Use this payload to display uptime badges, percentile stats, and chart-ready time buckets without fetching raw logs repeatedly.

### 9. Run On-Demand Traceroute
- **POST** `/targets/{target_id}/traceroute`
- **Query params** (all optional):
  - `max_hops` (default 20, max 64)
  - `timeout` seconds (default 25)
- **Response** (`200 OK`):
  ```json
  {
    "target_id": 42,
    "target_ip": "192.168.1.254",
    "started_at": "2025-12-10T22:58:00Z",
    "finished_at": "2025-12-10T22:58:01Z",
    "duration_ms": 850.0,
    "hops": [
      {
        "hop": 1,
        "host": "router",
        "ip": "192.168.0.1",
        "rtt_ms": 1.1,
        "is_timeout": false,
        "raw": " 1  router (192.168.0.1)  1.111 ms"
      },
      {
        "hop": 2,
        "host": null,
        "ip": null,
        "rtt_ms": null,
        "is_timeout": true,
        "raw": " 2  * * *" 
      }
    ]
  }
  ```
- Errors return `503 Service Unavailable` when the traceroute binary is missing or the command times out.

## Example Integration Flow

1. **Provision** a target (POST `/targets/`). Store the returned `id`.
2. **Poll** `/targets/{id}/logs?limit=N` for telemetry to feed charts or alerting.
3. **Pause/Resume** based on schedules by hitting the respective endpoints.
4. **Audit** operations via `/targets/{id}/events` for dashboards or incident timelines.

## CLI Cheat Sheet (optional)
Use the CLI when scripting or debugging alongside the API:
```bash
# Ping immediately
python -m app.cli ping 8.8.8.8 --json

# Add/list targets
python -m app.cli target add 1.1.1.1 --frequency 2 --json
python -m app.cli target list

# Pause/resume
python -m app.cli target pause 2
python -m app.cli target resume 2

# Logs/events
python -m app.cli target logs 2 --limit 5 --json
python -m app.cli target events 2 --json
```
The CLI shares the same database and scheduler, so actions are reflected instantly in the API responses.

## Notes for Downstream Apps
- **Concurrency**: the scheduler uses asyncio tasks with a semaphore to cap concurrent pings (`ping_concurrency_limit` in `app/config.py`).
- **Resilience**: packet-loss entries still create log rows with `packet_loss=true` and null latency/hops; handle those cases in consumers.
- **Time zones**: timestamps are UTC (`TIMESTAMPTZ`).
- **Scaling**: Timescale continuous aggregates (`scripts/timescale_init.sql`) down-sample data for long-term storage.

Embed these HTTP calls in your preferred language/client to build dashboards, alerting systems, or integrations on top of PingMeDaddy.
