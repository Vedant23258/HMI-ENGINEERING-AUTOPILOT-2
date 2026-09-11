# HMI Engineering Autopilot

AI that doesn't just generate an HMI screen — it understands engineering
dependencies, builds an HMI project representation, runs it against a
virtual machine, detects engineering failures, fixes them where it safely
can, validates the result, and hands it to an engineer for approval.

This is an **engineering automation system**, not a chatbot and not a
screen-generation toy.

## 1. Problem

HMI engineering (Schneider Electric EcoStruxure Operator Terminal Expert
and similar tools) is manual, repetitive, and error-prone: tags get bound
incorrectly, alarms get created without valid tag references, screens get
built without navigation paths, and these mistakes are usually only caught
during commissioning — on the plant floor.

## 2. Solution

A pipeline that treats HMI engineering as a **graph of dependencies**
(tags → objects → screens → alarms → navigation) rather than a pile of
independent files:

```
Existing HMI Project + Templates
        │
        ▼
   Deterministic Parser  (tags / screens / alarms / objects / navigation)
        │
        ▼
   Project Graph (NetworkX)
        │
        ▼
   AI Engineering Planner  (requirement → structured JSON plan)
        │
        ▼
   Deterministic Plan Executor  (HMI Generator)
        │
        ▼
   Virtual HMI Simulator  ⇄  Validation Engine (structural + behavioral)
        │
        ▼
   Self-Correction  (detect → explain → propose fix → re-validate, max 3 cycles)
        │
        ▼
   Engineer Review (approve / feedback / manual edit)
        │
        ▼
   Final HMI Project + Validation Report (export package)
```

## 3. Why it's different

- **Grounded, not hallucinated.** The LLM never invents a tag, screen, or
  engineering fact. Every action it proposes is validated against the
  actual parsed project before it is applied. If something can't be
  grounded, the system returns `UNKNOWN` / `REQUIRES_ENGINEER_INPUT`
  instead of guessing.
- **Deterministic execution.** The LLM produces a structured
  `EngineeringPlan` (Pydantic-validated JSON). A separate, deterministic
  Python layer (`backend/hmi/*`) is the only code that ever mutates the
  project. JSON parsing, graph construction, alarm-threshold comparisons,
  and simulation are never delegated to the LLM.
- **Self-correcting, bounded.** When validation fails (e.g. a missing tag
  binding), the system proposes a grounded correction, applies it, and
  re-validates — capped at 3 cycles so it can never loop forever.
- **Runs with zero API key.** A deterministic mock planner reproduces the
  full requirement → plan → generate → validate → self-correct workflow
  without any LLM credits, for demoing or CI.

## 4. Architecture

| Layer | Responsibility | LLM used? |
|---|---|---|
| `backend/parser` | Parse the neutral JSON project format | No |
| `backend/graph` | Build/query the NetworkX dependency graph | No |
| `backend/ai/planner.py` | Requirement → structured `EngineeringPlan` | Yes (or deterministic mock) |
| `backend/ai/self_correction.py` | Detect issues → propose grounded fixes | Rule-based (LLM-ready) |
| `backend/ai/impact_analyzer.py` | Graph-based change impact (upstream deps / downstream impact) | No |
| `backend/hmi/*` | Deterministically executes plans against the project | No |
| `backend/simulator` | Virtual packaging conveyor / motor machine state + live event log | No |
| `backend/validation` | Structural + behavioral + scenario validation | No |
| `backend/factory` | Synthetic Engineering Data Factory (variant generation, defect injection) | No |
| `backend/api` | FastAPI REST + WebSocket surface | — |
| `frontend` | React/TypeScript/Tailwind industrial UI | — |

## 5. Tech stack

- **Backend:** Python, FastAPI, Pydantic v2, NetworkX, WebSockets
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, react-router
- **AI:** Anthropic Claude (optional) via `ANTHROPIC_API_KEY`; deterministic
  mock planner used automatically when no key is configured

## 6. Demo workflow

