import { useNavigate } from "react-router-dom";
import { useSimulationAdapter, type FaultScenario, type MachineState } from "../hooks/useSimulationAdapter";
import { useProject } from "../services/ProjectContext";

/* ---------------------------------------------------------------------------
 * Virtual Machine Simulation page.
 *
 * This is a drop-in port of the provided simulation-page design: the same
 * layout, the same fault-injection list, the same machine-visualization SVG
 * and signal-chain logic, unchanged. The only things adapted for this
 * project are (1) data plumbing -- `useSimulationAdapter` stands in for the
 * original `useApp()` context and exposes the identical
 * `{ state, startSimulation, stopSimulation, injectFault, addEvent }` shape
 * so none of the visualization logic below had to change -- and (2) theme --
 * literal hex colors and fonts were swapped for this app's CSS variables and
 * font stack (`--ok`/`--crit`/`--warn`/`--accent`/`--panel`/`--border`/
 * `--text-dim`, Cascadia Code for mono) so it matches light/dark mode here.
 * -------------------------------------------------------------------------*/

const OK = "var(--ok)";
const CRIT = "var(--crit)";
const WARN = "var(--warn)";
const INFO = "var(--accent)";
const BORDER = "var(--border)";
const PANEL = "var(--panel)";
const PANEL_2 = "var(--panel-2)";
const TEXT_DIM = "var(--text-dim)";
const TEXT = "var(--text)";
const MONO_FONT = "'Cascadia Code', 'Consolas', monospace";
const UI_FONT = "'Segoe UI', 'Inter', system-ui, sans-serif";

