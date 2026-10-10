"""Build clean cardiac surfaces and move them through the cardiac cycle.

This replaces reading surfaces out of the USD. The USD meshes are perforated: they come from
contours extracted per phase, so each phase meshes slightly different voxels and the result is
pitted. Here the surface is built once, from the reference labelmap, as a watertight surface,
and then carried to every phase by the transforms the registration already produced. One
surface, one topology, twenty-one sets of positions.

Two things follow. The holes go, because `extract_watertight_surface` closes the mask before
meshing. And volume becomes meaningful, because a watertight surface encloses one.

Everything stays in CT physical millimetres, which is also where the CT slice planes live, so
the planes and the model line up the way 3D Slicer shows them.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import itk
import numpy as np
import pyvista as pv
from PIL import Image
from scipy import ndimage

from monai_physio import ProcessContours

OUT = Path.home() / "heart" / "out" / "tutorial_01_heart"
DATA = Path.home() / "heart" / "data" / "Slicer-Heart-CT"
MESHES = Path.home() / "heart" / "out" / "web-meshes"
WEB_DIR = Path("/mnt/c/Users/vanio/claudeOS/projects/vanioAntunes/imaging/heart")
MESHES.mkdir(parents=True, exist_ok=True)

REFERENCE_PHASE = 14

# label id -> (vertex budget, colour, label)
#
# The heart alone. The great vessels are cut mid-course by the field of view and their walls
# are roughly one voxel thick, so they mesh into fragments rather than tubes: the aorta
# encloses 1.0 mL against 7.1 mL of labelled voxels. Shipping them would mean shipping debris.
WANTED: dict[int, tuple[int, str, str]] = {
    51: (16000, "#b4563f", "Heart"),
}

contours = ProcessContours(log_level=logging.WARNING)


def mask_image(labels: np.ndarray, label_id: int, reference: itk.Image):
    """Binary mask for one label, with interior holes closed and islands dropped."""
    mask = labels == label_id
    if mask.sum() < 500:
        return None
    mask = ndimage.binary_fill_holes(mask)
    components, count = ndimage.label(mask)
    if count > 1:
        # Keep every substantial piece, not just the biggest one. A vessel cut by the edge of
        # the field of view arrives in several pieces, and keeping one of them leaves the rest
        # as debris floating beside the heart.
        sizes = ndimage.sum(mask, components, range(1, count + 1))
        keep = [i + 1 for i, size in enumerate(sizes) if size >= 0.15 * sizes.max()]
        mask = np.isin(components, keep)
    image = itk.image_from_array(mask.astype(np.uint8))
    image.CopyInformation(reference)
    return image



def export_ct_planes(ct_file: Path, heart_bounds: np.ndarray) -> dict:
    """Write three orthogonal CT slices as RGBA PNGs, with their corners in physical millimetres.

    The planes cut through the middle of the heart, the way a reader sets them in a viewer.

    Air is transparent. A CT slice rendered opaque is mostly a black rectangle that blocks
    whatever is behind it; mapping Hounsfield units to alpha lets the lungs fade and the air
    disappear, leaving the chest wall, mediastinum and vessels as a translucent backdrop.
    """
    image = itk.imread(str(ct_file))
    array = itk.array_from_image(image).astype(np.float32)   # (z, y, x)
    size = np.array(itk.size(image))                         # (x, y, z)

    # Through the middle of the heart. Anchoring a plane outside the organ only works from
    # one viewing direction: orbit a quarter turn and the "backdrop" is in front, hiding the
    # anatomy. A slice through the centre cuts the heart the way a reader sets it in a viewer,
    # and reads as intentional from every angle.
    centre_mm = heart_bounds.mean(axis=0)
    anchors = np.clip(
        np.array(image.TransformPhysicalPointToIndex([float(v) for v in centre_mm])),
        0, size - 1)

    def corners(axis: int, at: int) -> list[list[float]]:
        """Physical corners of the plane: (0,0), (max,0), (max,max), (0,max) in index space."""
        spans = [i for i in range(3) if i != axis]
        out = []
        for first, second in ((0, 0), (1, 0), (1, 1), (0, 1)):
            idx = [0, 0, 0]
            idx[axis] = int(at)
            idx[spans[0]] = int((size[spans[0]] - 1) * first)
            idx[spans[1]] = int((size[spans[1]] - 1) * second)
            out.append([float(v) for v in image.TransformIndexToPhysicalPoint(idx)])
        return out

    # Mediastinal window for the greys, and a separate ramp for alpha so air drops out.
    level, width = 40.0, 400.0
    low_hu, high_hu = level - width / 2, level + width / 2

    planes = []
    for axis, name in ((2, "axial"), (1, "coronal"), (0, "sagittal")):
        at = int(anchors[axis])
        if axis == 2:
            plane = array[at, :, :]
        elif axis == 1:
            plane = array[:, at, :]
        else:
            plane = array[:, :, at]

        grey = np.clip((plane - low_hu) / (high_hu - low_hu), 0, 1)
        alpha = np.clip((plane + 900.0) / 300.0, 0, 1)   # -1000 HU air out, soft tissue solid
        rgba = np.dstack([
            (grey * 255).astype(np.uint8),
            (grey * 255).astype(np.uint8),
            (grey * 255).astype(np.uint8),
            (alpha * 255).astype(np.uint8),
        ])
        png = WEB_DIR / f"ct_{name}.png"
        Image.fromarray(rgba, mode="RGBA").save(png)
        planes.append({"name": name, "axis": axis, "index": at,
                       "file": png.name, "corners": corners(axis, at),
                       "default": name == "coronal",
                       "window": {"level": level, "width": width}})
        print(f"  {name:<9} index {at:>4}  {plane.shape[1]}x{plane.shape[0]}  -> {png.name}")
    return {"planes": planes, "window": {"level": level, "width": width}}


def main() -> None:
    labelmap_file = OUT / f"slice_{REFERENCE_PHASE:03d}_labelmap.mha"
    labelmap = itk.imread(str(labelmap_file))
    labels = itk.array_from_image(labelmap)
    print("reference labelmap:", labelmap_file.name)

    frames = sorted(DATA.glob("slice_???.mha"))
    print(f"{len(frames)} phases")
    print()

    surfaces: dict[int, pv.PolyData] = {}
    full_surfaces: dict[int, pv.PolyData] = {}
    for label_id, (budget, _colour, name) in WANTED.items():
        mask = mask_image(labels, label_id, labelmap)
        if mask is None:
            print(f"  {name:<24} absent from this segmentation")
            continue
        full = contours.extract_watertight_surface(
            mask, smoothing_iterations=20, gaussian_sigma_mm=0.7, surface_reduction_rate=0.0)
        sealed = bool(ProcessContours.is_watertight(full))

        # Decimate for the web. decimate_pro keeps the surface closed when asked to preserve
        # topology, which matters because an open surface has no volume to report.
        surface = full
        if full.n_points > budget:
            surface = full.decimate_pro(1.0 - budget / full.n_points, preserve_topology=True)
            surface = surface.smooth_taubin(n_iter=20, pass_band=0.1, normalize_coordinates=True)
        shipped_sealed = bool(ProcessContours.is_watertight(surface))

        print(f"  {name:<24} {full.n_points:>6} -> {surface.n_points:>6} points  "
              f"closed {str(sealed):<5} -> {str(shipped_sealed):<5}  "
              f"{float(full.volume) / 1000.0:7.1f} mL")
        surfaces[label_id] = surface
        full_surfaces[label_id] = full

    print()
    per_phase: dict[int, list[np.ndarray]] = {label_id: [] for label_id in surfaces}
    volumes: dict[int, list[float]] = {label_id: [] for label_id in surfaces}

    for index in range(len(frames)):
        transform_file = OUT / f"slice_{index:03d}_all_inverse.hdf"
        if not transform_file.exists():
            raise FileNotFoundError(transform_file)
        transform = itk.transformread(str(transform_file))[0]
        for label_id, surface in surfaces.items():
            moved = ProcessContours.transform_contours(surface, transform)
            per_phase[label_id].append(np.asarray(moved.points, dtype=np.float32))
            measured = ProcessContours.transform_contours(full_surfaces[label_id], transform)
            volumes[label_id].append(float(measured.volume) / 1000.0)
        print(f"  phase {index:>2}: heart {volumes[51][-1]:7.1f} mL")

    np.savez_compressed(
        MESHES / "phases.npz",
        **{f"faces_{label_id}": surface.faces.reshape(-1, 4)[:, 1:].astype(np.int32)
           for label_id, surface in surfaces.items()},
        **{f"points_{label_id}": np.stack(points) for label_id, points in per_phase.items()},
    )

    print()
    print("CT slice planes through the centre of the heart")
    heart_bounds = np.asarray(full_surfaces[51].bounds).reshape(3, 2).T  # [[xmin,ymin,zmin],[xmax,...]]
    ct_planes = export_ct_planes(frames[REFERENCE_PHASE], heart_bounds)

    summary = {
        "phases": len(frames),
        "ct": ct_planes,
        "heartCentreMm": [round(float(v), 1) for v in np.asarray(full_surfaces[51].center)],
        "referencePhase": REFERENCE_PHASE,
        "structures": [
            {
                "labelId": label_id,
                "name": WANTED[label_id][2],
                "colour": WANTED[label_id][1],
                "points": int(surfaces[label_id].n_points),
                "faces": int(surfaces[label_id].n_faces_strict),
                "watertight": bool(ProcessContours.is_watertight(surfaces[label_id])),
                "measuredOn": int(full_surfaces[label_id].n_points),
                "measuredWatertight": bool(ProcessContours.is_watertight(full_surfaces[label_id])),
                "volumePerPhase": [round(v, 1) for v in volumes[label_id]],
            }
            for label_id in surfaces
        ],
    }
    (MESHES / "summary.json").write_text(json.dumps(summary, indent=2))

    print()
    print("written", MESHES / "phases.npz")
    heart = volumes[51]
    print(f"heart volume across the cycle: {min(heart):.1f} to {max(heart):.1f} mL "
          f"({(max(heart) - min(heart)) / max(heart) * 100:.1f}% swing)")


if __name__ == "__main__":
    main()
