"""Turn an HVSMR-2.0 cardiovascular MR volume into a DICOM series the browser viewer reads.

HVSMR-2.0 ships NIfTI: one `.nii.gz` for the scan and one for the labels, on the same grid.
The viewer reads DICOM, so the volume is written out as a real MR series, one file per
axial slice.

Where this differs from the ImageCHD converter beside it, and why it is a second script
rather than a flag on the first:

  Geometry is in the file. ImageCHD shipped an identity affine, so its spacing had to be
  passed in from a spreadsheet and its orientation settled from the anatomy. These files
  carry a real affine, so neither is guessed: nibabel rotates the volume into RAS and the
  spacing is read off the header. Taking an argument for it would invite someone to
  contradict the file.

  Intensity has no absolute scale. CT could be shifted into Hounsfield units and windowed
  with presets that mean the same thing on any scanner. MR signal is arbitrary, different
  between these two scans and between any two scans, so nothing is rescaled, no RescaleType
  is written, and the window stored in each file is computed from that volume's own
  histogram. The page offers relative presets rather than named tissue windows for the same
  reason.

  Eight structures, not the same seven. HVSMR-2.0 labels both venae cavae and does not
  label myocardium, so its set is not interchangeable with ImageCHD's.

    ./.venv-seg/Scripts/python.exe scripts/hvsmr-to-dicom.py \
        --image pat14_cropped.nii.gz --label pat14_cropped_seg.nii.gz \
        --case-id mr-vsd-14 --out imaging/chd
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import nibabel as nib
import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (
    ExplicitVRLittleEndian,
    JPEGLSLossless,
    MRImageStorage,
    generate_uid,
)

# What HVSMR-2.0's label values mean, from the dataset's own description: "Segmentations and
# endpoints files include labels 1-LV, 2-RV, 3-LA, 4-RA, 5-AO, 6-PA, 7-SVC, and 8-IVC."
SEGMENTS = {
    1: "Left ventricle",
    2: "Right ventricle",
    3: "Left atrium",
    4: "Right atrium",
    5: "Aorta",
    6: "Pulmonary artery",
    7: "Superior vena cava",
    8: "Inferior vena cava",
}


def rle(mask: np.ndarray) -> list[int]:
    """Run-length encode a binary mask, row-major, starting on a run of zeros."""
    flat = np.ascontiguousarray(mask).reshape(-1).astype(np.uint8)
    if not flat.any():
        return []
    changes = np.flatnonzero(np.diff(flat))
    bounds = np.concatenate(([0], changes + 1, [flat.size]))
    runs = np.diff(bounds).tolist()
    return ([0] + runs) if flat[0] else runs


def to_dicom_axes(path: Path) -> tuple[np.ndarray, float, float, float]:
    """Rotate a volume into the axes a DICOM axial series uses.

    nibabel puts the array in RAS, whose three axes increase towards the patient's right,
    anterior and superior. DICOM writes rows down the image and columns across it, and with
    the ordinary (1,0,0,0,1,0) orientation a column step goes to the patient's left and a
    row step goes posteriorly. Both in-plane axes therefore reverse, and they swap, because
    RAS counts right-left first while the image counts rows first.

    Returns the volume as (rows, cols, slices) with the row, column and slice spacing.
    """
    canonical = nib.as_closest_canonical(nib.load(str(path)))
    ras = np.asanyarray(canonical.dataobj)
    sx, sy, sz = (float(z) for z in canonical.header.get_zooms()[:3])
    flipped = ras[::-1, ::-1, :]
    volume = np.ascontiguousarray(np.transpose(flipped, (1, 0, 2)))
    return volume, sy, sx, sz


def window_for(volume: np.ndarray) -> tuple[int, int]:
    """An opening window for one MR volume, from its own histogram.

    There is no scale shared with any other scan, so the only honest default is the range
    this image occupies. Background zeros are excluded, or they drag the centre down to
    nothing, and the ends are clipped at the first and ninety-ninth percentile so that one
    bright voxel cannot flatten everything else.
    """
    tissue = volume[volume > 0]
    if tissue.size == 0:
        return 0, 1
    low, high = (float(v) for v in np.percentile(tissue, (1, 99)))
    width = max(1.0, high - low)
    return int(round(low + width / 2)), int(round(width))


def write_series(
    volume: np.ndarray,
    case_id: str,
    row_mm: float,
    col_mm: float,
    slice_mm: float,
    out_dir: Path,
    compress: bool,
) -> list[str]:
    """One MR file per slice. Returns the SOP Instance UIDs in slice order."""
    out_dir.mkdir(parents=True, exist_ok=True)
    study_uid, series_uid, frame_uid = generate_uid(), generate_uid(), generate_uid()
    rows, cols, depth = volume.shape
    centre, width = window_for(volume)
    sops: list[str] = []

    # Centre the volume on the origin, so the series sits somewhere sensible in space.
    x0 = -0.5 * cols * col_mm
    y0 = -0.5 * rows * row_mm
    z0 = -0.5 * depth * slice_mm

    for n in range(depth):
        sop = generate_uid()
        sops.append(sop)

        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = MRImageStorage
        meta.MediaStorageSOPInstanceUID = sop
        meta.TransferSyntaxUID = ExplicitVRLittleEndian

        ds = Dataset()
        ds.file_meta = meta
        ds.preamble = b"\0" * 128

        ds.SOPClassUID = MRImageStorage
        ds.SOPInstanceUID = sop
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = frame_uid
        ds.Modality = "MR"

        # HVSMR-2.0 is deidentified and carries no dates. These are the placeholders the
        # format requires, not anything carried over from the source.
        ds.PatientName = case_id
        ds.PatientID = case_id
        ds.PatientBirthDate = ""
        ds.PatientSex = ""
        ds.StudyDate = "20000101"
        ds.StudyTime = "000000"
        ds.StudyID = "1"
        ds.AccessionNumber = ""
        ds.SeriesNumber = 1
        ds.InstanceNumber = n + 1
        ds.SeriesDescription = "Cardiovascular MR, whole heart"

        ds.ImagePositionPatient = [f"{x0:.6f}", f"{y0:.6f}", f"{z0 + n * slice_mm:.6f}"]
        ds.ImageOrientationPatient = ["1", "0", "0", "0", "1", "0"]
        ds.PixelSpacing = [f"{row_mm:.6f}", f"{col_mm:.6f}"]
        ds.SliceThickness = f"{slice_mm:.6f}"
        ds.SpacingBetweenSlices = f"{slice_mm:.6f}"
        ds.SliceLocation = f"{z0 + n * slice_mm:.6f}"

        ds.Rows = rows
        ds.Columns = cols
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        # No intercept and no RescaleType: MR signal is not a measurement on a scale shared
        # with another scan, and saying otherwise would make the viewer's readout a lie.
        ds.WindowCenter = str(centre)
        ds.WindowWidth = str(width)

        ds.PixelData = np.ascontiguousarray(volume[:, :, n], dtype=np.uint16).tobytes()
        if compress:
            # Re-encoding makes a new SOP Instance and pydicom issues a fresh UID for it.
            # The masks are keyed by these UIDs, so the one recorded has to be the one the
            # file ends up carrying rather than the one it held a moment earlier.
            ds.compress(JPEGLSLossless)
            sops[-1] = ds.SOPInstanceUID
        ds.save_as(out_dir / f"{n + 1:04d}.dcm", enforce_file_format=True)

    return sops


def main() -> int:
    ap = argparse.ArgumentParser(description="Convert an HVSMR-2.0 case to DICOM.")
    ap.add_argument("--image", required=True, type=Path)
    ap.add_argument("--label", type=Path)
    ap.add_argument("--case-id", required=True)
    ap.add_argument("--lesion", default="", help="what the dataset records, not a reading")
    ap.add_argument("--region", default="Heart")
    ap.add_argument("--collection", default="hvsmr2")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument(
        "--no-compress",
        action="store_true",
        help="write the pixels uncompressed, which roughly doubles the series on disk",
    )
    args = ap.parse_args()

    raw, row_mm, col_mm, slice_mm = to_dicom_axes(args.image)
    peak = float(raw.max())
    if peak > 65535:
        raise SystemExit(f"signal peaks at {peak:.0f}, which will not fit 16 bits unscaled")
    volume = np.rint(raw).astype(np.uint16)
    centre, width = window_for(volume)
    print(f"  scan   {volume.shape}  signal 0 to {volume.max()}  window C {centre} / W {width}")
    print(f"  voxel  {row_mm:.4f} x {col_mm:.4f} x {slice_mm:.4f} mm (row, col, slice)")

    case_dir = args.out / args.case_id
    sops = write_series(
        volume, args.case_id, row_mm, col_mm, slice_mm, case_dir / "dicom", not args.no_compress
    )
    on_disk = sum(f.stat().st_size for f in (case_dir / "dicom").glob("*.dcm"))
    how = "stored" if args.no_compress else "JPEG-LS lossless"
    print(f"  wrote  {len(sops)} slices into {case_dir / 'dicom'}, {how}, {on_disk / 1e6:.0f} MB")

    if not args.label:
        return 0

    label_raw, _, _, _ = to_dicom_axes(args.label)
    labels = np.rint(label_raw).astype(np.int16)
    if labels.shape != volume.shape:
        raise SystemExit(
            f"labels are {labels.shape} but the scan is {volume.shape}; they do not share a "
            "grid, and resampling is a different job from this one"
        )

    present = sorted(int(v) for v in np.unique(labels) if int(v) in SEGMENTS)
    slices: dict[str, dict[str, list[int]]] = {}
    for n, sop in enumerate(sops):
        plane = labels[:, :, n]
        if not plane.any():
            continue
        for value in present:
            encoded = rle(plane == value)
            if encoded:
                slices.setdefault(sop, {})[str(value)] = encoded

    payload = {
        "case": {
            "id": args.case_id,
            "collection": args.collection,
            "region": args.region,
            "lesion": args.lesion,
            "patientId": args.case_id,
            "rows": int(volume.shape[0]),
            "cols": int(volume.shape[1]),
            "pixelSpacing": round(col_mm, 5),
            "sliceThickness": round(slice_mm, 5),
        },
        # The masks are keyed by SOP Instance UID, and only the slices carrying one appear
        # there, so the order cannot be recovered from them. The page needs to go from the
        # slice it is showing to the right mask, so the series order is written out.
        "sops": sops,
        # Every structure here is normal anatomy, named by the annotators. A defect is an
        # arrangement between structures rather than a structure, so none is marked as one.
        "segments": [{"number": v, "label": SEGMENTS[v], "kind": "normal"} for v in present],
        "slices": slices,
    }
    seg_path = case_dir / "segmentation.json"
    seg_path.write_text(json.dumps(payload), encoding="utf-8")
    print(f"  labels {len(present)} structures over {len(slices)} slices")
    print(f"  wrote  {seg_path} ({seg_path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
