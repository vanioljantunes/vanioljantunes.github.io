"""Why the surfaces are perforated, and where the CT sits relative to the exported model.

Two questions at once, because both are answered from the reference labelmap:

1. Are the holes in the heart and aorta simply voxels the segmenter assigned to the contrast
   agent? Labels are exclusive, so contrast-filled blood inside a chamber belongs to
   `contrast` and not to `heart`, and marching cubes then carves it out of the wall.
2. How do CT physical coordinates map onto the coordinates in the USD? Needed before CT slice
   planes can be placed behind the model the way 3D Slicer shows them.
"""
from __future__ import annotations

from pathlib import Path

import itk
import numpy as np
from pxr import Usd, UsdGeom
from scipy import ndimage

from monai_physio import SegmentChestTotalSegmentatorWithContrast

OUT = Path.home() / "heart" / "out" / "tutorial_01_heart"
LABELMAP = OUT / "slice_014_labelmap.mha"
USD_FILE = OUT / "cardiac_model.all_painted.usd"

HEART, AORTA = 51, 52

image = itk.imread(str(LABELMAP))
labels = itk.array_from_image(image)
spacing = np.array(itk.spacing(image))
voxel_ml = float(np.prod(spacing)) / 1000.0

present = sorted(int(v) for v in np.unique(labels) if v)
print("labels present:", present)
print("contrast group:", SegmentChestTotalSegmentatorWithContrast().taxonomy.labels_in_group("contrast"))

print()
for label_id, name in [(HEART, "heart"), (AORTA, "aorta")]:
    mask = labels == label_id
    if not mask.any():
        print(f"{name}: absent from this labelmap")
        continue
    filled = ndimage.binary_fill_holes(mask)
    holes = filled & ~mask
    print(f"{name}: {mask.sum() * voxel_ml:7.1f} mL solid, {holes.sum() * voxel_ml:7.1f} mL of interior holes")
    for other in np.unique(labels[holes]):
        count = int((holes & (labels == other)).sum())
        print(f"    hole voxels labelled {int(other):>4}: {count * voxel_ml:7.1f} mL")

print()
print("CT physical extent (ITK, mm)")
size = np.array(itk.size(image))
origin = np.array(itk.origin(image))
print("  origin  ", np.round(origin, 1))
print("  far     ", np.round(origin + (size - 1) * spacing, 1))
print("  spacing ", np.round(spacing, 3), " size", size)
print("  direction\n", np.round(itk.array_from_matrix(image.GetDirection()), 3))

heart_voxels = np.argwhere(labels == HEART)
idx_min = heart_voxels.min(axis=0)[::-1]
idx_max = heart_voxels.max(axis=0)[::-1]
print("  heart label bbox mm:", np.round(origin + idx_min * spacing, 1), "to",
      np.round(origin + idx_max * spacing, 1))

stage = Usd.Stage.Open(str(USD_FILE))
prim = next(p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh) and p.GetName() == "heart")
points = np.asarray(UsdGeom.Mesh(prim).GetPointsAttr().Get(stage.GetStartTimeCode()))
print("  heart mesh bbox mm :", np.round(points.min(axis=0) * 1000, 1), "to",
      np.round(points.max(axis=0) * 1000, 1))