The bundled demo project is **Packaging Line 01**: a motor/conveyor system
with 8 tags, 3 screens, 4 alarms, and a navigation hierarchy.

Primary navigation follows the product's actual lifecycle: **Overview →
Engineering → Project Graph → Virtual HMI → Validation → Review/Export**.
Secondary "Engineering Tools" (Data Factory, Builders, Scripts, Migration,
Mentor, System Log) sit in a collapsed sub-nav so they don't compete with
that core story.

1. **Overview** — the Engineering Control Center. A dominant 8-stage
   pipeline (Input → Project Graph → AI Generation → Simulation →
   Validation → Self-Correction → Approval → Export) shows exactly where
   this project is right now, computed from real state — not decorative.
   A live activity feed lists every real engineering action taken.
2. **Engineering** — enter a requirement (pre-filled):
   > "Add a motor overview screen showing motor speed, temperature and
   > overload status. Add a high-temperature alarm and make the screen
   > accessible from main navigation."
   The AI planner produces a structured `EngineeringPlan`, grounded only
   in existing tags/screens; apply it and the new screen/objects/alarm/nav
   link are generated deterministically.
3. **Project Graph** — the hero dependency view: Screen → Object → Tag →
   Alarm relationships from NetworkX, live. Click any node to see exactly
   what it depends on and what would be affected if it changed — the
   impact set is highlighted and traced across the graph, not just direct
   neighbors.
4. **Virtual HMI** — an interactive device topology (drag devices, click
   to inspect live values) plus the generated screens with live tag
   values streamed over WebSocket. **Inject Fault**: NORMAL,
   HIGH_TEMPERATURE, MOTOR_OVERLOAD, EMERGENCY_STOP, COMMUNICATION_LOSS —
   a cause → effect trace shows the fault propagating through tags, the
   HMI, and alarms.
5. **Validation** — Inject Broken Binding intentionally removes a tag
   binding; validation detects `MISSING_BINDING` and FAILS; AI Auto-Fix
   proposes and applies a grounded correction, re-validates — PASS.
6. **Review / Export** — Approve (only allowed once validation PASSes),
   then export a `Generated HMI Engineering Project Package` (JSON files +
   validation/simulation reports, zipped).

## 7. Installation

### Backend

```bash
python -m venv venv
# Windows: venv\Scripts\activate    macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # optional: add ANTHROPIC_API_KEY to use a real LLM
uvicorn backend.main:app --reload --port 8000
```

API docs: `http://localhost:8000/docs`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

App: `http://localhost:5173` (proxies `/api` to `http://localhost:8000`)

### Tests

```bash
pytest tests/ -v
```

20 tests cover the parser, graph, plan execution (including rejection of
invented tags), structural + behavioral + scenario validation, and the
self-correction cycle (including the bounded-retry guarantee).

### Deploy the full stack on Vercel

This repository is configured as one Vercel project, not as a frontend-only
site: Vercel builds `frontend/` into the static app and deploys
`api/index.py` as the FastAPI serverless function behind `/api/*`.

1. Import this GitHub repository in Vercel and keep the project root as the
   repository root.
2. Deploy with the checked-in `vercel.json`; no separate frontend or backend
   project is needed.
3. Optionally set `ANTHROPIC_API_KEY`, `LLM_PROVIDER`, and `MODEL` in Vercel
   Project Settings → Environment Variables. Without a key the app uses its
   built-in deterministic mock planner.

The Virtual HMI automatically polls `/api/simulation/state` on Vercel because
Vercel Functions do not provide persistent WebSocket connections. The rest of
the API is served normally. Generated export files use Vercel's temporary
filesystem and are therefore available only for the active function instance.

## 8. Environment variables

