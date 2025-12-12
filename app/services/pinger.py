import asyncio
import platform
import re
from datetime import datetime
from typing import Tuple, Optional

from app.config import get_settings

settings = get_settings()
PING_SEMAPHORE = asyncio.Semaphore(settings.ping_concurrency_limit)


async def _run_ping(ip: str) -> Tuple[Optional[float], Optional[int], bool]:
    """Run system ping once and parse results into latency/hops/loss."""
    param = "-n" if platform.system().lower() == "windows" else "-c"
    command = ["ping", param, "1", ip]

    try:
        async with PING_SEMAPHORE:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=settings.ping_timeout)
    except asyncio.TimeoutError:
        return None, None, True
    except Exception:
        return None, None, True

    output = stdout.decode()
    if process.returncode != 0:
        return None, None, True

    latency_match = re.search(r"time[=<]([\d\.]+)", output)
    latency = float(latency_match.group(1)) if latency_match else None

    ttl_match = re.search(r"TTL=(\d+)", output, re.IGNORECASE)
    ttl = int(ttl_match.group(1)) if ttl_match else 64
    initial_ttl = 64
    if ttl > 64:
        initial_ttl = 128
    if ttl > 128:
        initial_ttl = 255
    hops = initial_ttl - ttl

    return latency, hops, False


async def ping_target(ip: str) -> Tuple[Optional[float], Optional[int], bool]:
    # Wrapper kept for backward compatibility
    return await _run_ping(ip)
