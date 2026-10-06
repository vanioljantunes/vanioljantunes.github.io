"""Turn published DICOM SEG objects into something a browser can hit-test.

The archive already carries segmentations for some of the studies the viewer shows: organ
masks from TotalSegmentator, tumour masks from the AIMI annotation effort. They are real,
published and attributable, which is why the viewer uses them rather than running a model
and inventing boundaries of its own.

A SEG object is a multi-frame image where every frame is one binary mask belonging to one
segment, and each frame names the source slice it was drawn on. This script pulls that
apart and writes one compact JSON per case: the segment list, and per source slice, a
run-length encoding of each segment's mask. A browser decodes a run-length array far faster
than it would decode an image, and the result gzips well over the wire.

Run it with the project's own environment, which is not the system Python:

    ./.venv-seg/Scripts/python.exe scripts/extract-seg.py
"""

from __future__ import annotations

import io
import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np
import pydicom

ROOT = (
    "https://proxy.imaging.datacommons.cancer.gov/current/"
    "viewer-only-no-downloads-see-tinyurl-dot-com-slash-3j3d9jyp/dicomWeb"
)

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "imaging" / "viewer" / "seg"

# One case per lesion, which is what makes the set worth reading rather than exhaustive.
# tcga-lusc is deliberately absent: its lesion is a lung tumour, which tcga-luad already
# covers, and a second example of the same thing teaches nothing new.
CASES = [
    {
        "id": "kidney-rcc",
        "collection": "tcga-kirc",
        "region": "Kidney",
        "lesion": "Renal cell carcinoma",
        "study": "1.3.6.1.4.1.14519.5.2.1.1706.4004.489158447226775082699786004248",
        "seg": "1.2.276.0.7230010.3.1.3.17436516.2358706.1693014643.944694",
    },
    {
        "id": "breast-mass",
        "collection": "duke-breast",
        "region": "Breast",
        "lesion": "Breast cancer",
        "study": "1.3.6.1.4.1.14519.5.2.1.222325663932482147590555101410222121615",
        "seg": "1.2.276.0.7230010.3.1.3.17436516.4021515.1714670996.268989",
    },
    {
        "id": "lung-tumour",
        "collection": "tcga-luad",
        "region": "Chest",
        "lesion": "Lung adenocarcinoma",
        "study": "1.3.6.1.4.1.14519.5.2.1.6450.9002.307623500513044641407722230440",
        "seg": "1.2.276.0.7230010.3.1.3.17436516.2898461.1720649005.696969",
    },
    {
        "id": "brain-glioma",
        "collection": "remind",
        "region": "Brain",
        "lesion": "Glioma",
        "study": "1.3.6.1.4.1.14519.5.2.1.170736010678190430940977593474281863483",
        "seg": "1.3.6.1.4.1.14519.5.2.1.215184695653289766907610044014467194763",
    },
]

# Segment labels that name a lesion rather than normal anatomy. Everything else is treated
# as a normal structure, which is the safer default: calling healthy anatomy a lesion would
# be a far worse error than the reverse.
LESION_WORDS = re.compile(
    r"tumou?r|mass|lesion|glioma|carcinoma|metasta|nodule|cyst|oedema|edema", re.I
)


