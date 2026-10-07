"""Turn the animated USD into one GLB a browser can play.

The USD holds 55 structures, each with 21 time samples of per-vertex positions. Three things
have to happen before a browser can show that:

1. Keep only the cardiac structures. Ribs and vertebrae are context the viewer does not need.
2. Decimate. 54k vertices per phase is far too much to ship, let alone 21 of them.
   Decimation has to preserve vertex correspondence across phases, otherwise the morph
   targets are meaningless. vtkDecimatePro only ever deletes vertices, never moves them, so
   the surviving points are a subset of the originals: carry an index array through the
   decimation and the same subset can be taken from every phase.
3. Write glTF morph targets, so the browser interpolates between phases instead of stepping
   through them, and one animation that cycles the weights.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import pyvista as pv
from pxr import Usd, UsdGeom

USD_FILE = Path("/root/heart/out/tutorial_01_heart/cardiac_model.all_painted.usd")
OUT_FILE = Path("/mnt/c/Users/vanio/claudeOS/projects/vanioAntunes/imaging/heart/heart.glb")

# Structure: (vertex budget, colour, human label). Colours follow the clinical convention of
# red for systemic arterial, blue for systemic venous, and a muted muscle tone for the wall.
WANTED: dict[str, tuple[int, str, str]] = {
    "heart": (12000, "#b4563f", "Heart"),
    # The vessels are thin-walled and already small; decimating them hard perforates them,
    # so they keep most of their triangles and the budget is spent on the wall instead.
    "aorta": (8000, "#c2453c", "Aorta"),
    "pulmonary_vein": (3500, "#5b7fa6", "Pulmonary veins"),
    "superior_vena_cava": (1500, "#4f6f93", "Superior vena cava"),
    "inferior_vena_cava": (3200, "#4f6f93", "Inferior vena cava"),
    "atrial_appendage_left": (1400, "#a8584c", "Left atrial appendage"),
}

FPS = 14.0  # 21 phases played back in 1.5 s, a plausible resting heart rate


def read_usd() -> dict[str, dict]:
    """Read every wanted structure: triangles once, positions per phase."""
    stage = Usd.Stage.Open(str(USD_FILE))
    start, end = int(stage.GetStartTimeCode()), int(stage.GetEndTimeCode())
    found: dict[str, dict] = {}

    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Mesh) or prim.GetName() not in WANTED:
            continue
        mesh = UsdGeom.Mesh(prim)
        counts = np.asarray(mesh.GetFaceVertexCountsAttr().Get(start))
        indices = np.asarray(mesh.GetFaceVertexIndicesAttr().Get(start))
        if counts.size == 0 or not np.all(counts == 3):
            raise ValueError(f"{prim.GetName()} is not triangulated")
        phases = [np.asarray(mesh.GetPointsAttr().Get(t), dtype=np.float32)
                  for t in range(start, end + 1)]
        found[prim.GetName()] = {"faces": indices.reshape(-1, 3), "phases": phases}
        print(f"  read {prim.GetName():<24} {len(phases)} phases, {len(phases[0])} points")
    return found


def decimate(faces: np.ndarray, phases: list[np.ndarray], budget: int):
    """Reduce vertex count while keeping the same vertex in every phase."""
    original = len(phases[0])
    if original <= budget:
        return faces, phases, 0.0

    padded = np.hstack([np.full((len(faces), 1), 3), faces]).ravel()
    surface = pv.PolyData(phases[0], padded)
    surface.point_data["orig"] = np.arange(original, dtype=np.float64)

    reduction = 1.0 - budget / original
    # decimate_pro deletes vertices rather than relocating them, so "orig" survives intact.
    reduced = surface.decimate_pro(reduction, preserve_topology=True)

    kept = np.rint(reduced.point_data["orig"]).astype(np.int64)
    new_faces = reduced.faces.reshape(-1, 4)[:, 1:]
    return new_faces, [phase[kept] for phase in phases], reduction


def smooth(faces: np.ndarray, phases: list[np.ndarray]) -> list[np.ndarray]:
    """Taubin-smooth every phase with identical settings.

    Decimating a marching-cubes surface by 80 or 90 per cent leaves spikes where vessels were
    cut off. Taubin smoothing removes them without the shrinkage plain Laplacian causes. It is
    a function of connectivity and positions only, and the connectivity is shared, so applying
    it phase by phase keeps vertices corresponding.
    """
    padded = np.hstack([np.full((len(faces), 1), 3), faces]).ravel()
    out = []
    for phase in phases:
        surface = pv.PolyData(phase, padded)
        smoothed = surface.smooth_taubin(n_iter=24, pass_band=0.08, normalize_coordinates=True)
        out.append(np.asarray(smoothed.points, dtype=np.float32))
    return out


def vertex_normals(points: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals, so the browser shades the surface smoothly."""
    a, b, c = points[faces[:, 0]], points[faces[:, 1]], points[faces[:, 2]]
    face_normals = np.cross(b - a, c - a)
    normals = np.zeros_like(points, dtype=np.float64)
    for column in range(3):
        np.add.at(normals, faces[:, column], face_normals)
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    lengths[lengths == 0] = 1.0
    return (normals / lengths).astype(np.float32)


