"""Turn an ImageCHD volume into a DICOM series the browser viewer can read.

ImageCHD ships NIfTI: one `.nii.gz` for the scan, one for the labels. The viewer reads
DICOM, so the volume is written out as a real CT series, one file per slice.

Three things about these files have to be corrected on the way out, and none of them is
guesswork, each was measured before this script was written:

  Geometry. The NIfTI affine is the identity, so the file claims 1 mm isotropic voxels at
  the origin. The real spacing survives only in the dataset's own spreadsheet, and is passed
  in here. Writing the identity would produce a volume that is wrong by a factor of four in
  plane and distorted against the slice axis.

  Orientation. With an identity affine there is nothing saying which way the patient faces,
  so it was settled from the pixels: the liver sits in the low columns and the myocardium in
  the high ones, which means the array's second axis runs from the patient's right to their
  left, and the first runs anterior to posterior. The slice therefore transposes on the way
  out, and lands as DICOM's ordinary (1,0,0,0,1,0). Guessing this wrong mirrors the anatomy,
  which is worse than useless in something meant to teach.

  Intensity. Values run 0 to 4095, which are not Hounsfield units but HU + 1024 clipped at
  air. Checked against the labels: the aorta reads 608 HU and air -971 once shifted. So the
  series carries RescaleIntercept -1024 and the viewer's windows mean what they say.

The labels come out in the shape the viewer already consumes: run-length encoded per slice,
keyed by the SOP Instance UID of the slice they belong to.

    ./.venv-seg/Scripts/python.exe scripts/nifti-to-dicom.py \
        --image ct_1046_image.nii.gz --label ct_1046_label.nii.gz \
        --case-id tof-1046 --pixel-spacing 0.24414 --slice-thickness 0.75 \
        --out imaging/chd
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import nibabel as nib
import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (
    CTImageStorage,
    ExplicitVRLittleEndian,
    JPEGLSLossless,
    generate_uid,
)

# What ImageCHD's label values mean. The README names seven and says to ignore anything
# else, so anything else is dropped rather than guessed at.
SEGMENTS = {
    1: "Left ventricle",
    2: "Right ventricle",
    3: "Left atrium",
    4: "Right atrium",
    5: "Myocardium",
    6: "Aorta",
    7: "Pulmonary artery",
}

# Stored value minus this is the Hounsfield unit.
INTERCEPT = -1024


def rle(mask: np.ndarray) -> list[int]:
    """Run-length encode a binary mask, row-major, starting on a run of zeros."""
    flat = np.ascontiguousarray(mask).reshape(-1).astype(np.uint8)
    if not flat.any():
        return []
    changes = np.flatnonzero(np.diff(flat))
    bounds = np.concatenate(([0], changes + 1, [flat.size]))
    runs = np.diff(bounds).tolist()
    return ([0] + runs) if flat[0] else runs


def write_series(
    volume: np.ndarray,
    case_id: str,
    pixel_mm: float,
    slice_mm: float,
    out_dir: Path,
    compress: bool,
) -> list[str]:
    """One CT file per slice. Returns the SOP Instance UIDs in slice order."""
    out_dir.mkdir(parents=True, exist_ok=True)
    study_uid, series_uid, frame_uid = generate_uid(), generate_uid(), generate_uid()
    rows, cols, depth = volume.shape
    sops: list[str] = []

    # Centre the volume on the origin, so the series sits somewhere sensible in space.
    x0 = -0.5 * cols * pixel_mm
    y0 = -0.5 * rows * pixel_mm
    z0 = -0.5 * depth * slice_mm

    for n in range(depth):
        sop = generate_uid()
        sops.append(sop)

        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = sop
        meta.TransferSyntaxUID = ExplicitVRLittleEndian

        ds = Dataset()
        ds.file_meta = meta
        ds.preamble = b"\0" * 128

        ds.SOPClassUID = CTImageStorage
        ds.SOPInstanceUID = sop
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = frame_uid
        ds.Modality = "CT"

        # The dataset's own spreadsheet carries real birth and acquisition dates. None of
        # them are copied here: these are placeholders the format requires.
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
        ds.SeriesDescription = "Cardiac CT angiography"

        ds.ImagePositionPatient = [f"{x0:.6f}", f"{y0:.6f}", f"{z0 + n * slice_mm:.6f}"]
        ds.ImageOrientationPatient = ["1", "0", "0", "0", "1", "0"]
        ds.PixelSpacing = [f"{pixel_mm:.6f}", f"{pixel_mm:.6f}"]
        ds.SliceThickness = f"{slice_mm:.6f}"
        ds.SpacingBetweenSlices = f"{slice_mm:.6f}"
        ds.SliceLocation = f"{z0 + n * slice_mm:.6f}"

        ds.Rows = rows
        ds.Columns = cols
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        # Stored unsigned over 12 bits, which is how the source holds it and how CT is
        # ordinarily encoded; the intercept is what turns it into Hounsfield units. Keeping
        # it unsigned also stays on the well-trodden path for the JPEG-LS encoder.
        ds.BitsAllocated = 16
        ds.BitsStored = 12
        ds.HighBit = 11
        ds.PixelRepresentation = 0
        ds.RescaleIntercept = str(INTERCEPT)
        ds.RescaleSlope = "1"
        ds.RescaleType = "HU"
        # Opens on a window that suits an opacified heart rather than plain soft tissue.
        ds.WindowCenter = "200"
        ds.WindowWidth = "700"

        ds.PixelData = np.ascontiguousarray(volume[:, :, n], dtype=np.uint16).tobytes()
        if compress:
            ds.compress(JPEGLSLossless)
        ds.save_as(out_dir / f"{n + 1:04d}.dcm", enforce_file_format=True)

    return sops


def main() -> int:
    ap = argparse.ArgumentParser(description="Convert an ImageCHD case to DICOM.")
    ap.add_argument("--image", required=True, type=Path)
    ap.add_argument("--label", type=Path)
    ap.add_argument("--case-id", required=True)
    ap.add_argument("--pixel-spacing", required=True, type=float, help="mm, from the spreadsheet")
    ap.add_argument("--slice-thickness", required=True, type=float, help="mm, from the spreadsheet")
    ap.add_argument("--lesion", default="Tetralogy of Fallot")
    ap.add_argument("--region", default="Heart")
    ap.add_argument("--collection", default="imagechd")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument(
        "--no-compress",
        action="store_true",
        help="write the pixels uncompressed, which roughly doubles the series on disk",
    )
    args = ap.parse_args()

    raw = np.asanyarray(nib.load(str(args.image)).dataobj)
    # Transpose each slice so columns run to the patient's left and rows run posteriorly.
    volume = np.ascontiguousarray(np.transpose(raw, (1, 0, 2))).astype(np.uint16)
    hu = volume.astype(np.int32) + INTERCEPT
    print(f"  scan   {volume.shape}  HU {hu.min()} to {hu.max()}")
    print(f"  voxel  {args.pixel_spacing} x {args.pixel_spacing} x {args.slice_thickness} mm")

    case_dir = args.out / args.case_id
    sops = write_series(
        volume,
        args.case_id,
        args.pixel_spacing,
        args.slice_thickness,
        case_dir / "dicom",
        not args.no_compress,
    )
    on_disk = sum(f.stat().st_size for f in (case_dir / "dicom").glob("*.dcm"))
    how = "stored" if args.no_compress else "JPEG-LS lossless"
    print(f"  wrote  {len(sops)} slices into {case_dir / 'dicom'}, {how}, {on_disk / 1e6:.0f} MB")

    if not args.label:
        return 0

    label_raw = np.asanyarray(nib.load(str(args.label)).dataobj)
    labels = np.ascontiguousarray(np.transpose(label_raw, (1, 0, 2)))
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
            "pixelSpacing": args.pixel_spacing,
            "sliceThickness": args.slice_thickness,
        },
        # The masks are keyed by SOP Instance UID, and only the slices that carry one appear
        # there, so the order cannot be recovered from them. The page needs to go from the
        # slice it is showing to the right mask, so the full series order is written out.
        "sops": sops,
        # Every structure here is normal anatomy. What makes the case a tetralogy is the
        # arrangement between them, not any one of them being a lesion, so none is marked as
        # one: saying otherwise would be a claim about the pixels that nobody made.
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
