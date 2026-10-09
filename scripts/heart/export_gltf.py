"""Pack the cardiac surfaces and their motion into one GLB for the web.

Input is `phases.npz` from build_meshes.py: one topology per structure, 21 sets of positions,
in CT physical millimetres. Output is a GLB whose meshes carry glTF morph targets, so the
browser interpolates between phases rather than stepping through them, plus a manifest the
page reads for labels, colours, measured volumes and the CT plane geometry.

Positions stay in millimetres. The CT planes are placed from the same coordinates, so the
model sits inside its own scan.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

MESHES = Path.home() / "heart" / "out" / "web-meshes"
WEB = Path("/mnt/c/Users/vanio/claudeOS/projects/vanioAntunes/imaging/heart")
OUT_FILE = WEB / "heart.glb"

FPS = 14.0  # 21 phases in 1.5 s, a plausible resting rate


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
        colour, label = data["colour"], data["label"]
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
    summary = json.loads((MESHES / "summary.json").read_text())
    data = np.load(MESHES / "phases.npz")

    structures = {}
    for entry in summary["structures"]:
        label_id = entry["labelId"]
        faces = data[f"faces_{label_id}"].astype(np.int64)
        points = data[f"points_{label_id}"].astype(np.float32)
        structures[entry["name"]] = {
            "faces": faces,
            "phases": [points[i] for i in range(points.shape[0])],
            "colour": entry["colour"],
            "label": entry["name"],
        }
        print(f"  {entry['name']:<24} {points.shape[1]:>6} points {len(faces):>6} faces "
              f"{points.shape[0]} phases")

    glb = build_glb(structures)
    OUT_FILE.write_bytes(glb)
    print()
    print("written", OUT_FILE, f"{len(glb) / 1024**2:.2f} MB")

    manifest = {
        "phases": summary["phases"],
        "fps": FPS,
        "referencePhase": summary["referencePhase"],
        "units": "mm",
        "ct": summary["ct"],
        "heartCentreMm": summary["heartCentreMm"],
        "structures": [
            {
                "name": entry["name"],
                "colour": entry["colour"],
                "points": entry["points"],
                "faces": entry["faces"],
                "volumePerPhase": entry["volumePerPhase"],
                "measuredWatertight": entry["measuredWatertight"],
            }
            for entry in summary["structures"]
        ],
    }
    (WEB / "heart.json").write_text(json.dumps(manifest, indent=2))
    print("written", WEB / "heart.json")


if __name__ == "__main__":
    main()
