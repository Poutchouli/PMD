from __future__ import annotations

import asyncio
import platform
import re
from datetime import datetime, timezone
from typing import Dict, List

from app.config import get_settings

settings = get_settings()

DEFAULT_MAX_HOPS = 20
DEFAULT_QUERIES = 1
DEFAULT_TIMEOUT = 25.0

HOP_LINE_RE = re.compile(r"^\s*(\d+)\s+(.*)$")
IP_RE = re.compile(r"\(([0-9a-fA-F:\.]+)\)")
RTT_RE = re.compile(r"([0-9]+\.?[0-9]*)\s*ms", re.IGNORECASE)


def _resolve_binary(system: str) -> str:
    override = settings.traceroute_binary
    if override:
        return override
    if system.startswith("win"):
        return "tracert"
    return "traceroute"


def _build_command(ip: str, max_hops: int, queries: int) -> List[str]:
    system = platform.system().lower()
    binary = _resolve_binary(system)
    if system.startswith("win"):
        return [binary, "-h", str(max_hops), ip]
    return [binary, "-q", str(queries), "-m", str(max_hops), ip]


def _parse_line(line: str) -> Dict:
    match = HOP_LINE_RE.match(line)
    if not match:
        return {}
    hop = int(match.group(1))
    remainder = match.group(2)
    is_timeout = "*" in remainder
    ip_match = IP_RE.search(remainder)
    ip_addr = ip_match.group(1) if ip_match else None
    host = remainder.split()[0] if remainder and not remainder.startswith("*") else None
    rtt_match = RTT_RE.search(remainder)
    rtt = float(rtt_match.group(1)) if rtt_match else None
    return {
        "hop": hop,
        "host": host or ip_addr,
        "ip": ip_addr,
        "rtt_ms": rtt,
        "is_timeout": is_timeout,
        "raw": line.strip(),
    }


async def run_traceroute(
    ip: str,
    *,
    max_hops: int = DEFAULT_MAX_HOPS,
    queries: int = DEFAULT_QUERIES,
    timeout: float = DEFAULT_TIMEOUT,
) -> Dict:
    """Run traceroute/tracert and parse the output minimally."""
    command = _build_command(ip, max_hops=max_hops, queries=queries)
    started_at = datetime.now(timezone.utc)
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            process.kill()
            raise RuntimeError("Traceroute timed out")
    except FileNotFoundError as exc:
        raise RuntimeError("Traceroute binary not found on host") from exc

    if process.returncode not in (0, 1):
        stderr_text = stderr.decode(errors="ignore").strip()
        raise RuntimeError(stderr_text or "Traceroute failed")

    finished_at = datetime.now(timezone.utc)
    lines = stdout.decode(errors="ignore").splitlines()
    hops: List[Dict] = []
    for line in lines:
        parsed = _parse_line(line)
        if parsed:
            hops.append(parsed)

    return {
        "ip": ip,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": (finished_at - started_at).total_seconds() * 1000,
        "hops": hops,
    }
