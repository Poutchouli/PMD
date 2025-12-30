import asyncio
from datetime import datetime, timezone
from typing import Dict
from sqlalchemy.future import select

from app.db import AsyncSessionLocal
from app.models import MonitorTarget, PingLog, EventLog
from app.services.pinger import ping_target

# Number of consecutive failed pings before creating an event
CONSECUTIVE_FAILURES_THRESHOLD = 5


class MonitorScheduler:
    def __init__(self):
        self.tasks: Dict[int, asyncio.Task] = {}
        self._failure_counts: Dict[int, int] = {}  # Track consecutive failures per target
        self._in_failure_state: Dict[int, bool] = {}  # Track if we already reported failure

    async def _record_event(self, target_id: int, event_type: str, message: str) -> None:
        async with AsyncSessionLocal() as session:
            session.add(EventLog(target_id=target_id, event_type=event_type, message=message))
            await session.commit()

    async def monitor_loop(self, target_id: int, ip: str, frequency: int):
        while True:
            timestamp = datetime.now(timezone.utc)
            latency, hops, loss = await ping_target(ip)
            async with AsyncSessionLocal() as session:
                session.add(
                    PingLog(
                        time=timestamp,
                        target_id=target_id,
                        latency_ms=latency,
                        hops=hops,
                        packet_loss=loss,
                    )
                )
                await session.commit()

            # Track consecutive failures and create events
            if loss:
                self._failure_counts[target_id] = self._failure_counts.get(target_id, 0) + 1
                # Create event when threshold is reached and we haven't already reported
                if (self._failure_counts[target_id] >= CONSECUTIVE_FAILURES_THRESHOLD
                        and not self._in_failure_state.get(target_id, False)):
                    self._in_failure_state[target_id] = True
                    await self._record_event(
                        target_id,
                        "failure",
                        f"Target {ip} unreachable - {self._failure_counts[target_id]} consecutive failed pings"
                    )
            else:
                # If we were in failure state and now recovered, create recovery event
                if self._in_failure_state.get(target_id, False):
                    await self._record_event(
                        target_id,
                        "recovery",
                        f"Target {ip} recovered after {self._failure_counts[target_id]} failed pings"
                    )
                # Reset failure tracking
                self._failure_counts[target_id] = 0
                self._in_failure_state[target_id] = False

            await asyncio.sleep(frequency)

    async def start_for_target(self, target: MonitorTarget):
        if target.id in self.tasks:
            return
        # Initialize failure tracking for this target
        self._failure_counts[target.id] = 0
        self._in_failure_state[target.id] = False
        task = asyncio.create_task(self.monitor_loop(target.id, target.ip_address, target.frequency))
        self.tasks[target.id] = task
        await self._record_event(target.id, "start", f"Tracking started for {target.ip_address}")

    async def stop_for_target(self, target_id: int, message: str = "Tracking stopped"):
        if target_id in self.tasks:
            self.tasks[target_id].cancel()
            self.tasks.pop(target_id, None)
        # Clean up failure tracking
        self._failure_counts.pop(target_id, None)
        self._in_failure_state.pop(target_id, None)
        await self._record_event(target_id, "stop", message)

    async def load_existing(self):
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(MonitorTarget).where(MonitorTarget.is_active == True))
            for target in result.scalars():
                await self.start_for_target(target)

    async def shutdown(self):
        for task in self.tasks.values():
            task.cancel()
        self.tasks.clear()


scheduler = MonitorScheduler()
