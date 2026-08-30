"""Rebuild `_comfyui_props_v3_workflow.json` from the committed recipe (T-0257).

Pure/offline companion to `_gen_signal_tower_props_v3.py`: renders the same
four per-panel ComfyUI graphs that script would submit, without making any
network call, and writes them (full graph JSON + `graph_hash`, per panel) to
`_comfyui_props_v3_workflow.json` -- a human-readable, resubmittable snapshot
of exactly what `signal_tower_props_concept_sheet_v3.provenance.json`'s
per-panel `workflow_hash` values refer to.

Run this after editing `signal_tower_props_concept_sheet_v3.recipe.json`'s
`panels` (prompt/seed/etc.) to refresh the snapshot file, before re-running
the real generator. It never touches the committed PNG or provenance.

Usage (from repo root):
    ~/dev/lora-train-venv/bin/python3 assets/src/concept/_tmp_rebuild_workflow_snapshot.py
"""

import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("g", "assets/src/concept/_gen_signal_tower_props_v3.py")
g = importlib.util.module_from_spec(spec)
sys.modules["g"] = g
spec.loader.exec_module(g)

raw = json.loads(g.RECIPE_PATH.read_text())
lora_name = raw["lora"]
lora_weight = raw["lora_strength"]

panels = []
for panel in raw["panels"]:
    graph = g.render_txt2img_lora_graph(
        checkpoint=raw["checkpoint"],
        lora_name=lora_name,
        lora_weight=lora_weight,
        prompt=panel["prompt"],
        negative_prompt=panel["negative_prompt"],
        seed=panel["seed"],
        steps=raw["steps"],
        cfg=raw["cfg"],
        width=raw["panel_width"],
        height=raw["panel_height"],
        sampler=raw.get("sampler", "euler"),
        scheduler=raw.get("scheduler", "normal"),
        filename_prefix=f"{raw['name']}_panel_{panel['row']}{panel['col']}",
    )
    graph_hash = g.workflow_hash(graph)
    panels.append(
        {
            "panel": f"{panel['row']}{panel['col']}",
            "label": panel["label"],
            "graph_hash": graph_hash,
            "prompt": {"prompt": graph, "client_id": g.CLIENT_ID},
        }
    )

g.OUT_WORKFLOW.write_text(json.dumps({"panels": panels}, indent=2) + "\n")
print("wrote", g.OUT_WORKFLOW)
for p in panels:
    print(p["panel"], p["graph_hash"])