def build_glb(structures: dict[str, dict]) -> bytes:
    """Write a GLB: one mesh per structure, morph targets for phases 1..n, one looping clip."""
    gltf = {
        "asset": {"version": "2.0", "generator": "monai-physio cardiac export"},
        "scene": 0, "scenes": [{"nodes": []}],
        "nodes": [], "meshes": [], "materials": [], "accessors": [], "bufferViews": [],
        "animations": [], "buffers": [],
    }
    blob = bytearray()

    def pad() -> None:
        while len(blob) % 4:
            blob.append(0)

    def add_view(data: bytes, target: int | None = None) -> int:
        pad()
        offset = len(blob)
        blob.extend(data)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target:
            view["target"] = target
        gltf["bufferViews"].append(view)
        return len(gltf["bufferViews"]) - 1

    def add_accessor(array: np.ndarray, kind: str, component: int, target=None, minmax=False) -> int:
        view = add_view(array.tobytes(), target)
        accessor = {"bufferView": view, "componentType": component,
                    "count": int(array.shape[0]), "type": kind}
        if minmax:
            accessor["min"] = [float(v) for v in array.min(axis=0)]
            accessor["max"] = [float(v) for v in array.max(axis=0)]
        gltf["accessors"].append(accessor)
        return len(gltf["accessors"]) - 1

    phase_count = len(next(iter(structures.values()))["phases"])
    channels, samplers = [], []

    for name, data in structures.items():
        budget, colour, label = WANTED[name]
        faces = data["faces"].astype(np.uint32)
        phases = data["phases"]
        base = phases[0]

        rgb = [int(colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        gltf["materials"].append({
            "name": label,
            "pbrMetallicRoughness": {"baseColorFactor": rgb + [1.0], "metallicFactor": 0.0,
                                     "roughnessFactor": 0.65},
            "doubleSided": True,
        })
        material = len(gltf["materials"]) - 1

        position = add_accessor(base, "VEC3", 5126, target=34962, minmax=True)
        # Normals for the base pose only. Morph-target normals would double the file for a
        # lighting difference that is invisible at this scale of deformation.
        normal = add_accessor(vertex_normals(base.astype(np.float64), data["faces"]),
                              "VEC3", 5126, target=34962)
        index = add_accessor(faces.ravel().reshape(-1, 1), "SCALAR", 5125, target=34963)
        targets = []
        for phase in phases[1:]:
            delta = (phase - base).astype(np.float32)
            targets.append({"POSITION": add_accessor(delta, "VEC3", 5126, minmax=True)})

        gltf["meshes"].append({
            "name": label,
            "primitives": [{"attributes": {"POSITION": position, "NORMAL": normal},
                            "indices": index, "material": material, "targets": targets}],
            "weights": [0.0] * len(targets),
            "extras": {"structure": name, "label": label, "colour": colour},
        })
        gltf["nodes"].append({"mesh": len(gltf["meshes"]) - 1, "name": label})
        node_index = len(gltf["nodes"]) - 1
        gltf["scenes"][0]["nodes"].append(node_index)

        # One keyframe per phase: weight 1 on the phase being shown, 0 elsewhere, looping home.
        times = np.arange(phase_count + 1, dtype=np.float32) / FPS
        weights = np.zeros((phase_count + 1, len(targets)), dtype=np.float32)
        for phase_index in range(1, phase_count):
            weights[phase_index, phase_index - 1] = 1.0
        input_accessor = add_accessor(times.reshape(-1, 1), "SCALAR", 5126, minmax=True)
        output_accessor = add_accessor(weights.ravel().reshape(-1, 1), "SCALAR", 5126)

        samplers.append({"input": input_accessor, "output": output_accessor, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": node_index, "path": "weights"}})

    gltf["animations"].append({"name": "heartbeat", "samplers": samplers, "channels": channels})
    while len(blob) % 4:
        blob.append(0)
    gltf["buffers"].append({"byteLength": len(blob)})

    payload = json.dumps(gltf, separators=(",", ":")).encode()
    while len(payload) % 4:
        payload += b" "

    header = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(payload) + 8 + len(blob))
    return (header
            + struct.pack("<II", len(payload), 0x4E4F534A) + payload
            + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))


def main() -> None:
    print("reading", USD_FILE.name)
    structures = read_usd()
    missing = set(WANTED) - set(structures)
    if missing:
        print("not in this segmentation:", sorted(missing))

    print()
    reduced = {}
    for name, data in structures.items():
        budget = WANTED[name][0]
        faces, phases, reduction = decimate(data["faces"], data["phases"], budget)
        phases = smooth(faces, phases)
        reduced[name] = {"faces": faces, "phases": phases}
        print(f"  {name:<24} {len(data['phases'][0]):>6} -> {len(phases[0]):>6} points "
              f"({reduction * 100:.0f}% removed), {len(faces)} faces, smoothed")

    print()
    glb = build_glb(reduced)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_bytes(glb)
    print("written", OUT_FILE, f"{len(glb) / 1024**2:.2f} MB")

    # No volume is published. The heart surface has 1770 open boundary edges where the field
    # of view truncates it, so the volume it encloses is undefined; measure_volumes.py runs
    # that check and refuses to write numbers when it fails.
    manifest = {
        "phases": len(next(iter(reduced.values()))["phases"]),
        "fps": FPS,
        "structures": [{"name": name, "label": WANTED[name][2], "colour": WANTED[name][1],
                        "points": int(len(data["phases"][0])), "faces": int(len(data["faces"]))}
                       for name, data in reduced.items()],
    }
    manifest_file = OUT_FILE.with_name("heart.json")
    manifest_file.write_text(json.dumps(manifest, indent=2))
    print("written", manifest_file)


if __name__ == "__main__":
    main()
