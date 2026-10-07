"""Report what the animated USD actually contains, so the web export reads it correctly."""
from pathlib import Path

from pxr import Usd, UsdGeom

USD = Path("/root/heart/out/tutorial_01_heart/cardiac_model.all_painted.usd")

stage = Usd.Stage.Open(str(USD))
print("file       ", USD.name, f"{USD.stat().st_size / 1024**2:.1f} MB")
print("time codes ", stage.GetStartTimeCode(), "to", stage.GetEndTimeCode(),
      "at", stage.GetTimeCodesPerSecond(), "per second")

meshes = [prim for prim in stage.Traverse() if prim.IsA(UsdGeom.Mesh)]
print("meshes     ", len(meshes))
print()

total_points = 0
total_faces = 0
for prim in meshes:
    mesh = UsdGeom.Mesh(prim)
    points = mesh.GetPointsAttr()
    samples = points.GetNumTimeSamples()
    first = points.Get(stage.GetStartTimeCode())
    counts = mesh.GetFaceVertexCountsAttr().Get(stage.GetStartTimeCode())
    n_points = len(first) if first else 0
    n_faces = len(counts) if counts else 0
    total_points += n_points
    total_faces += n_faces
    print(f"  {prim.GetName():<34} {n_points:>8} points  {n_faces:>8} faces  {samples:>3} time samples")

print()
print(f"total {total_points} points, {total_faces} faces per phase")

# Units and extent, needed before any volume is computed from these coordinates.
print()
print("metersPerUnit", UsdGeom.GetStageMetersPerUnit(stage))
print("upAxis       ", UsdGeom.GetStageUpAxis(stage))
import numpy as np
for prim in meshes:
    if prim.GetName() in ("contrast", "heart"):
        pts = np.asarray(UsdGeom.Mesh(prim).GetPointsAttr().Get(stage.GetStartTimeCode()))
        print(f"{prim.GetName():<10} bbox min {np.round(pts.min(0), 2)}  max {np.round(pts.max(0), 2)}")
