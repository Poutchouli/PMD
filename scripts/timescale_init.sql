-- TimescaleDB initialization for PingMeDaddy
-- Run with: psql "$DATABASE_URL" -f scripts/timescale_init.sql

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Target groups (must exist before monitor_targets FK)
CREATE TABLE IF NOT EXISTS target_groups (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color VARCHAR(7) NOT NULL DEFAULT '#6B7280',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core tables (align with SQLAlchemy models)
CREATE TABLE IF NOT EXISTS monitor_targets (
    id SERIAL PRIMARY KEY,
    ip_address TEXT UNIQUE NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    display_url TEXT,
    notes TEXT,
    group_id INTEGER REFERENCES target_groups(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ping_logs (
    time TIMESTAMPTZ NOT NULL,
    target_id INTEGER NOT NULL REFERENCES monitor_targets(id),
    latency_ms DOUBLE PRECISION,
    hops INTEGER,
    packet_loss BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (time, target_id)
);

CREATE TABLE IF NOT EXISTS event_logs (
    id BIGSERIAL PRIMARY KEY,
    target_id INTEGER REFERENCES monitor_targets(id),
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hypertable
SELECT create_hypertable('ping_logs', 'time', if_not_exists => TRUE);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ping_logs_target_time ON ping_logs (target_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_event_logs_target_created_at ON event_logs (target_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_targets_active ON monitor_targets (id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_targets_group ON monitor_targets (group_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_type ON event_logs (event_type);

-- Compression policy: compress chunks older than 1 day (before 3-day retention)
ALTER TABLE ping_logs SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'target_id',
    timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('ping_logs', INTERVAL '1 day', if_not_exists => TRUE);

-- Continuous aggregates
DROP MATERIALIZED VIEW IF EXISTS ping_minute;
CREATE MATERIALIZED VIEW ping_minute
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', time) AS bucket,
       target_id,
       AVG(latency_ms) AS avg_latency,
       MAX(latency_ms) AS max_latency,
       MIN(latency_ms) AS min_latency,
       SUM(CASE WHEN packet_loss THEN 1 ELSE 0 END) AS loss_count,
       COUNT(*) AS samples
FROM ping_logs
GROUP BY bucket, target_id;

DROP MATERIALIZED VIEW IF EXISTS ping_hour;
CREATE MATERIALIZED VIEW ping_hour
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       target_id,
       AVG(latency_ms) AS avg_latency,
       MAX(latency_ms) AS max_latency,
       MIN(latency_ms) AS min_latency,
       SUM(CASE WHEN packet_loss THEN 1 ELSE 0 END) AS loss_count,
       COUNT(*) AS samples
FROM ping_logs
GROUP BY bucket, target_id;

-- Policies: refresh + retention (2-min refresh for near-real-time dashboard)
SELECT add_continuous_aggregate_policy('ping_minute',
    start_offset => INTERVAL '3 days',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '2 minutes'
);

SELECT add_continuous_aggregate_policy('ping_hour',
    start_offset => INTERVAL '30 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);

SELECT add_retention_policy('ping_logs', INTERVAL '3 days');
SELECT add_retention_policy('ping_minute', INTERVAL '30 days');
-- ping_hour kept long-term (no retention here)
