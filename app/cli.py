import argparse
import asyncio
import json
import sys
from typing import Any, Dict, List, Optional

from sqlalchemy.future import select

from app.db import AsyncSessionLocal, engine
from app.models import Base, EventLog, MonitorTarget, PingLog
from app.services import pinger


class CliError(Exception):
    """Raised when a CLI command cannot be completed."""


async def _ensure_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def _print_output(payload: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, default=str))
        return

    if isinstance(payload, list):
        for row in payload:
            if isinstance(row, dict):
                print(
                    " | ".join(
                        f"{key}={value}" for key, value in row.items()
                    )
                )
        return

    if isinstance(payload, dict):
        print(
            " | ".join(
                f"{key}={value}" for key, value in payload.items()
            )
        )
        return

    print(payload)


def _target_to_dict(target: MonitorTarget) -> Dict[str, Any]:
    return {
        "id": target.id,
        "ip": target.ip_address,
        "frequency": target.frequency,
        "is_active": target.is_active,
        "created_at": target.created_at,
        "url": target.display_url,
        "notes": target.notes,
    }


def _ping_to_dict(log: PingLog) -> Dict[str, Any]:
    return {
        "time": log.time,
        "latency_ms": log.latency_ms,
        "hops": log.hops,
        "packet_loss": log.packet_loss,
    }


def _event_to_dict(event: EventLog) -> Dict[str, Any]:
    return {
        "id": event.id,
        "target_id": event.target_id,
        "event_type": event.event_type,
        "message": event.message,
        "created_at": event.created_at,
    }


async def _add_target(ip: str, frequency: int, url: Optional[str] = None, notes: Optional[str] = None) -> MonitorTarget:
    async with AsyncSessionLocal() as session:
        existing = await session.execute(
            select(MonitorTarget).where(MonitorTarget.ip_address == ip)
        )
        if existing.scalars().first():
            raise CliError("IP already monitored")

        target = MonitorTarget(
            ip_address=ip,
            frequency=frequency,
            display_url=url.strip() or None if isinstance(url, str) else url,
            notes=notes.strip() or None if isinstance(notes, str) else notes,
        )
        session.add(target)
        await session.commit()
        await session.refresh(target)

        session.add(
            EventLog(
                target_id=target.id,
                event_type="start",
                message=f"Tracking started for {ip}",
            )
        )
        await session.commit()
        return target


async def _list_targets() -> List[MonitorTarget]:
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(MonitorTarget).order_by(MonitorTarget.id))
        return list(result.scalars().all())


async def _update_status(target_id: int, active: bool, message: str) -> MonitorTarget:
    async with AsyncSessionLocal() as session:
        target = await session.get(MonitorTarget, target_id)
        if not target:
            raise CliError("Target not found")
        target.is_active = active
        await session.commit()

        session.add(
            EventLog(
                target_id=target.id,
                event_type="start" if active else "stop",
                message=message,
            )
        )
        await session.commit()
        await session.refresh(target)
        return target


async def _get_logs(target_id: int, limit: int) -> List[PingLog]:
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(PingLog)
            .where(PingLog.target_id == target_id)
            .order_by(PingLog.time.desc())
            .limit(limit)
        )
        return list(reversed(result.scalars().all()))


async def _get_events(target_id: int, limit: int) -> List[EventLog]:
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(EventLog)
            .where(EventLog.target_id == target_id)
            .order_by(EventLog.created_at.desc())
            .limit(limit)
        )
        return list(result.scalars().all())


async def _handle(args: argparse.Namespace) -> None:
    await _ensure_db()

    if args.command == "ping":
        latency, hops, loss = await pinger.ping_target(args.ip)
        payload = {
            "ip": args.ip,
            "latency_ms": latency,
            "hops": hops,
            "packet_loss": loss,
        }
        _print_output(payload, args.as_json)
        return

    if args.command == "target":
        if args.action == "add":
            target = await _add_target(args.ip, args.frequency, args.url, args.notes)
            _print_output(_target_to_dict(target), args.as_json)
            return

        if args.action == "list":
            targets = await _list_targets()
            _print_output([_target_to_dict(t) for t in targets], args.as_json)
            return

        if args.action == "pause":
            target = await _update_status(args.target_id, False, "Tracking paused")
            _print_output(
                {"message": "Tracking paused", "id": target.id}, args.as_json
            )
            return

        if args.action == "resume":
            target = await _update_status(args.target_id, True, "Tracking resumed")
            _print_output(
                {"message": "Tracking resumed", "id": target.id}, args.as_json
            )
            return

        if args.action == "delete":
            target = await _update_status(args.target_id, False, "Tracking stopped")
            _print_output(
                {"message": "Tracking stopped", "id": target.id}, args.as_json
            )
            return

        if args.action == "logs":
            logs = await _get_logs(args.target_id, args.limit)
            _print_output([_ping_to_dict(log) for log in logs], args.as_json)
            return

        if args.action == "events":
            events = await _get_events(args.target_id, args.limit)
            _print_output([_event_to_dict(event) for event in events], args.as_json)
            return

    raise CliError("Unknown command")


def _add_json_option(command: argparse.ArgumentParser) -> None:
    command.add_argument("--json", action="store_true", dest="as_json", help="Output JSON")
    command.set_defaults(as_json=False)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pingmedaddy",
        description="Manage and inspect ping monitors",
    )
    parser.set_defaults(as_json=False)

    subparsers = parser.add_subparsers(dest="command", required=True)

    ping_parser = subparsers.add_parser("ping", help="Run a one-off ping")
    ping_parser.add_argument("ip", help="IP address to ping")
    _add_json_option(ping_parser)

    target_parser = subparsers.add_parser("target", help="Manage targets")
    target_sub = target_parser.add_subparsers(dest="action", required=True)

    add_parser = target_sub.add_parser("add", help="Add a target")
    add_parser.add_argument("ip", help="IP to monitor")
    add_parser.add_argument("--frequency", type=int, default=1, help="Seconds between pings")
    add_parser.add_argument("--url", help="Optional interface URL", default=None)
    add_parser.add_argument("--notes", help="Optional notes for this target", default=None)
    _add_json_option(add_parser)

    list_parser = target_sub.add_parser("list", help="List all targets")
    _add_json_option(list_parser)

    pause_parser = target_sub.add_parser("pause", help="Pause a target")
    pause_parser.add_argument("target_id", type=int, help="Target id")
    _add_json_option(pause_parser)

    resume_parser = target_sub.add_parser("resume", help="Resume a target")
    resume_parser.add_argument("target_id", type=int, help="Target id")
    _add_json_option(resume_parser)

    delete_parser = target_sub.add_parser("delete", help="Stop tracking a target")
    delete_parser.add_argument("target_id", type=int, help="Target id")
    _add_json_option(delete_parser)

    logs_parser = target_sub.add_parser("logs", help="Fetch recent ping logs")
    logs_parser.add_argument("target_id", type=int, help="Target id")
    logs_parser.add_argument("--limit", type=int, default=100, help="Number of entries to return")
    _add_json_option(logs_parser)

    events_parser = target_sub.add_parser("events", help="Show event history")
    events_parser.add_argument("target_id", type=int, help="Target id")
    events_parser.add_argument("--limit", type=int, default=100, help="Number of entries to return")
    _add_json_option(events_parser)

    return parser


def main(argv: List[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        asyncio.run(_handle(args))
        return 0
    except CliError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
