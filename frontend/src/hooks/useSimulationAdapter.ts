import { useEffect, useMemo, useRef, useState } from "react";
import { api, simulationSocket, type LogEvent, type SimulationConnection } from "../services/api";
import { useProject } from "../services/ProjectContext";

/**
 * Adapter that reshapes this project's own data sources (the simulation
 * websocket, the tag/alarm model, the backend event log) into the exact
 * `{ state, startSimulation, stopSimulation, injectFault, addEvent }` shape
 * the simulation page's visualization code expects -- so that code can be
 * dropped in unmodified instead of being rewritten against this app's
 * plumbing.
 */
export type FaultScenario =
  | "NORMAL"
  | "HIGH_TEMPERATURE"
  | "MOTOR_OVERLOAD"
  | "SENSOR_FAILURE"
  | "EMERGENCY_STOP"
  | "COMMUNICATION_LOSS";

export interface MachineState {
  speed: number;
  temperature: number;
  motorRunning: boolean;
  overload: boolean;
  emergencyStop: boolean;
  communication: boolean;
  productDetected: boolean;
  activeAlarms: string[];
  activeFault: FaultScenario;
}

export interface SimEvent {
  id: string;
  timestamp: string;
  source: "SIMULATOR" | "FAULT_INJ" | "ALARM_MGR";
  level: "success" | "error" | "warning" | "info";
  message: string;
}

function toSimEvent(e: LogEvent, i: number): SimEvent {
  const timestamp = new Date(e.timestamp * 1000).toLocaleTimeString();

  if (e.field === "scenario") {
    return { id: `${e.timestamp}-${i}`, timestamp, source: "FAULT_INJ", level: "info", message: `Scenario changed to ${e.scenario}` };
  }

  const badFields = new Set(["overload", "emergency_stop"]);
  const wentBad = badFields.has(e.field) && e.to === true;
  const commLost = e.field === "communication" && e.to === false;
  const motorStopped = e.field === "motor_running" && e.to === false;
  const recovered = (badFields.has(e.field) && e.to === false) || (e.field === "communication" && e.to === true);

  const level: SimEvent["level"] = wentBad || commLost ? "error" : motorStopped ? "warning" : recovered ? "success" : "info";
  const source: SimEvent["source"] = wentBad || commLost ? "ALARM_MGR" : "SIMULATOR";

  return {
    id: `${e.timestamp}-${i}`,
    timestamp,
    source,
    level,
    message: `${e.field} ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`,
  };
}

