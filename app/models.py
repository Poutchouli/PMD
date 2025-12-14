from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, ForeignKey, Text
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class MonitorTarget(Base):
    __tablename__ = "monitor_targets"

    id = Column(Integer, primary_key=True, index=True)
    ip_address = Column(String, unique=True, index=True, nullable=False)
    frequency = Column(Integer, default=1)  # seconds between pings
    is_active = Column(Boolean, default=True)
    display_url = Column(String(512), nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    logs = relationship(
        "PingLog",
        back_populates="target",
        lazy="selectin",
        passive_deletes=True,
    )
    events = relationship(
        "EventLog",
        back_populates="target",
        lazy="selectin",
        passive_deletes=True,
    )


class PingLog(Base):
    __tablename__ = "ping_logs"

    time = Column(DateTime(timezone=True), primary_key=True, index=True)
    target_id = Column(Integer, ForeignKey("monitor_targets.id", ondelete="CASCADE"), primary_key=True)
    latency_ms = Column(Float, nullable=True)  # Null if packet loss
    hops = Column(Integer, nullable=True)
    packet_loss = Column(Boolean, default=False)

    target = relationship("MonitorTarget", back_populates="logs")


class EventLog(Base):
    __tablename__ = "event_logs"

    id = Column(Integer, primary_key=True, index=True)
    target_id = Column(Integer, ForeignKey("monitor_targets.id", ondelete="CASCADE"), nullable=True)
    event_type = Column(String, nullable=False)
    message = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    target = relationship("MonitorTarget", back_populates="events")


# SQL TO RUN IN POSTGRES (One-time setup for TimescaleDB)
"""
-- 1. Convert regular table to hypertable
SELECT create_hypertable('ping_logs', 'time');

-- 2. Continuous aggregates
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

CREATE MATERIALIZED VIEW ping_hour
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       target_id,
       AVG(latency_ms) AS avg_latency,
       MAX(latency_ms) AS max_latency,
       MIN(latency_ms) AS min_latency,
       SUM(CASE WHEN packet_loss THEN 1 ELSE 0 END) AS loss_count,
       COUNT(*) AS samples
FROM ping_minute
GROUP BY bucket, target_id;

-- 3. Add refresh policies
SELECT add_continuous_aggregate_policy('ping_minute', start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute', schedule_interval => INTERVAL '5 minutes');
SELECT add_continuous_aggregate_policy('ping_hour', start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');

-- 4. Retention
SELECT add_retention_policy('ping_logs', INTERVAL '3 days');
SELECT add_retention_policy('ping_minute', INTERVAL '30 days');
-- Hourly aggregates kept for long term
"""
