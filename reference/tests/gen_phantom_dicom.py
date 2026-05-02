"""Generate small synthetic DICOM phantom datasets for testing the Voxel tab.

Creates two cases under sample_dicom/:

  Case A — hardware_fused/
      Hardware-fused SPECT/CT: SPECT and CT share FrameOfReferenceUID and
      a common origin. Voxel tab should auto-detect and skip registration.

  Case B — separate/
      Diagnostic CT (1mm) and a separately-acquired SPECT (5mm) with a
      different FrameOfReferenceUID and a small translation. Voxel tab
      should require manual landmark registration.

Each volume contains a synthetic anatomical scene:
  • a sphere of "liver" parenchyma (HU = 60 for CT, count = 50 for SPECT)
  • a smaller "tumor" sphere inside the liver (HU = 80 for CT, count = 800
    for SPECT — high SPECT uptake)
  • a few "kidney" landmark spheres (HU = 30, count = 10)
  • a "vertebral spinous process" landmark (HU = 200, count = 5)

These are ANATOMICALLY ABSURD — the goal is just to give recognizable
landmark targets so a human can practice clicking the same point on both
volumes.

Usage:  python3 reference/tests/gen_phantom_dicom.py

Requires: pydicom (pip install pydicom)
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid


HERE = Path(__file__).resolve().parent
OUT = HERE / "sample_dicom"


def make_phantom_volume(shape, spacing_mm, kind, *, origin_mm=(0, 0, 0)):
    """Build a synthetic 3D volume with anatomy-flavored structures.

    shape: (cols, rows, slices)  i.e. (i, j, k)
    spacing_mm: (sx, sy, sz)
    kind: 'ct' → returns Hounsfield-unit-flavored Float
          'spect' → returns count-flavored Float
    origin_mm: world position of voxel (0,0,0)
    """
    W, H, D = shape
    sx, sy, sz = spacing_mm
    ox, oy, oz = origin_mm

    # Voxel world coords
    i = np.arange(W) * sx + ox
    j = np.arange(H) * sy + oy
    k = np.arange(D) * sz + oz
    II, JJ, KK = np.meshgrid(i, j, k, indexing="ij")

    vol = np.full((W, H, D), -1000.0 if kind == "ct" else 0.0, dtype=np.float32)

    # Body cavity (large soft-tissue sphere)
    body_r = 90
    body_center = (0, 0, 50)
    body_mask = (
        (II - body_center[0]) ** 2 + (JJ - body_center[1]) ** 2 + (KK - body_center[2]) ** 2
    ) < body_r ** 2
    if kind == "ct":
        vol[body_mask] = 30
    else:
        vol[body_mask] = 1

    # Liver sphere (right of midline, anterior)
    liver_center = (40, -30, 50)
    liver_r = 50
    liver_mask = (
        (II - liver_center[0]) ** 2 + (JJ - liver_center[1]) ** 2 + (KK - liver_center[2]) ** 2
    ) < liver_r ** 2
    if kind == "ct":
        vol[liver_mask] = 60
    else:
        vol[liver_mask] = 50

    # Tumor sphere inside liver (right anterior segment)
    tumor_center = (55, -45, 60)
    tumor_r = 18
    tumor_mask = (
        (II - tumor_center[0]) ** 2 + (JJ - tumor_center[1]) ** 2 + (KK - tumor_center[2]) ** 2
    ) < tumor_r ** 2
    if kind == "ct":
        vol[tumor_mask] = 80
    else:
        vol[tumor_mask] = 800  # high uptake

    # Kidney landmarks (paraspinal at lower z)
    kidney_r = 15
    for cx in (-40, 40):
        kc = (cx, 30, 20)
        m = (II - kc[0]) ** 2 + (JJ - kc[1]) ** 2 + (KK - kc[2]) ** 2 < kidney_r ** 2
        if kind == "ct":
            vol[m] = 30
        else:
            vol[m] = 10

    # Vertebral spinous process (small dense dot, midline posterior)
    spine_r = 5
    sc = (0, 50, 50)
    m = (II - sc[0]) ** 2 + (JJ - sc[1]) ** 2 + (KK - sc[2]) ** 2 < spine_r ** 2
    if kind == "ct":
        vol[m] = 200
    else:
        vol[m] = 5

    # Portal vein bifurcation landmark (small low-density dot inside liver)
    pv_r = 4
    pc = (45, -28, 55)
    m = (II - pc[0]) ** 2 + (JJ - pc[1]) ** 2 + (KK - pc[2]) ** 2 < pv_r ** 2
    if kind == "ct":
        vol[m] = 20  # vessel
    else:
        vol[m] = 100  # lights up on SPECT also

    return vol


def write_volume_as_dicom(vol_data, out_dir, *, modality, spacing_mm,
                          origin_mm=(0, 0, 0), study_uid=None,
                          frame_of_ref_uid=None, series_description=""):
    """Write each slice as a single DICOM file. CT or NM modality.

    vol_data: float ndarray with shape (W, H, D) — i, j, k axes.
    """
    W, H, D = vol_data.shape
    sx, sy, sz = spacing_mm
    out_dir = Path(out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    if study_uid is None:
        study_uid = generate_uid()
    series_uid = generate_uid()
    if frame_of_ref_uid is None:
        frame_of_ref_uid = generate_uid()

    # Convert float volume to int16 with rescale
    if modality == "CT":
        # HU values, store as int16, no rescale offset
        rescale_slope = 1.0
        rescale_intercept = 0.0
        pixel = np.clip(vol_data, -2048, 3071).astype(np.int16)
        bits_alloc = 16
        pix_rep = 1  # signed
        photometric = "MONOCHROME2"
    elif modality == "NM":
        # SPECT counts. Store as uint16
        rescale_slope = 1.0
        rescale_intercept = 0.0
        v = np.clip(vol_data, 0, 65535).astype(np.uint16)
        pixel = v
        bits_alloc = 16
        pix_rep = 0  # unsigned
        photometric = "MONOCHROME2"
    else:
        raise ValueError(f"Unsupported modality {modality}")

    sop_class_map = {
        "CT": "1.2.840.10008.5.1.4.1.1.2",
        "NM": "1.2.840.10008.5.1.4.1.1.20",
    }

    for k in range(D):
        slice_pixels = pixel[:, :, k]  # shape (W, H)
        # DICOM stores (Rows, Columns) → (H, W). Transpose so row index = j, col = i.
        slice_for_dicom = slice_pixels.T.copy()  # (H, W)

        ipp = (origin_mm[0], origin_mm[1], origin_mm[2] + k * sz)

        file_meta = FileMetaDataset()
        file_meta.MediaStorageSOPClassUID = sop_class_map[modality]
        file_meta.MediaStorageSOPInstanceUID = generate_uid()
        file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        file_meta.ImplementationClassUID = generate_uid()

        ds = FileDataset(str(out_dir / f"slice_{k:03d}.dcm"), {},
                         file_meta=file_meta, preamble=b"\0" * 128)
        ds.SOPClassUID = file_meta.MediaStorageSOPClassUID
        ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
        ds.Modality = modality
        ds.SeriesDescription = series_description
        ds.PatientName = "ANONYMOUS"
        ds.PatientID = "PHANTOM"
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = frame_of_ref_uid
        ds.SeriesNumber = 1
        ds.InstanceNumber = k + 1

        ds.Rows = H
        ds.Columns = W
        ds.PixelSpacing = [sy, sx]   # row spacing (j), column spacing (i)
        ds.SliceThickness = sz
        ds.SpacingBetweenSlices = sz
        ds.ImagePositionPatient = [ipp[0], ipp[1], ipp[2]]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.BitsAllocated = bits_alloc
        ds.BitsStored = bits_alloc
        ds.HighBit = bits_alloc - 1
        ds.PixelRepresentation = pix_rep
        ds.PhotometricInterpretation = photometric
        ds.SamplesPerPixel = 1
        ds.RescaleSlope = rescale_slope
        ds.RescaleIntercept = rescale_intercept

        ds.PixelData = slice_for_dicom.tobytes()

        ds.is_little_endian = True
        ds.is_implicit_VR = False
        ds.save_as(str(out_dir / f"slice_{k:03d}.dcm"), write_like_original=False)

    return {"study_uid": study_uid, "series_uid": series_uid,
            "frame_of_ref_uid": frame_of_ref_uid, "slice_count": D}


def main():
    OUT.mkdir(exist_ok=True)

    # ============================================================
    # Case A — hardware-fused SPECT/CT
    #   Same FrameOfReferenceUID, same origin, different grid sizes.
    # ============================================================
    print("Case A — hardware-fused SPECT/CT")
    fused_origin = (-100, -100, 0)
    fused_for = generate_uid()
    fused_study = generate_uid()

    ct_a = make_phantom_volume((128, 128, 60), (1.5, 1.5, 2.5), "ct",
                               origin_mm=fused_origin)
    write_volume_as_dicom(ct_a, OUT / "hardware_fused" / "CT",
                          modality="CT", spacing_mm=(1.5, 1.5, 2.5),
                          origin_mm=fused_origin,
                          study_uid=fused_study,
                          frame_of_ref_uid=fused_for,
                          series_description="Phantom CT (fused)")

    spect_a = make_phantom_volume((64, 64, 30), (3.0, 3.0, 5.0), "spect",
                                  origin_mm=fused_origin)
    write_volume_as_dicom(spect_a, OUT / "hardware_fused" / "SPECT",
                          modality="NM", spacing_mm=(3.0, 3.0, 5.0),
                          origin_mm=fused_origin,
                          study_uid=fused_study,
                          frame_of_ref_uid=fused_for,
                          series_description="Phantom MAA SPECT (fused)")
    print(f"  → {OUT / 'hardware_fused'}")

    # ============================================================
    # Case B — separate diagnostic CT (1mm) + SPECT (5mm)
    #   Different FrameOfReferenceUID, different origin (small shift).
    #   Tests manual landmark registration.
    # ============================================================
    print("Case B — separate CT + SPECT (manual landmark)")
    ct_b_origin = (-100, -100, 0)
    spect_b_origin = (-95, -103, 4)  # small translation
    ct_b_for = generate_uid()
    spect_b_for = generate_uid()
    diag_study = generate_uid()
    spect_study = generate_uid()

    ct_b = make_phantom_volume((192, 192, 100), (1.0, 1.0, 1.5), "ct",
                               origin_mm=ct_b_origin)
    write_volume_as_dicom(ct_b, OUT / "separate" / "DiagnosticCT",
                          modality="CT", spacing_mm=(1.0, 1.0, 1.5),
                          origin_mm=ct_b_origin,
                          study_uid=diag_study,
                          frame_of_ref_uid=ct_b_for,
                          series_description="Diagnostic CT 1mm")

    spect_b = make_phantom_volume((64, 64, 30), (3.0, 3.0, 5.0), "spect",
                                  origin_mm=spect_b_origin)
    write_volume_as_dicom(spect_b, OUT / "separate" / "SPECT",
                          modality="NM", spacing_mm=(3.0, 3.0, 5.0),
                          origin_mm=spect_b_origin,
                          study_uid=spect_study,
                          frame_of_ref_uid=spect_b_for,
                          series_description="MAA SPECT 5mm")
    print(f"  → {OUT / 'separate'}")

    # ============================================================
    # Summary
    # ============================================================
    total_files = sum(1 for _ in OUT.rglob("*.dcm"))
    total_size = sum(p.stat().st_size for p in OUT.rglob("*.dcm")) / 1024 / 1024
    print(f"\nGenerated {total_files} DICOM files, {total_size:.1f} MB total")
    print(f"\nUsage in dosimetry-app Voxel tab:")
    print(f"  1. Drop the folder {OUT/'hardware_fused'}/ → expect auto-fused detection")
    print(f"  2. Drop the folder {OUT/'separate'}/ → expect manual landmark prompt")


if __name__ == "__main__":
    main()
