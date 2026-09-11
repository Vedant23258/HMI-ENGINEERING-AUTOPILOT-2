import { pushToast } from "./toast";

const BASE = "/api";

function friendlyMessage(e: unknown): string {
  if (e instanceof TypeError) {
    return "Cannot reach the backend API. Is it running on http://localhost:8000?";
  }
  return e instanceof Error ? e.message : String(e);
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
  } catch (e) {
    const msg = friendlyMessage(e);
    pushToast("error", msg);
    throw new Error(msg);
  }

  // Read the body as text exactly once, then try to interpret it as JSON.
  // This is resilient to non-JSON error pages (e.g. a 502 from the Vite
  // dev proxy when the backend is down, which returns HTML, not JSON).
  const raw = await res.text().catch(() => "");
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? String((parsed as { detail: unknown }).detail)
        : raw || res.statusText;
    const msg = `${path} failed (${res.status}): ${detail}`;
    pushToast("error", msg);
    throw new Error(msg);
  }

  if (parsed === undefined && raw) {
    const msg = `${path} returned a non-JSON response`;
    pushToast("error", msg);
    throw new Error(msg);
  }

  return parsed as T;
}

async function reqText(path: string, opts?: RequestInit): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (e) {
    const msg = friendlyMessage(e);
    pushToast("error", msg);
    throw new Error(msg);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const msg = `${path} failed (${res.status}): ${text || res.statusText}`;
    pushToast("error", msg);
    throw new Error(msg);
  }
  return text;
}

export interface Tag {
  name: string;
  data_type: string;
  unit?: string | null;
  description?: string | null;
  source?: string | null;
}

