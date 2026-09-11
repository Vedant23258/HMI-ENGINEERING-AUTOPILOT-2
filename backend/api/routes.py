import json
import os
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from fastapi.responses import PlainTextResponse

from backend.api.schemas import (
    LoadProjectRequest, PlanRequest, ApplyRequest, ScenarioRequest,
    ApproveRequest, BreakBindingRequest, ScriptRequest, ImportTagsRequest, MentorRequest,
    FactoryRunRequest, AutopilotRunRequest,
)
from backend.api import store
from backend.parser.project_parser import parse_project_dict, summarize
from backend.graph.graph_builder import build_graph, graph_to_json
from backend.ai.planner import generate_plan
from backend.models.engineering import EngineeringPlan
from backend.hmi.project_generator import apply_plan
from backend.validation.validator import run_full_validation
from backend.ai.self_correction import run_self_correction
from backend.ai.llm_client import llm_client
from backend.ai.impact_analyzer import analyze_impact
from backend.graph.project_graph import ProjectGraph
from backend.simulator.machine import simulator
from backend.simulator.log_analyzer import analyze_log
from backend.scripts.script_generator import generate_script
from backend.migration.migration_assistant import export_tags_csv, import_tags_csv, import_tags_json
from backend.mentor.engineering_mentor import ask_mentor
from backend.factory.runner import run_factory

router = APIRouter(prefix="/api")

# Serverless platforms (Vercel) ship a read-only filesystem except /tmp --
# write generated exports there instead of into the repo checkout.
GENERATED_DIR = Path("/tmp/hmi_generated") if os.environ.get("VERCEL") else (
    Path(__file__).resolve().parent.parent.parent / "generated"
)
GENERATED_DIR.mkdir(parents=True, exist_ok=True)


@router.post("/projects/load")
def load_project(req: LoadProjectRequest):
    if req.project_data:
        project = parse_project_dict(req.project_data)
    else:
        project = store.load_demo()
    store.set_project(req.project_id, project)
    return {"project_id": req.project_id, "summary": summarize(project)}


@router.get("/projects/{project_id}")
def get_project(project_id: str):
    try:
        project = store.get_project(project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"project": project.model_dump(), "summary": summarize(project),
            "approved": store.is_approved(project_id)}


