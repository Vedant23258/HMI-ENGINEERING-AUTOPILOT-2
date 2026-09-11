"""Virtual packaging conveyor / motor system simulator.

Deterministic state machine. No physics engine, no external simulator —
just a small, demoable, deterministic model of machine state + scenarios.
"""
import asyncio
import random
import time
from collections import deque
from typing import Callable, Awaitable

BOOL_FIELDS = ("motor_running", "overload", "emergency_stop", "communication", "conveyor_running", "product_sensor")
LOG_MAX_EVENTS = 300

DEFAULT_STATE = {
    "motor_running": True,
    "speed": 72.0,
    "temperature": 56.0,
    "overload": False,
    "conveyor_running": True,
    "product_sensor": True,
    "emergency_stop": False,
    "communication": True,
}

SCENARIOS = {
    "NORMAL": {
        "motor_running": True, "speed": 72.0, "temperature": 56.0, "overload": False,
        "conveyor_running": True, "product_sensor": True, "emergency_stop": False, "communication": True,
    },
    "HIGH_TEMPERATURE": {
        "motor_running": True, "speed": 68.0, "temperature": 90.0, "overload": False,
        "conveyor_running": True, "product_sensor": True, "emergency_stop": False, "communication": True,
    },
    "MOTOR_OVERLOAD": {
        "motor_running": False, "speed": 0.0, "temperature": 78.0, "overload": True,
        "conveyor_running": False, "product_sensor": True, "emergency_stop": False, "communication": True,
    },
    "EMERGENCY_STOP": {
        "motor_running": False, "speed": 0.0, "temperature": 50.0, "overload": False,
        "conveyor_running": False, "product_sensor": True, "emergency_stop": True, "communication": True,
    },
    "COMMUNICATION_LOSS": {
        "motor_running": True, "speed": 72.0, "temperature": 56.0, "overload": False,
        "conveyor_running": True, "product_sensor": True, "emergency_stop": False, "communication": False,
    },
    "SENSOR_FAILURE": {
        "motor_running": True, "speed": 72.0, "temperature": 56.0, "overload": False,
        "conveyor_running": True, "product_sensor": False, "emergency_stop": False, "communication": True,
    },
}

TAG_MAP = {
    "Motor_01_Run": "motor_running",
    "Motor_01_Speed": "speed",
    "Motor_01_Temperature": "temperature",
    "Motor_01_Overload": "overload",
    "Conveyor_01_Run": "conveyor_running",
    "Product_Sensor": "product_sensor",
    "Emergency_Stop": "emergency_stop",
    "PLC_Communication": "communication",
}


class MachineSimulator:
    def __init__(self):
        self.state: dict = dict(DEFAULT_STATE)
        self.scenario = "NORMAL"
        self._task: asyncio.Task | None = None
        self._running = False
        self._subscribers: list[Callable[[dict], Awaitable[None]]] = []
        # Real event log of this simulator's own state transitions -- not
        # synthetic/fabricated data, it's generated live by this process.
        self.log: deque = deque(maxlen=LOG_MAX_EVENTS)
        self._prev_bool_state: dict = {k: DEFAULT_STATE[k] for k in BOOL_FIELDS}

    def _record_transitions(self, state: dict) -> None:
        for field in BOOL_FIELDS:
            new_val = state.get(field)
            if self._prev_bool_state.get(field) != new_val:
                self.log.append({
                    "timestamp": time.time(), "field": field,
                    "from": self._prev_bool_state.get(field), "to": new_val,
                    "scenario": self.scenario,
                })
        self._prev_bool_state = {k: state.get(k) for k in BOOL_FIELDS}

    def set_scenario(self, name: str) -> dict:
        if name not in SCENARIOS:
            raise ValueError(f"Unknown scenario '{name}'")
        self.scenario = name
        self.state = dict(SCENARIOS[name])
        self.log.append({
            "timestamp": time.time(), "field": "scenario", "from": None, "to": name,
            "scenario": name,
        })
        self._record_transitions(self.state)
        return self.state

    def tick(self) -> dict:
        """Advance state slightly (jitter) while respecting the active scenario baseline."""
        base = SCENARIOS[self.scenario]
        state = dict(self.state)
        if state["motor_running"] and not state["emergency_stop"]:
            jitter = random.uniform(-1.5, 1.5)
            state["speed"] = max(0.0, base["speed"] + jitter)
            state["temperature"] = max(0.0, base["temperature"] + random.uniform(-0.8, 0.8))
        else:
            state["speed"] = 0.0
            state["temperature"] = base["temperature"]
        state["motor_running"] = base["motor_running"]
        state["overload"] = base["overload"]
        state["conveyor_running"] = base["conveyor_running"]
        state["product_sensor"] = base["product_sensor"]
        state["emergency_stop"] = base["emergency_stop"]
        state["communication"] = base["communication"]
        self._record_transitions(state)
        self.state = state
        return self.state

    def as_tags(self) -> dict:
        return {tag: self.state[field] for tag, field in TAG_MAP.items()}

    def subscribe(self, cb: Callable[[dict], Awaitable[None]]):
        self._subscribers.append(cb)

    def unsubscribe(self, cb):
        if cb in self._subscribers:
            self._subscribers.remove(cb)

    async def _broadcast_loop(self):
        while True:
            self.tick()
            payload = {"scenario": self.scenario, "state": self.state, "tags": self.as_tags(),
                       "timestamp": time.time()}
            for cb in list(self._subscribers):
                try:
                    await cb(payload)
                except Exception:
                    pass
            await asyncio.sleep(1.0)

    def start(self):
        self._running = True
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._broadcast_loop())

    def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            self._task = None

    @property
    def is_running(self) -> bool:
        return self._running


simulator = MachineSimulator()
