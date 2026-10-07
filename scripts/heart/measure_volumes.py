"""Measure heart volume per cardiac phase, and check whether that is even valid.

Computing the volume enclosed by a surface assumes the surface is watertight. A marching-cubes
mesh that runs into the edge of the field of view is not: an earlier attempt produced numbers
that moved by tens of per cent between two segmentations of the same scan, which is the
signature of a leaky mesh rather than of a beating heart. So the closure is measured first and
the volumes are only written if the surface holds water.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pyvista as pv
from pxr import Usd, UsdGeom

USD_FILE = Path.home() / "heart" / "out" / "tutorial_01_heart" / "cardiac_model.all_painted.usd"
RESULT = Path("/mnt/c/Users/vanio/claudeOS/projects/vanioAntunes/imaging/heart/volumes.json")
STRUCTURE = "heart"

stage = Usd.Stage.Open(str(USD_FILE))
start, end = int(stage.GetStartTimeCode()), int(stage.GetEndTimeCode())

prim = next(p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh) and p.GetName() == STRUCTURE)
mesh = UsdGeom.Mesh(prim)
faces = np.asarray(mesh.GetFaceVertexIndicesAttr().Get(start)).reshape(-1, 3)
padded = np.hstack([np.full((len(faces), 1), 3), faces]).ravel()

phases = [np.asarray(mesh.GetPointsAttr().Get(t), dtype=np.float64) for t in range(start, end + 1)]
print(f"{STRUCTURE}: {len(phases)} phases, {len(phases[0])} points, {len(faces)} faces")

reference = pv.PolyData(phases[0], padded)
open_edges = reference.extract_feature_edges(boundary_edges=True, feature_edges=False,
                                             manifold_edges=False, non_manifold_edges=False)
print(f"open boundary edges: {open_edges.n_cells}")
print(f"manifold: {reference.is_manifold}")

if open_edges.n_cells > 0:
    print()
    print("The surface is open, so an enclosed volume is not defined for it.")
    print("No volume numbers written; the page will not claim any.")
    if RESULT.exists():
        RESULT.unlink()
        print("removed stale", RESULT)
    raise SystemExit(0)

volumes = []
for points in phases:
    surface = pv.PolyData(points, padded)
    volumes.append(float(surface.volume) * 1e6)

largest, smallest = max(volumes), min(volumes)
summary = {
    "label": STRUCTURE,
    "perPhase": [round(v, 1) for v in volumes],
    "largest": round(largest, 1),
    "smallest": round(smallest, 1),
    "swing": round(largest - smallest, 1),
    "swingPercent": round((largest - smallest) / largest * 100.0, 1),
    "largestPhase": int(np.argmax(volumes)),
    "smallestPhase": int(np.argmin(volumes)),
    "method": "closed heart surface, verified watertight, per registered phase",
}
print(f"largest {summary['largest']} mL phase {summary['largestPhase']}, "
      f"smallest {summary['smallest']} mL phase {summary['smallestPhase']}, "
      f"swing {summary['swingPercent']}%")
RESULT.write_text(json.dumps(summary, indent=2))
print("written", RESULT)