export interface HmiObject {
  id: string;
  object_type: string;
  tag?: string | null;
  label?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Screen {
  id: string;
  name: string;
  objects: HmiObject[];
}

export interface Alarm {
  id: string;
  name: string;
  tag: string;
  condition: string;
  threshold: number;
  severity: string;
}

export interface NavigationLink {
  from_screen: string;
  to_screen: string;
  label?: string | null;
}

export interface Project {
  project: { name: string; version: string; description?: string | null };
  tags: Tag[];
  screens: Screen[];
  alarms: Alarm[];
  navigation: NavigationLink[];
  scripts: unknown[];
  dependencies: { source: string; target: string; relation: string }[];
}

export interface ProjectSummary {
  project_name: string;
  tag_count: number;
  screen_count: number;
  object_count: number;
  alarm_count: number;
  navigation_count: number;
  dependency_count: number;
  tags: string[];
  screens: string[];
  alarms: string[];
}

export interface GraphNode {
  id: string;
  kind: string;
  [k: string]: unknown;
}
export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  [k: string]: unknown;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface EngineeringAction {
  action: string;
  screen?: string | null;
  object_id?: string | null;
  object_type?: string | null;
  tag?: string | null;
  label?: string | null;
  alarm?: string | null;
  threshold?: number | null;
  condition?: string | null;
  severity?: string | null;
  from_screen?: string | null;
  to_screen?: string | null;
  reason?: string | null;
}

export interface EngineeringPlan {
  summary: string;
  actions: EngineeringAction[];
  unknowns: string[];
}

export interface ApplyLogEntry {
  action: string;
  status: "APPLIED" | "REJECTED" | "SKIPPED";
  reason?: string;
  [k: string]: unknown;
}

export interface ValidationIssue {
  id: string;
  type: string;
  severity: string;
  message: string;
  screen?: string;
  object?: string;
}

export interface ScenarioResult {
  scenario: string;
  status: "PASS" | "FAILED";
  fired_alarms: string[];
  expected_alarms: string[];
  issues: string[];
}

export interface ValidationResult {
  status: "PASS" | "FAILED";
  structural_issues: ValidationIssue[];
  scenario_results: ScenarioResult[];
  summary: { structural_issue_count: number; scenarios_passed: number; scenarios_total: number };
}

export interface SelfCorrectionResult {
  cycles: { cycle: number; status: string; actions: ApplyLogEntry[] }[];
  final_status: "PASS" | "FAILED";
  final_validation: ValidationResult;
}

export interface AutopilotResult {
  project_id: string;
  requirement: string;
  plan: EngineeringPlan;
  apply_log: ApplyLogEntry[];
  validation: ValidationResult;
  correction: SelfCorrectionResult | null;
  summary: ProjectSummary;
  mock_mode: boolean;
}

export const api = {
  loadProject: (project_id = "demo") =>
    req<{ project_id: string; summary: ProjectSummary }>("/projects/load", {
      method: "POST",
      body: JSON.stringify({ project_id }),
    }),

  getProject: (project_id = "demo") =>
    req<{ project: Project; summary: ProjectSummary; approved: boolean }>(`/projects/${project_id}`),

  getGraph: (project_id = "demo") => req<GraphData>(`/projects/${project_id}/graph`),

  getImpact: (node_id: string, project_id = "demo") =>
    req<{
      node: string;
      kind?: string;
      status: "OK" | "UNKNOWN";
      affected_count?: number;
      affected?: { id: string; kind: string }[];
      depends_on_this?: { id: string; kind: string }[];
      this_depends_on?: { id: string; kind: string }[];
    }>(`/engineering/impact?node_id=${encodeURIComponent(node_id)}&project_id=${project_id}`),

  plan: (requirement: string, project_id = "demo") =>
    req<{ plan: EngineeringPlan; mock_mode: boolean }>("/engineering/plan", {
      method: "POST",
      body: JSON.stringify({ project_id, requirement }),
    }),

  apply: (plan: EngineeringPlan, project_id = "demo") =>
    req<{ log: ApplyLogEntry[]; project: Project; summary: ProjectSummary }>("/engineering/apply", {
      method: "POST",
      body: JSON.stringify({ project_id, plan }),
    }),

  simulationStart: (project_id = "demo") =>
    req<{ status: string; state: Record<string, unknown> }>("/simulation/start", {
      method: "POST",
      body: JSON.stringify({ project_id }),
    }),

  simulationStop: (project_id = "demo") =>
    req<{ status: string; state: Record<string, unknown> }>("/simulation/stop", {
      method: "POST",
      body: JSON.stringify({ project_id }),
    }),

  simulationScenario: (scenario: string, project_id = "demo") =>
    req<{ scenario: string; state: Record<string, unknown>; tags: Record<string, unknown> }>(
      "/simulation/scenario",
      { method: "POST", body: JSON.stringify({ project_id, scenario }) }
    ),

  simulationState: () => req<SimulationSnapshot>("/simulation/state"),

  getValidation: (project_id = "demo") => req<ValidationResult>(`/validation?project_id=${project_id}`),

  autofix: (project_id = "demo") =>
    req<SelfCorrectionResult>("/autofix", { method: "POST", body: JSON.stringify({ project_id }) }),

  breakBinding: (object_id: string, project_id = "demo") =>
    req<{ status: string; object_id: string }>("/demo/break-binding", {
      method: "POST",
      body: JSON.stringify({ project_id, object_id }),
    }),

  approve: (project_id = "demo") =>
    req<{ status: string; project_id: string }>("/review/approve", {
      method: "POST",
      body: JSON.stringify({ project_id }),
    }),

  exportProject: (project_id = "demo") =>
    req<{ status: string; files: string[]; zip: string; approved: boolean }>(
      `/export?project_id=${project_id}`
    ),

  downloadUrl: () => `${BASE}/export/download`,

  // --- Autopilot (customer requirement -> full engineering pipeline) ---
  autopilotRun: (requirement: string, project_id = "demo") =>
    req<AutopilotResult>("/autopilot/run", {
      method: "POST",
      body: JSON.stringify({ project_id, requirement }),
    }),

  health: () => req<{ status: string }>("/health"),

  // --- Script Generator ---
  scriptTargets: (project_id = "demo") =>
    req<ScriptTargets>(`/scripts/targets?project_id=${project_id}`),

  generateScript: (target_type: string, target_id: string, project_id = "demo") =>
    req<{ language: string; code: string }>("/scripts/generate", {
      method: "POST",
      body: JSON.stringify({ project_id, target_type, target_id }),
    }),

  // --- Migration Assistant ---
  exportTagsCsv: (project_id = "demo") => reqText(`/migration/export-tags?project_id=${project_id}`),

  importTags: (content: string, format: "csv" | "json", project_id = "demo") =>
    req<{ added: string[]; skipped: { row: number; name?: string; reason: string }[]; added_count: number; skipped_count: number; summary: ProjectSummary }>(
      "/migration/import-tags",
      { method: "POST", body: JSON.stringify({ project_id, format, content }) }
    ),

  // --- Engineering Mentor ---
  askMentor: (question: string, project_id = "demo") =>
    req<{ answer: string; mock_mode: boolean }>("/mentor/ask", {
      method: "POST",
      body: JSON.stringify({ project_id, question }),
    }),

  // --- System Log Analyzer ---
  getLogs: (limit = 50) => req<{ events: LogEvent[]; total: number }>(`/logs?limit=${limit}`),

  analyzeLogs: () => req<LogAnalysis>("/logs/analyze"),

  // --- Synthetic Engineering Data Factory ---
  runFactory: (count: number, seed = 42, max_defects = 2) =>
    req<FactoryResult>("/factory/run", {
      method: "POST",
      body: JSON.stringify({ count, seed, max_defects }),
    }),
};

export interface FactoryVariant {
  id: string;
  machine_type: string;
  project_name: string;
  tag_count: number;
  screen_count: number;
  alarm_count: number;
  defects_injected: { type: string; detail: string }[];
  issues_before: number;
  issues_after: number;
  final_status: "PASS" | "FAILED";
}
export interface FactoryResult {
  generated: number;
  validated: number;
  defective_variants: number;
  clean_variants: number;
  total_defects_injected: number;
  defect_type_counts: Record<string, number>;
  auto_corrected: number;
  needs_review: number;
  machine_type_counts: Record<string, number>;
  seed: number;
  variants: FactoryVariant[];
}

export interface ScriptTargetOption {
  target_type: "object" | "alarm" | "screen";
  target_id: string;
  label: string;
}
export interface ScriptTargets {
  objects: ScriptTargetOption[];
  alarms: ScriptTargetOption[];
  screens: ScriptTargetOption[];
}

export interface LogEvent {
  timestamp: number;
  field: string;
  from: unknown;
  to: unknown;
  scenario: string;
}
export interface LogAnalysis {
  total_events: number;
  field_counts: Record<string, number>;
  fault_event_count: number;
  fault_events: LogEvent[];
  scenario_change_count: number;
  recent_events: LogEvent[];
}

export interface SimulationSnapshot {
  scenario: string;
  state: Record<string, unknown>;
  tags: Record<string, unknown>;
  running: boolean;
}

export interface SimulationConnection {
  close: () => void;
}

/**
 * Opens the simulation WebSocket and auto-reconnects with backoff if the
 * connection drops (backend restart, network blip). onStatus reports
 * "connecting" | "open" | "closed" so the UI can show live-connection state
 * instead of silently freezing.
 */
export function simulationSocket(
  onMessage: (data: any) => void,
  onStatus?: (status: "connecting" | "open" | "closed") => void
): SimulationConnection {
  let ws: WebSocket | null = null;
  let closedByCaller = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closedByCaller) return;
    onStatus?.("connecting");
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${window.location.host}/api/ws/simulation`);

    ws.onopen = () => {
      attempt = 0;
      onStatus?.("open");
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      onStatus?.("closed");
      if (closedByCaller) return;
      attempt += 1;
      const delay = Math.min(1000 * attempt, 5000);
      reconnectTimer = setTimeout(connect, delay);
    };
    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return {
    close: () => {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