@router.get("/projects/{project_id}/graph")
def get_graph(project_id: str):
    try:
        project = store.get_project(project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    g = build_graph(project)
    return graph_to_json(g)


@router.get("/engineering/impact")
def engineering_impact(node_id: str, project_id: str = "demo"):
    """Deterministic graph-based change impact analysis for a given tag/screen/
    object/alarm node. Pure NetworkX traversal -- no LLM involved."""
    try:
        project = store.get_project(project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    graph = ProjectGraph(build_graph(project))
    return analyze_impact(graph, node_id)


@router.post("/engineering/plan")
def engineering_plan(req: PlanRequest):
    try:
        project = store.get_project(req.project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    plan = generate_plan(req.requirement, project)
    return {"plan": plan.model_dump(), "mock_mode": llm_client.mock_mode}


@router.post("/engineering/apply")
def engineering_apply(req: ApplyRequest):
    try:
        project = store.get_project(req.project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    try:
        plan = EngineeringPlan.model_validate(req.plan)
    except Exception as e:
        raise HTTPException(422, f"Invalid EngineeringPlan: {e}")
    log = apply_plan(project, plan)
    store.set_project(req.project_id, project, unapprove=True)
    return {"log": log, "project": project.model_dump(), "summary": summarize(project)}


@router.post("/autopilot/run")
async def autopilot_run(req: AutopilotRunRequest):
    """Runs the full customer-facing autopilot pipeline in one call: reset the
    machine model, interpret the requirement into an EngineeringPlan, apply it
    (create tags/screens/objects/alarms/navigation), validate the result, and
    auto-correct if anything failed. This is the same real plan/apply/validate/
    self-correction code used everywhere else in the app -- just chained
    together so the frontend can show one continuous loading experience
    instead of the customer operating each engineering step by hand."""
    project = store.load_demo()
    store.set_project(req.project_id, project)

    plan = generate_plan(req.requirement, project)
    log = apply_plan(project, plan)
    store.set_project(req.project_id, project, unapprove=True)

    validation = run_full_validation(project)
    correction = None
    if validation["status"] != "PASS":
        correction = run_self_correction(project)
        validation = correction["final_validation"]

    simulator.start()
    simulator.set_scenario("NORMAL")

    return {
        "project_id": req.project_id,
        "requirement": req.requirement,
        "plan": plan.model_dump(),
        "apply_log": log,
        "validation": validation,
        "correction": correction,
        "summary": summarize(project),
        "mock_mode": llm_client.mock_mode,
    }


@router.post("/simulation/start")
async def simulation_start(req: ApproveRequest):
    simulator.start()
    return {"status": "STARTED", "state": simulator.state}


@router.post("/simulation/stop")
async def simulation_stop(req: ApproveRequest):
    simulator.stop()
    return {"status": "STOPPED", "state": simulator.state}


@router.post("/simulation/scenario")
def simulation_scenario(req: ScenarioRequest):
    try:
        state = simulator.set_scenario(req.scenario)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"scenario": req.scenario, "state": state, "tags": simulator.as_tags()}


@router.get("/simulation/state")
def simulation_state():
    """Return a simulation snapshot for serverless deployments.

    Vercel Functions do not keep WebSocket connections open. The browser uses
    this lightweight endpoint as a polling fallback, so the Virtual HMI works
    in production as well as during local WebSocket development.
    """
    # A local process advances state in its broadcast loop. In a serverless
    # function invocation there is no durable loop, so advance once per poll.
    if simulator.is_running:
        simulator.tick()
    return {
        "scenario": simulator.scenario,
        "state": simulator.state,
        "tags": simulator.as_tags(),
        "running": simulator.is_running,
    }


@router.websocket("/ws/simulation")
async def ws_simulation(ws: WebSocket):
    await ws.accept()
    simulator.start()

    async def send(payload):
        await ws.send_json(payload)

    simulator.subscribe(send)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        simulator.unsubscribe(send)


@router.get("/validation")
def get_validation(project_id: str = "demo"):
    try:
        project = store.get_project(project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return run_full_validation(project)


@router.post("/autofix")
def autofix(req: ApproveRequest):
    try:
        project = store.get_project(req.project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    result = run_self_correction(project)
    store.set_project(req.project_id, project, unapprove=True)
    return result


@router.post("/demo/break-binding")
def break_binding(req: BreakBindingRequest):
    """Intentionally introduces a MISSING_BINDING defect for the demo self-correction flow."""
    try:
        project = store.get_project(req.project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    obj = None
    for s in project.screens:
        for o in s.objects:
            if o.id == req.object_id:
                obj = o
    if not obj:
        raise HTTPException(404, f"Object '{req.object_id}' not found")
    obj.tag = None
    store.set_project(req.project_id, project, unapprove=True)
    return {"status": "BROKEN", "object_id": obj.id}


@router.post("/review/approve")
def approve(req: ApproveRequest):
    try:
        project = store.get_project(req.project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    validation = run_full_validation(project)
    if validation["status"] != "PASS":
        raise HTTPException(400, "Cannot approve: validation has not passed")
    store.approve(req.project_id)
    return {"status": "APPROVED", "project_id": req.project_id}


@router.get("/export")
def export_project(project_id: str = "demo"):
    try:
        project = store.get_project(project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    validation = run_full_validation(project)
    g = build_graph(project)

    files = {
        "project.json": project.model_dump(),
        "project_graph.json": graph_to_json(g),
        "tags.json": [t.model_dump() for t in project.tags],
        "screens.json": [s.model_dump() for s in project.screens],
        "alarms.json": [a.model_dump() for a in project.alarms],
        "validation_report.json": validation,
        "simulation_report.json": {"scenario": simulator.scenario, "state": simulator.state},
    }

    out_dir = GENERATED_DIR
    for name, content in files.items():
        with open(out_dir / name, "w", encoding="utf-8") as f:
            json.dump(content, f, indent=2)

    zip_path = out_dir / "hmi_engineering_project_package.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in files:
            zf.write(out_dir / name, arcname=name)

    return {"status": "EXPORTED", "files": list(files.keys()), "zip": str(zip_path.name),
            "approved": store.is_approved(project_id)}


@router.get("/export/download")
def download_export():
    zip_path = GENERATED_DIR / "hmi_engineering_project_package.zip"
    if not zip_path.exists():
        raise HTTPException(404, "No export found; call /api/export first")
    return FileResponse(zip_path, filename=zip_path.name, media_type="application/zip")


# --- Script Generator ------------------------------------------------------

@router.post("/scripts/generate")
def scripts_generate(req: ScriptRequest):
    try:
        project = store.get_project(req.project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    try:
        return generate_script(project, req.target_type, req.target_id)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/scripts/targets")
def scripts_targets(project_id: str = "demo"):
    """Lists valid (target_type, target_id) options the generator can run against."""
    try:
        project = store.get_project(project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    objects = [
        {"target_type": "object", "target_id": o.id, "label": f"{s.name} / {o.label or o.id} ({o.object_type})"}
        for s in project.screens for o in s.objects
    ]
    alarms = [{"target_type": "alarm", "target_id": a.id, "label": a.name} for a in project.alarms]
    screens = [{"target_type": "screen", "target_id": s.id, "label": s.name} for s in project.screens]
    return {"objects": objects, "alarms": alarms, "screens": screens}


# --- Migration Assistant ----------------------------------------------------

@router.get("/migration/export-tags")
def migration_export_tags(project_id: str = "demo"):
    try:
        project = store.get_project(project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return PlainTextResponse(export_tags_csv(project), media_type="text/csv")


@router.post("/migration/import-tags")
def migration_import_tags(req: ImportTagsRequest):
    try:
        project = store.get_project(req.project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    try:
        if req.format == "json":
            result = import_tags_json(project, req.content)
        else:
            result = import_tags_csv(project, req.content)
    except ValueError as e:
        raise HTTPException(422, str(e))
    store.set_project(req.project_id, project, unapprove=True)
    return {**result, "summary": summarize(project)}


# --- Engineering Mentor ------------------------------------------------------

@router.post("/mentor/ask")
def mentor_ask(req: MentorRequest):
    try:
        project = store.get_project(req.project_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    if not req.question.strip():
        raise HTTPException(422, "question must not be empty")
    return ask_mentor(req.question, project)


# --- System Log Analyzer ----------------------------------------------------

@router.get("/logs")
def get_logs(limit: int = 50):
    return {"events": list(simulator.log)[-limit:], "total": len(simulator.log)}


@router.get("/logs/analyze")
def analyze_logs():
    return analyze_log(list(simulator.log))


# --- Synthetic Engineering Data Factory --------------------------------------

@router.post("/factory/run")
def factory_run(req: FactoryRunRequest):
    return run_factory(count=req.count, seed=req.seed, max_defects=req.max_defects)