function mix(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

const FAULT_SCENARIOS: { id: FaultScenario; label: string; desc: string; color: string }[] = [
  { id: "NORMAL", label: "Normal", desc: "Motor running at 72 RPM, temp stable", color: OK },
  { id: "HIGH_TEMPERATURE", label: "High Temperature", desc: "Temperature rises above 80°C threshold", color: WARN },
  { id: "MOTOR_OVERLOAD", label: "Motor Overload", desc: "Overload relay trips, motor stops", color: CRIT },
  { id: "SENSOR_FAILURE", label: "Sensor Failure", desc: "Product_Detected goes offline", color: WARN },
  { id: "EMERGENCY_STOP", label: "Emergency Stop", desc: "E-Stop circuit opens, all motion halts", color: CRIT },
  { id: "COMMUNICATION_LOSS", label: "Comm Loss", desc: "PLC Ethernet/IP disconnected", color: WARN },
];

export function VirtualHmi() {
  const navigate = useNavigate();
  const { advanceStage } = useProject();
  const { state, startSimulation, stopSimulation, injectFault } = useSimulationAdapter();
  const { machineState: ms, isSimRunning, events } = state;

  const simEvents = events.filter((e) => ["SIMULATOR", "FAULT_INJ", "ALARM_MGR"].includes(e.source ?? ""));

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: BORDER, color: TEXT }}>
        {/* Top bar */}
        <div className="flex items-center px-4 py-2 border-b shrink-0 gap-4" style={{ borderColor: BORDER, background: PANEL }}>
          <h1 className="font-bold text-lg tracking-wider uppercase">Virtual Machine Simulation</h1>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={isSimRunning ? stopSimulation : startSimulation}
              className="font-bold text-sm px-4 py-1.5 rounded-sm uppercase tracking-widest transition-all"
              style={{
                background: isSimRunning ? mix(CRIT, 20) : mix(OK, 20),
                color: isSimRunning ? CRIT : OK,
                border: `1px solid ${isSimRunning ? mix(CRIT, 40) : mix(OK, 40)}`,
              }}
            >
              {isSimRunning ? "■ Stop Simulation" : "▶ Start Simulation"}
            </button>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row">
          {/* Machine visualization */}
          <div className="flex-1 overflow-hidden flex flex-col lg:border-r" style={{ borderColor: BORDER }}>
            <div className="px-4 py-2 border-b shrink-0" style={{ borderColor: BORDER, background: PANEL }}>
              <span className="text-xs font-semibold tracking-widest uppercase" style={{ color: TEXT_DIM }}>
                Machine Visualization — Packaging Conveyor Line
              </span>
            </div>
            <div className="flex-1 flex items-center justify-center p-4 overflow-x-auto">
              <MachineVisualization ms={ms} />
            </div>

            {/* Live telemetry strip */}
            <div className="border-t px-4 py-2 shrink-0" style={{ borderColor: BORDER, background: PANEL }}>
              <div className="flex gap-6 flex-wrap">
                {[
                  { label: "SPEED", value: `${ms.speed.toFixed(0)} RPM`, warn: false },
                  { label: "TEMP", value: `${ms.temperature.toFixed(1)}°C`, warn: ms.temperature > 80 },
                  { label: "MOTOR", value: ms.motorRunning ? "RUNNING" : "STOPPED", warn: !ms.motorRunning && isSimRunning },
                  { label: "PLC", value: ms.communication ? "CONNECTED" : "LOST", warn: !ms.communication },
                  { label: "OVERLOAD", value: ms.overload ? "TRIPPED" : "OK", warn: ms.overload },
                  { label: "E-STOP", value: ms.emergencyStop ? "ACTIVE" : "CLEAR", warn: ms.emergencyStop },
                  { label: "PRODUCT", value: ms.productDetected ? "DETECTED" : "—", warn: false },
                ].map((row) => (
                  <div key={row.label} className="flex flex-col gap-0.5">
                    <span className="mono text-xs" style={{ color: TEXT_DIM }}>
                      {row.label}
                    </span>
                    <span
                      className={`mono text-xs font-bold ${row.warn ? "animate-pulse-red" : ""}`}
                      style={{ color: row.warn ? CRIT : ms.motorRunning || row.label === "PLC" ? OK : TEXT_DIM }}
                    >
                      {row.value}
                    </span>
                  </div>
                ))}
                {ms.activeAlarms.map((a) => (
                  <div key={a} className="flex flex-col gap-0.5">
                    <span className="mono text-xs" style={{ color: TEXT_DIM }}>
                      ALARM
                    </span>
                    <span className="mono text-xs font-bold animate-pulse-amber" style={{ color: WARN }}>
                      ⚠ {a.split(" ").slice(0, 2).join(" ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right panel: fault injection + timeline */}
          <div className="lg:w-72 shrink-0 flex flex-col overflow-hidden">
            {/* Fault injection */}
            <div className="p-3 border-b shrink-0" style={{ borderColor: BORDER }}>
              <div className="text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: TEXT_DIM }}>
                Fault Injection
              </div>
              <div className="space-y-1.5">
                {FAULT_SCENARIOS.map((s) => {
                  const active = ms.activeFault === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => void injectFault(s.id)}
                      className="w-full flex items-start gap-2 p-2 rounded-sm text-left transition-all"
                      style={{
                        background: active ? mix(s.color, 10) : PANEL_2,
                        border: `1px solid ${active ? mix(s.color, 53) : BORDER}`,
                      }}
                    >
                      <div
                        className="w-2 h-2 rounded-full mt-1 shrink-0 transition-all"
                        style={{ background: active ? s.color : BORDER, boxShadow: active ? `0 0 6px ${s.color}` : "none" }}
                      />
                      <div>
                        <div className="font-semibold text-xs tracking-wide" style={{ color: active ? s.color : TEXT_DIM }}>
                          {s.label}
                        </div>
                        <div className="mono text-xs" style={{ color: TEXT_DIM, fontSize: 9 }}>
                          {s.desc}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Signal chain visualization */}
            {ms.activeFault !== "NORMAL" && (
              <div className="p-3 border-b" style={{ borderColor: BORDER }}>
                <div className="text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: TEXT_DIM }}>
                  Signal Chain
                </div>
                <SignalChain fault={ms.activeFault} />
              </div>
            )}

            {/* Event timeline */}
            <div className="flex-1 overflow-y-auto p-3" style={{ maxHeight: 340 }}>
              <div className="text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: TEXT_DIM }}>
                Simulation Events
              </div>
              <div className="space-y-1.5">
                {simEvents.slice(0, 30).map((ev) => (
                  <div key={ev.id} className="flex items-start gap-2 animate-fade-up">
                    <span className="mono shrink-0" style={{ fontSize: 9, color: BORDER, marginTop: 2 }}>
                      {ev.timestamp}
                    </span>
                    <span
                      className="mono text-xs"
                      style={{
                        color: ev.level === "success" ? OK : ev.level === "error" ? CRIT : ev.level === "warning" ? WARN : TEXT_DIM,
                      }}
                    >
                      {ev.message}
                    </span>
                  </div>
                ))}
                {simEvents.length === 0 && (
                  <div className="mono text-xs" style={{ color: BORDER }}>
                    Start simulation to see events
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => {
            advanceStage(6);
            navigate("/workspace/validation");
          }}
          className="px-5 py-2.5 rounded bg-[var(--accent)] text-[#03121c] font-semibold text-sm hover:opacity-90 active:scale-95 transition-all duration-150"
        >
          Continue to Validation →
        </button>
      </div>
    </div>
  );
}

// ─── Signal Chain ─────────────────────────────────────────────────────────────

function SignalChain({ fault }: { fault: FaultScenario }) {
  const chains: Record<FaultScenario, string[]> = {
    NORMAL: [],
    HIGH_TEMPERATURE: [
      "Motor_Temperature > 80°C",
      "Tag Value Updated",
      "Temp_Display refreshed",
      "High_Temp_Alarm triggered",
      "AlarmDiagnostics updated",
    ],
    MOTOR_OVERLOAD: ["Motor_Overload = true", "Motor state → STOPPED", "Overload_Ind activated", "Overload_Alarm triggered", "Motor_Run = false"],
    SENSOR_FAILURE: ["Product_Detected offline", "Tag value = INVALID", "Product indicator cleared", "Sensor Failure alarm"],
    EMERGENCY_STOP: ["Emergency_Stop = true", "Motor_Run forced false", "Speed → 0 RPM", "EStop_Alarm triggered", "All motion halted"],
    COMMUNICATION_LOSS: ["PLC_Communication = false", "All tags → stale", "Comm status indicator → RED", "CommLoss_Alarm triggered"],
  };
  const steps = chains[fault] ?? [];
  const color = fault === "NORMAL" ? OK : ["MOTOR_OVERLOAD", "EMERGENCY_STOP"].includes(fault) ? CRIT : WARN;

  return (
    <div className="space-y-1">
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: mix(color, 53) }} />
          <span className="mono text-xs" style={{ color: i === 0 ? color : TEXT_DIM, fontSize: 9 }}>
            {s}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Machine Visualization ────────────────────────────────────────────────────

function MachineVisualization({ ms }: { ms: MachineState }) {
  const running = ms.motorRunning && !ms.emergencyStop;
  const hasAlarm = ms.activeAlarms.length > 0;
  const commOk = ms.communication;
  const tempColor = ms.temperature > 80 ? CRIT : ms.temperature > 65 ? WARN : OK;
  const tempPct = Math.min(100, ((ms.temperature - 20) / 80) * 100);

  return (
    <div className="relative" style={{ width: 600, height: 320 }}>
      <svg width={600} height={320} className="absolute inset-0">
        {/* Background grid */}
        <defs>
          <pattern id="sim-grid" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M 16 0 L 0 0 0 16" fill="none" stroke={BORDER} strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={600} height={320} fill="url(#sim-grid)" />

        {/* ── MOTOR ASSEMBLY ── */}
        <rect x={50} y={110} width={90} height={80} rx={4} fill={PANEL_2} stroke={running ? mix(OK, 53) : BORDER} strokeWidth={1.5} />
        <text x={95} y={105} textAnchor="middle" style={{ fontSize: 9, fill: TEXT_DIM, fontFamily: MONO_FONT, letterSpacing: 2 }}>
          MOTOR
        </text>
        <g transform="translate(95,150)">
          <circle r={28} fill={PANEL} stroke={running ? OK : BORDER} strokeWidth={1.5} />
          <g style={{ animation: running ? "spin-slow 3s linear infinite" : "none", transformOrigin: "0px 0px" }}>
            <line x1={0} y1={-20} x2={0} y2={20} stroke={running ? mix(OK, 40) : BORDER} strokeWidth={2} />
            <line x1={-20} y1={0} x2={20} y2={0} stroke={running ? mix(OK, 40) : BORDER} strokeWidth={2} />
            <line x1={-14} y1={-14} x2={14} y2={14} stroke={running ? mix(OK, 27) : BORDER} strokeWidth={1.5} />
            <line x1={14} y1={-14} x2={-14} y2={14} stroke={running ? mix(OK, 27) : BORDER} strokeWidth={1.5} />
          </g>
          <circle r={5} fill={running ? OK : BORDER} />
        </g>
        <rect x={52} y={178} width={86} height={10} rx={1} fill={running ? mix(OK, 27) : PANEL_2} />
        <text x={95} y={186} textAnchor="middle" style={{ fontSize: 7, fill: running ? OK : TEXT_DIM, fontFamily: MONO_FONT, letterSpacing: 2 }}>
          {running ? "● RUNNING" : "● STOPPED"}
        </text>

        <text x={95} y={205} textAnchor="middle" style={{ fontSize: 11, fill: running ? INFO : TEXT_DIM, fontFamily: MONO_FONT, fontWeight: 600 }}>
          {ms.speed.toFixed(0)} RPM
        </text>

        {/* Drive shaft */}
        <rect x={140} y={147} width={30} height={6} rx={1} fill={PANEL_2} stroke={BORDER} strokeWidth={1} />

        {/* ── CONVEYOR ── */}
        <rect x={170} y={130} width={280} height={8} rx={2} fill={PANEL_2} stroke={BORDER} strokeWidth={1} />
        <rect x={170} y={162} width={280} height={8} rx={2} fill={PANEL_2} stroke={BORDER} strokeWidth={1} />

        <clipPath id="sim-conv-clip">
          <rect x={170} y={138} width={280} height={24} />
        </clipPath>
        <g clipPath="url(#sim-conv-clip)">
          {Array.from({ length: 18 }).map((_, i) => (
            <line
              key={i}
              x1={170 + i * 16}
              y1={138}
              x2={170 + i * 16}
              y2={162}
              stroke={BORDER}
              strokeWidth={1}
              style={{ animation: running ? "conveyor-move 1.5s linear infinite" : "none" }}
            />
          ))}
        </g>

        {running &&
          [0, 1, 2].map((i) => (
            <rect
              key={i}
              x={180 + (i * 90) % 260}
              y={138}
              width={22}
              height={24}
              rx={1}
              fill={PANEL_2}
              stroke={mix(INFO, 40)}
              strokeWidth={1}
              style={{
                animation: `item-move ${3.5 + i * 0.4}s linear infinite`,
                animationDelay: `${-i * 1.2}s`,
              }}
            />
          ))}

        <circle cx={173} cy={150} r={12} fill={PANEL_2} stroke={BORDER} strokeWidth={1.5} />
        <circle cx={173} cy={150} r={5} fill={BORDER} />
        <circle cx={447} cy={150} r={12} fill={PANEL_2} stroke={BORDER} strokeWidth={1.5} />
        <circle cx={447} cy={150} r={5} fill={BORDER} />

        <text x={310} y={122} textAnchor="middle" style={{ fontSize: 9, fill: TEXT_DIM, fontFamily: MONO_FONT, letterSpacing: 3 }}>
          PACKAGING CONVEYOR
        </text>

        {/* ── PRODUCT SENSOR ── */}
        <rect x={460} y={110} width={70} height={80} rx={4} fill={PANEL_2} stroke={ms.productDetected ? mix(INFO, 53) : BORDER} strokeWidth={1.5} />
        <text x={495} y={105} textAnchor="middle" style={{ fontSize: 9, fill: TEXT_DIM, fontFamily: MONO_FONT, letterSpacing: 2 }}>
          SENSOR
        </text>
        <line x1={460} y1={150} x2={447} y2={150} stroke={ms.productDetected ? INFO : BORDER} strokeWidth={1} strokeDasharray="3,2" />
        <circle cx={495} cy={150} r={16} fill={PANEL} stroke={ms.productDetected ? INFO : BORDER} strokeWidth={1.5} />
        <circle
          cx={495}
          cy={150}
          r={ms.productDetected ? 10 : 7}
          fill={ms.productDetected ? mix(INFO, 20) : PANEL_2}
          stroke={ms.productDetected ? INFO : BORDER}
          strokeWidth={1}
          style={{ transition: "all 0.15s" }}
        />
        <circle cx={495} cy={150} r={3} fill={ms.productDetected ? INFO : BORDER} />
        <text x={495} y={185} textAnchor="middle" style={{ fontSize: 7, fill: ms.productDetected ? INFO : TEXT_DIM, fontFamily: MONO_FONT, letterSpacing: 1 }}>
          {ms.productDetected ? "DETECTED" : "IDLE"}
        </text>

        {/* ── TEMPERATURE GAUGE ── */}
        <text x={95} y={250} textAnchor="middle" style={{ fontSize: 9, fill: TEXT_DIM, fontFamily: MONO_FONT, letterSpacing: 2 }}>
          TEMPERATURE
        </text>
        <rect x={40} y={255} width={110} height={8} rx={2} fill={PANEL_2} stroke={BORDER} strokeWidth={1} />
        <rect x={40} y={255} width={tempPct * 1.1} height={8} rx={2} fill={mix(tempColor, 53)} style={{ transition: "all 0.5s" }} />
        <text x={155} y={262} style={{ fontSize: 9, fill: tempColor, fontFamily: MONO_FONT, fontWeight: 600 }}>
          {ms.temperature.toFixed(1)}°C
        </text>

        {/* ── PLC COMM STATUS ── */}
        <rect x={220} y={220} width={120} height={50} rx={4} fill={PANEL_2} stroke={commOk ? mix(INFO, 40) : mix(CRIT, 40)} strokeWidth={1.5} />
        <text x={280} y={238} textAnchor="middle" style={{ fontSize: 9, fill: TEXT_DIM, fontFamily: MONO_FONT, letterSpacing: 2 }}>
          PLC LINK
        </text>
        <circle cx={260} cy={255} r={5} fill={commOk ? OK : CRIT} style={{ filter: commOk ? "none" : `drop-shadow(0 0 4px ${CRIT})` }} />
        <text x={270} y={259} style={{ fontSize: 10, fill: commOk ? OK : CRIT, fontFamily: MONO_FONT, fontWeight: 700 }}>
          {commOk ? "CONNECTED" : "LOST"}
        </text>

        {/* ── ALARM PANEL ── */}
        <rect x={370} y={220} width={160} height={80} rx={4} fill={PANEL_2} stroke={hasAlarm ? mix(CRIT, 40) : BORDER} strokeWidth={1.5} />
        <text x={450} y={235} textAnchor="middle" style={{ fontSize: 9, fill: TEXT_DIM, fontFamily: MONO_FONT, letterSpacing: 2 }}>
          ACTIVE ALARMS
        </text>
        {ms.activeAlarms.length === 0 ? (
          <text x={450} y={258} textAnchor="middle" style={{ fontSize: 9, fill: OK, fontFamily: MONO_FONT }}>
            ● ALL CLEAR
          </text>
        ) : (
          ms.activeAlarms.slice(0, 3).map((a, i) => (
            <text key={i} x={378} y={252 + i * 14} style={{ fontSize: 8, fill: WARN, fontFamily: MONO_FONT }}>
              ⚠ {a.slice(0, 22)}
            </text>
          ))
        )}

        {/* ── EMERGENCY STOP INDICATOR ── */}
        {ms.emergencyStop && (
          <g>
            <rect x={230} y={50} width={140} height={40} rx={4} fill={mix(CRIT, 27)} stroke={CRIT} strokeWidth={2} />
            <text x={300} y={75} textAnchor="middle" style={{ fontSize: 14, fill: CRIT, fontFamily: UI_FONT, fontWeight: 700, letterSpacing: 3 }}>
              ⬛ E-STOP ACTIVE
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