See `.env.example`:

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=
MODEL=claude-sonnet-5
```

Leave `ANTHROPIC_API_KEY` blank to run entirely in mock mode — the full
workflow still works, using a deterministic keyword-based planner grounded
in the same project graph.

## 9. Demo scenarios (virtual machine)

| Scenario | Motor | Speed | Temp | Overload | E-Stop | Comms | Expected alarm |
|---|---|---|---|---|---|---|---|
| NORMAL | running | ~72 | ~56°C | off | off | ok | none |
| HIGH_TEMPERATURE | running | ~68 | 90°C | off | off | ok | High Temperature |
| MOTOR_OVERLOAD | stopped | 0 | ~78°C | **on** | off | ok | Motor Overload |
| EMERGENCY_STOP | stopped | 0 | ~50°C | off | **on** | ok | Emergency Stop |
| COMMUNICATION_LOSS | running | ~72 | ~56°C | off | off | **lost** | Communication Loss |

## 10. Validation & self-correction

- **Structural:** missing/invalid tag bindings, invalid alarm tag
  references, broken navigation targets, screens with no navigation path.
- **Behavioral / simulation:** for every scenario above, asserts the
  expected alarm(s) fire and core rules hold (`RULE_ESTOP_STOPS_MOTOR`,
  `RULE_COMM_LOSS_ALARM`, etc. — see `data/rules/engineering_rules.json`).
- **Self-correction:** capped at **3 cycles**. Each cycle re-runs full
  validation; if no correction can be applied (nothing is grounded in
  existing project data), the issue is reported as
  `REQUIRES_ENGINEER_INPUT` rather than guessed at.

## 11. Export format

`GET /api/export` writes to `generated/`:

```
generated/
├── project.json              # full neutral project representation
├── project_graph.json        # NetworkX graph as nodes/edges
├── tags.json
├── screens.json
├── alarms.json
├── validation_report.json
├── simulation_report.json
└── hmi_engineering_project_package.zip
```

This is explicitly a **Generated HMI Engineering Project Package** — a
vendor-neutral structured representation used to demonstrate the workflow.
It is **not** a native Schneider EOTE project file.

## 11.5 Extended tool suite

Six more tools, reachable from the collapsed "Engineering Tools" sub-nav so
they don't compete with the core Overview → Export story, extend the
workflow. Each is scoped honestly to what this project can actually verify
— see 12. Limitations for exactly what real EOTE access would additionally
unlock for each.

| Tool | What it does | Honest scope |
|---|---|---|
| **Data Factory** | Generates many synthetic HMI project variants across 5 machine templates, injects seeded structural defects, and runs them through the real validator + self-correction engine, reporting aggregate counts | Every number is directly counted from real validator runs — not a trained model. Behavioral/scenario validation is skipped here since it's hardcoded to the demo machine's tags (structural-only evaluation) |
| **Builders** | Direct forms for creating alarms and navigation links, using the same deterministic executor as the AI planner (`POST /api/engineering/apply`) | Neutral schema, not a verified EOTE alarm-config/navigation-object field layout |
| **Scripts** | Generates event-handler pseudocode per screen/alarm/object, grounded only in real tags | IEC 61131-3 Structured-Text *style* (a real, public, vendor-neutral standard) — **not** EOTE's proprietary scripting language/runtime |
| **Migration** | Imports/exports a generic CSV or JSON tag list into the neutral project | Tag-metadata migration only — **not** a native EOTE project file migration |
| **Mentor** | Grounded Q&A about *this* project — bindings, alarms, navigation, validation, self-correction, etc. Deterministic FAQ + live project status in mock mode; routes to the configured LLM (still snapshot-grounded) otherwise | Answers only from a fixed FAQ + this project's actual current state, never invented facts |
| **System Log** | Records and analyzes this app's own simulator's live state-transition log (motor/conveyor/alarm field changes, scenario switches) | Real log from this process's real simulator — **not** a real PLC/machine fault log or Modbus register capture |

Backend modules: `backend/scripts/script_generator.py`,
`backend/migration/migration_assistant.py`, `backend/mentor/engineering_mentor.py`,
`backend/simulator/log_analyzer.py`, `backend/factory/*`. 19 dedicated tests in
`tests/test_new_features.py` plus 20 in `tests/test_factory.py`.

## 12. Limitations

- The neutral JSON project format is not a parser/writer for EOTE's actual
  proprietary project format — that structure has not been verified against
  official documentation in this MVP.
- The mock LLM planner uses fuzzy token matching against real project data,
  not true NLU. It is deliberately transparent — every action it proposes is
  still re-validated deterministically before being applied, and it reports
  an `unknown` rather than inventing a fact (a tag, a threshold) it can't
  ground.
- Simulation is a small deterministic state machine with jitter, not a
  physics engine or digital twin.
- Single in-memory project store (no database, no multi-user concurrency).
- The Script Generator, Migration Assistant, and System Log Analyzer are
  each scoped to what this project could verify without external access —
  see the table above and the next section for exactly what's missing.

## 13. Future EOTE adapter, real scripting runtime, and real fault-log analysis (not implemented)

Closing the remaining gaps honestly requires external inputs this project
was not given, not more engineering time on what's already here:

1. **Real EOTE project file access** — an actual `.xxx` project export/
   import format spec, SDK/API from Schneider, or at minimum a sample real
   EOTE project file to reverse-engineer. Without this, native EOTE
   migration and "real" EOTE project parsing/generation stay out of reach —
   it's a data-access problem, not a time problem.
2. **EOTE's scripting language/runtime spec** (syntax, object model,
   available functions) plus an interpreter or the actual EOTE runtime to
   test against — needed for the Script Generator to produce verifiably
   correct EOTE scripts rather than neutral structured-text pseudocode.
3. **A real machine/PLC tag list and communication protocol sample** (e.g.
   a Modbus register map) — needed for the System Log Analyzer to work
   against real fault logs rather than this project's own simulator log.
4. **An actual EOTE alarm/navigation schema reference** (required fields
   for their alarm config / navigation objects) — needed so the Alarm
   Configuration Generator and Navigation Builder outputs resemble real
   EOTE structures rather than this project's own neutral JSON schema.
5. **More time** for a genuine Engineering Mentor UX (persistent chat
   history, contextual teaching moments triggered by what the engineer is
   doing) and a genuine multi-format Migration Assistant with per-target
   format-conversion logic, beyond the CSV/JSON tag-list scope here.

`backend/hmi` already separates "generate against a project model" from
"serialize a project model" specifically so a real EOTE adapter could slot
in later without a rewrite — but it is **not implemented or verified** in
this MVP. Until items 1–4 above are available, all claims in this README
are scoped to the neutral representation.

## 14. Project structure

```
hmi-engineering-autopilot/
├── backend/
│   ├── main.py                  # FastAPI app entrypoint
│   ├── api/                     # routes, request schemas, in-memory store
│   ├── ai/                      # planner, self-correction, impact analysis, LLM client
│   ├── parser/                  # deterministic project JSON parser
│   ├── graph/                   # NetworkX graph builder + queries
│   ├── hmi/                     # deterministic plan executor / generators
│   ├── simulator/                # virtual machine state + scenarios + live event log
│   ├── validation/               # structural + behavioral + scenario tests
│   ├── factory/                  # Synthetic Engineering Data Factory (templates, defect injection, runner)
│   ├── scripts/, migration/, mentor/  # Engineering Tools backends
│   └── models/                  # Pydantic schemas (project + engineering plan)
├── frontend/
│   └── src/
│       ├── pages/                # Dashboard (Overview), Engineering, ProjectGraph, VirtualHmi,
│       │                         # Validation, Review, DataFactory, Builders, Scripts, Migration, Mentor, Logs
│       ├── components/           # GraphView, PlantScene, PipelineStepper, Panel, StatusPill
│       └── services/              # API client, ProjectContext (project state + activity log)
├── data/
│   ├── demo_project.json         # Packaging Line 01 demo project
│   ├── templates/                # motor_card, alarm_panel, navigation_template
│   ├── assets/                   # motor, conveyor, sensor asset definitions
│   └── rules/                    # deterministic engineering rules
├── generated/                    # export output (gitignored except .gitkeep)
├── tests/                        # pytest suite (81 tests)
├── requirements.txt
├── .env.example
└── README.md
```
