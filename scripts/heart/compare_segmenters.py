"""Compare the fast 3 mm segmentation with the full-resolution one on the reference phase.

The heart surface shipped to the web carries ragged sheets where the label meets the edge of
the field of view. Before working around that geometrically, it is worth knowing how much of
it is simply the fast model's coarseness.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

import itk
import numpy as np

from monai_physio import SegmentChestTotalSegmentatorWithContrast

DATA = Path.home() / "heart" / "data" / "Slicer-Heart-CT"
OUT = Path.home() / "heart" / "out" / "segmenter-comparison"
OUT.mkdir(parents=True, exist_ok=True)

frames = sorted(DATA.glob("slice_???.mha"))
reference_file = frames[int(0.7 * len(frames))]
reference = itk.imread(str(reference_file))
print("reference:", reference_file.name)

HEART_LABEL = 51

for fast in (True, False):
    name = "fast 3mm" if fast else "full 1.5mm"
    segmenter = SegmentChestTotalSegmentatorWithContrast(log_level=logging.WARNING)
    segmenter.set_fast_mode(fast)

    started = time.time()
    try:
        result = segmenter.segment(reference)
    except Exception as error:  # noqa: BLE001 - the point is to learn whether it runs at all
        print(f"{name:<12} failed after {time.time() - started:.0f} s: {type(error).__name__}: {error}")
        continue
    elapsed = time.time() - started

    labelmap = result["labelmap"]
    labels = itk.array_from_image(labelmap)
    voxel_ml = float(np.prod(itk.spacing(labelmap))) / 1000.0
    heart_ml = float((labels == HEART_LABEL).sum()) * voxel_ml

    itk.imwrite(labelmap, str(OUT / f"labelmap_{'fast' if fast else 'full'}.mha"), compression=True)
    print(f"{name:<12} {elapsed:6.0f} s  spacing {np.round(itk.spacing(labelmap), 2)}  "
          f"structures {len(np.unique(labels)) - 1:3}  heart {heart_ml:7.1f} mL")
