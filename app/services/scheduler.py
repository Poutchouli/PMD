import asyncio
from datetime import datetime, timezone
from typing import Dict
from sqlalchemy.future import select

from app.db import AsyncSessionLocal
from app.models import MonitorTarget, PingLog, EventLog
from app.services.pinger import ping_target


class MonitorScheduler:
    def __init__(self):
        self.tasks: Dict[int, asyncio.Task] = {}

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
            await asyncio.sleep(frequency)

    async def start_for_target(self, target: MonitorTarget):
        if target.id in self.tasks:
            return
        task = asyncio.create_task(self.monitor_loop(target.id, target.ip_address, target.frequency))
        self.tasks[target.id] = task
        await self._record_event(target.id, "start", f"Tracking started for {target.ip_address}")

    async def stop_for_target(self, target_id: int, message: str = "Tracking stopped"):
        if target_id in self.tasks:
            self.tasks[target_id].cancel()
            self.tasks.pop(target_id, None)
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