def fetch_instances(study: str, series: str) -> list[pydicom.Dataset]:
    """Retrieve every instance of a series over WADO-RS and parse it."""
    url = f"{ROOT}/studies/{study}/series/{series}"
    request = urllib.request.Request(
        url, headers={"Accept": 'multipart/related; type="application/dicom"'}
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        content_type = response.headers.get("Content-Type", "")
        body = response.read()

    match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not match:
        raise RuntimeError(f"no multipart boundary in {content_type!r}")
    boundary = ("--" + match.group(1)).encode()

    datasets = []
    for part in body.split(boundary):
        head, sep, payload = part.partition(b"\r\n\r\n")
        if not sep or b"application/dicom" not in head:
            continue
        payload = payload.rstrip(b"\r\n-")
        if not payload:
            continue
        datasets.append(pydicom.dcmread(io.BytesIO(payload)))
    if not datasets:
        raise RuntimeError("no DICOM parts in the response")
    return datasets


def rle(mask: np.ndarray) -> list[int]:
    """Run-length encode a binary mask, row-major, starting with a run of zeros."""
    flat = mask.reshape(-1).astype(np.uint8)
    if not flat.any():
        return []
    changes = np.flatnonzero(np.diff(flat))
    bounds = np.concatenate(([0], changes + 1, [flat.size]))
    runs = np.diff(bounds).tolist()
    # The encoding assumes it begins on zero; if the mask begins on one, lead with an empty
    # run so the alternation still lines up.
    return ([0] + runs) if flat[0] else runs


def source_sop(frame_groups, index: int) -> str | None:
    """Which source slice a SEG frame was drawn on."""
    try:
        derivation = frame_groups[index].DerivationImageSequence[0]
        return str(derivation.SourceImageSequence[0].ReferencedSOPInstanceUID)
    except Exception:
        return None


def source_grids(study: str, series: str) -> dict[str, dict]:
    """Each source slice's own grid: where its first pixel sits and which way its axes run."""
    url = f"{ROOT}/studies/{study}/series/{series}/metadata"
    request = urllib.request.Request(url, headers={"Accept": "application/dicom+json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        meta = json.loads(response.read())
    grids = {}
    for item in meta:
        try:
            grids[item["00080018"]["Value"][0]] = {
                "origin": np.array([float(x) for x in item["00200032"]["Value"]]),
                "iop": np.array([float(x) for x in item["00200037"]["Value"]]),
                "spacing": [float(x) for x in item["00280030"]["Value"]],
                "rows": int(item["00280010"]["Value"][0]),
                "cols": int(item["00280011"]["Value"][0]),
            }
        except KeyError:
            continue
    return grids


def place_on_source(mask: np.ndarray, seg_grid: dict, src: dict) -> np.ndarray | None:
    """Put a mask drawn on the SEG's own grid onto the source slice's grid.

    The two grids are not the same thing, and assuming they were is what put the kidneys in
    the bowel. This segmentation declares an orientation of (1,0,0,0,-1,0) against the
    source's (1,0,0,0,1,0): its rows run the other way, so its row 0 is the source's last
    row. Rather than special-case that, work out where each mask row and column actually
    lands by projecting the mask's own axes onto the source's, and give up loudly if the
    result is not a whole number of source pixels.
    """
    x_src, y_src = src["iop"][:3], src["iop"][3:]
    row_mm, col_mm = src["spacing"]
    x_seg, y_seg = seg_grid["iop"][:3], seg_grid["iop"][3:]
    seg_row_mm, seg_col_mm = seg_grid["spacing"]

    def source_index(a: int, b: int) -> tuple[float, float]:
        offset = (
            seg_grid["origin"] - src["origin"] + b * seg_col_mm * x_seg + a * seg_row_mm * y_seg
        )
        return float(offset @ y_src) / row_mm, float(offset @ x_src) / col_mm

    i0, j0 = source_index(0, 0)
    i1, _ = source_index(1, 0)
    _, j1 = source_index(0, 1)
    di, dj = i1 - i0, j1 - j0

    # Anything other than a whole-pixel step means the mask would need resampling, which is a
    # different and lossier job than this script does.
    for step in (di, dj):
        if abs(abs(step) - 1) > 1e-3:
            return None
    for start in (i0, j0):
        if abs(start - round(start)) > 1e-3:
            return None

    rows_seg, cols_seg = mask.shape
    rows_i = np.rint(i0 + di * np.arange(rows_seg)).astype(int)
    cols_i = np.rint(j0 + dj * np.arange(cols_seg)).astype(int)
    keep_r = (rows_i >= 0) & (rows_i < src["rows"])
    keep_c = (cols_i >= 0) & (cols_i < src["cols"])
    if not keep_r.any() or not keep_c.any():
        return None

    out = np.zeros((src["rows"], src["cols"]), dtype=mask.dtype)
    out[np.ix_(rows_i[keep_r], cols_i[keep_c])] = mask[np.ix_(np.where(keep_r)[0], np.where(keep_c)[0])]
    return out


def extract(case: dict) -> dict | None:
    print(f"  {case['id']}: fetching segmentation")
    try:
        datasets = fetch_instances(case["study"], case["seg"])
    except Exception as err:  # noqa: BLE001 - skip this case, continue the run
        print(f"    failed: {err}")
        return None

    ds = datasets[0]
    frames = ds.pixel_array
    if frames.ndim == 2:  # a single-frame segmentation
        frames = frames[np.newaxis, ...]

    segments = {}
    for item in getattr(ds, "SegmentSequence", []):
        number = int(item.SegmentNumber)
        label = str(getattr(item, "SegmentLabel", "") or f"Segment {number}")
        segments[number] = {
            "number": number,
            "label": label,
            "kind": "lesion" if LESION_WORDS.search(label) else "normal",
        }

    # Which series the masks were drawn on, so the viewer knows what to show beneath them.
    source_series = None
    try:
        source_series = str(ds.ReferencedSeriesSequence[0].SeriesInstanceUID)
    except Exception:
        pass

    frame_groups = getattr(ds, "PerFrameFunctionalGroupsSequence", [])
    shared = (getattr(ds, "SharedFunctionalGroupsSequence", None) or [None])[0]

    # The SEG carries its own grid, which need not match the slices it was drawn on.
    if source_series is None:
        print("    failed: the segmentation does not say which series it belongs to")
        return None
    grids = source_grids(case["study"], source_series)
    print(f"    source series has {len(grids)} slices")

    def seg_grid_for(index: int) -> dict | None:
        group = frame_groups[index]
        orientation = None
        for holder in (group, shared):
            seq = getattr(holder, "PlaneOrientationSequence", None) if holder else None
            if seq:
                orientation = [float(x) for x in seq[0].ImageOrientationPatient]
                break
        spacing = None
        for holder in (group, shared):
            seq = getattr(holder, "PixelMeasuresSequence", None) if holder else None
            if seq and getattr(seq[0], "PixelSpacing", None):
                spacing = [float(x) for x in seq[0].PixelSpacing]
                break
        try:
            origin = [float(x) for x in group.PlanePositionSequence[0].ImagePositionPatient]
        except Exception:
            origin = None
        if orientation is None or spacing is None or origin is None:
            return None
        return {
            "origin": np.array(origin),
            "iop": np.array(orientation),
            "spacing": spacing,
        }

    slices: dict[str, dict[str, list[int]]] = {}
    unmapped = 0
    misplaced = 0
    out_rows = out_cols = None

    for i in range(frames.shape[0]):
        try:
            seg_number = int(
                frame_groups[i].SegmentIdentificationSequence[0].ReferencedSegmentNumber
            )
        except Exception:
            unmapped += 1
            continue

        sop = source_sop(frame_groups, i)
        if sop is None:
            unmapped += 1
            continue

        src = grids.get(sop)
        seg_grid = seg_grid_for(i)
        if src is None or seg_grid is None:
            unmapped += 1
            continue

        placed = place_on_source(frames[i], seg_grid, src)
        if placed is None:
            misplaced += 1
            continue
        out_rows, out_cols = placed.shape

        encoded = rle(placed)
        if not encoded:
            continue  # an empty mask on this slice carries no information
        slices.setdefault(sop, {})[str(seg_number)] = encoded

    print(
        f"    {len(segments)} segments, {frames.shape[0]} frames, "
        f"{len(slices)} slices with masks"
        + (f", {unmapped} frames unmapped" if unmapped else "")
        + (f", {misplaced} frames the grid could not place" if misplaced else "")
    )
    if not slices:
        print("    failed: nothing could be placed on the source grid")
        return None

    return {
        "case": {
            "id": case["id"],
            "collection": case["collection"],
            "region": case["region"],
            "lesion": case["lesion"],
            "patientId": str(getattr(ds, "PatientID", "")),
            "studyUID": case["study"],
            "segSeriesUID": case["seg"],
            "sourceSeriesUID": source_series,
            "modality": str(getattr(ds, "Modality", "SEG")),
            "rows": int(out_rows or frames.shape[1]),
            "cols": int(out_cols or frames.shape[2]),
        },
        "segments": [segments[k] for k in sorted(segments)],
        "slices": slices,
    }


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = []
    for case in CASES:
        result = extract(case)
        if result is None:
            continue
        path = OUT_DIR / f"{case['id']}.json"
        path.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        size_kb = path.stat().st_size / 1024
        written.append((case["id"], size_kb, len(result["segments"])))
        print(f"    wrote {path.relative_to(REPO)}  {size_kb:.0f} KB")

    print(f"\n{len(written)} of {len(CASES)} cases written")
    for name, size_kb, count in written:
        print(f"  {name:14s} {count} segments  {size_kb:7.0f} KB")
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())