export function useSimulationAdapter() {
  const { project } = useProject();
  const [tags, setTags] = useState<Record<string, unknown>>({});
  const [scenario, setScenario] = useState<FaultScenario>("NORMAL");
  const [isSimRunning, setIsSimRunning] = useState(false);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const connRef = useRef<SimulationConnection | null>(null);
  const pendingScenarioRef = useRef<FaultScenario | null>(null);
  const scenarioRequestSeqRef = useRef(0);
  const hasUserSelectedScenarioRef = useRef(false);
  const scenarioRef = useRef<FaultScenario>("NORMAL");

  function setAuthoritativeScenario(next: FaultScenario) {
    scenarioRef.current = next;
    setScenario(next);
  }

  function applyServerScenario(next: unknown) {
    const serverScenario = (next as FaultScenario | undefined) ?? "NORMAL";
    if (hasUserSelectedScenarioRef.current) {
      return;
    }
    if (pendingScenarioRef.current && pendingScenarioRef.current !== serverScenario) {
      return;
    }
    pendingScenarioRef.current = null;
    setAuthoritativeScenario(serverScenario);
  }

  useEffect(() => {
    const conn = simulationSocket((data) => {
      // Once the operator has selected a fault, an old WebSocket frame must
      // never repaint the machine with another scenario's tags.
      if (!hasUserSelectedScenarioRef.current || data.scenario === scenarioRef.current) {
        setTags(data.tags ?? {});
      }
      applyServerScenario(data.scenario);
    });
    connRef.current = conn;
    return () => conn.close();
  }, []);

  // Vercel Functions do not support this app's WebSocket stream. Poll the
  // same simulation model as a fallback so deployed Virtual HMI pages still
  // display current tag values. Locally this is also a safe backup if the
  // development WebSocket briefly disconnects.
  useEffect(() => {
    let cancelled = false;
    async function pollState() {
      try {
        const snapshot = await api.simulationState();
        if (cancelled) return;
        if (!hasUserSelectedScenarioRef.current || snapshot.scenario === scenarioRef.current) {
          setTags(snapshot.tags ?? {});
        }
        applyServerScenario(snapshot.scenario);
        setIsSimRunning(snapshot.running);
      } catch {
        /* the API helper displays a concise connection error */
      }
    }
    pollState();
    const timer = setInterval(pollState, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await api.getLogs(50);
        if (cancelled) return;
        setEvents(res.events.map(toSimEvent).reverse());
      } catch {
        /* toasted globally by api.ts */
      }
    }
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const activeAlarms = useMemo(() => {
    if (!project) return [];
    return project.alarms
      .filter((a) => {
        const v = tags[a.tag];
        if (v === undefined) return false;
        const val = typeof v === "boolean" ? (v ? 1 : 0) : (v as number);
        if (a.condition === "GT") return val > a.threshold;
        if (a.condition === "LT") return val < a.threshold;
        if (a.condition === "EQ") return val === a.threshold;
        if (a.condition === "NEQ") return val !== a.threshold;
        return false;
      })
      .map((a) => a.name);
  }, [project, tags]);

  const machineState: MachineState = {
    speed: typeof tags["Motor_01_Speed"] === "number" ? (tags["Motor_01_Speed"] as number) : 0,
    temperature: typeof tags["Motor_01_Temperature"] === "number" ? (tags["Motor_01_Temperature"] as number) : 0,
    motorRunning: tags["Motor_01_Run"] === true,
    overload: tags["Motor_01_Overload"] === true,
    emergencyStop: tags["Emergency_Stop"] === true,
    communication: tags["PLC_Communication"] === true,
    productDetected: tags["Product_Sensor"] === true,
    activeAlarms,
    activeFault: scenario,
  };

  async function startSimulation() {
    await api.simulationStart();
    setIsSimRunning(true);
  }

  async function stopSimulation() {
    await api.simulationStop();
    setIsSimRunning(false);
  }

  async function injectFault(id: FaultScenario) {
    const requestSeq = scenarioRequestSeqRef.current + 1;
    scenarioRequestSeqRef.current = requestSeq;
    hasUserSelectedScenarioRef.current = true;
    pendingScenarioRef.current = id;
    setAuthoritativeScenario(id);
    setIsSimRunning(true);
    try {
      if (!isSimRunning) {
        await api.simulationStart();
        if (requestSeq !== scenarioRequestSeqRef.current) return;
      }
      const res = await api.simulationScenario(id);
      if (requestSeq !== scenarioRequestSeqRef.current) return;
      // The clicked id is authoritative. A serverless invocation can land on
      // another warm instance whose old scenario is NORMAL; never let that
      // stale response undo the operator's current selection.
      setAuthoritativeScenario(id);
      if (res.scenario === id) {
        setTags(res.tags ?? {});
      }
      // Fault injection is a runtime operation. Do not call the full
      // validation endpoint here: that endpoint intentionally evaluates every
      // scenario and can reset the simulator to NORMAL while the operator is
      // switching faults.
    } finally {
      if (requestSeq === scenarioRequestSeqRef.current) {
        pendingScenarioRef.current = null;
      }
    }
  }

  function addEvent() {
    /* events are derived automatically from the backend's own transition log */
  }

  return {
    state: { machineState, isSimRunning, events },
    startSimulation,
    stopSimulation,
    injectFault,
    addEvent,
  };
}
