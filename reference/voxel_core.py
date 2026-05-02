"""
SPEC-DOSI-VOXEL-SHARED-001 reference implementation (Python).

Pure functions, no DICOM dependency. Mirrors voxel-core.js byte-for-byte
on phantoms #1~#5 (per validation.md tolerance matrix).

Constants from algorithms.md § 0.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

K_LED = 49.67          # J/kg/GBq
Y90_T_HALF_H = 64.1    # hours
Y90_LAMBDA = math.log(2) / Y90_T_HALF_H
PARTITION_FACTOR = 49670  # K * 1000 with V in cm³, density implicit 1.0

DEFAULT_DENSITY = {
    "Liver": 1.05,
    "Perfused": 1.05,
    "Lung": 0.30,
    "Tumor": 1.05,
}


def density_for_label(label: str) -> float:
    if label.startswith("Tumor"):
        return DEFAULT_DENSITY["Tumor"]
    return DEFAULT_DENSITY.get(label, 1.05)


# ==============================================================
# Method 1 — ROI Partition Model
# ==============================================================

@dataclass
class TumorInput:
    label: str
    mean_count: float
    V_T_cc: float


def method1_from_inputs(*, tumors, count_NT, V_N_cc, A_gbq, lsf_fraction):
    """Per-tumor partition model. Returns list of result dicts.

    Mirrors method1FromInputs in voxel-core.js.
    """
    out = []
    if count_NT is None or count_NT == 0:
        for t in tumors:
            out.append({
                "roi_label": t.label,
                "units": "gy",
                "tn_ratio": 0.0,
                "v_t_cc": t.V_T_cc,
                "v_n_cc": V_N_cc,
                "not_evaluated": True,
            })
        return out

    one_minus_lsf = 1.0 - lsf_fraction
    for t in tumors:
        tn = t.mean_count / count_NT
        denom = tn * t.V_T_cc + V_N_cc
        if denom <= 0:
            out.append({"roi_label": t.label, "units": "gy", "not_evaluated": True})
            continue
        D_T = A_gbq * PARTITION_FACTOR * one_minus_lsf * tn / denom
        out.append({
            "roi_label": t.label,
            "units": "gy",
            "dose_gy": D_T,
            "tn_ratio": tn,
            "v_t_cc": t.V_T_cc,
            "v_n_cc": V_N_cc,
        })
        out.append({
            "roi_label": "Liver",
            "units": "gy",
            "dose_gy": D_T / tn,
            "v_n_cc": V_N_cc,
            "derived_from": t.label,
        })
    return out


# ==============================================================
# Method 2 — LED Voxel Dose
# ==============================================================

LABEL_PRIORITY = [
    "Tumor10", "Tumor9", "Tumor8", "Tumor7", "Tumor6", "Tumor5",
    "Tumor4", "Tumor3", "Tumor2", "Tumor1",
    "Lung", "Perfused", "Liver",
]


def _parse_iso(ts):
    if ts is None:
        return None
    # Accept "Z" suffix and offsets
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def method2_voxel_dose(*, spect_volume, masks, voxel_volume_cc, calibration):
    """Compute Method 2 LED voxel dose.

    spect_volume: 1D ndarray (any flattened shape) of count values
    masks: dict[label, np.ndarray of bool/uint8] same length as spect_volume
    voxel_volume_cc: float
    calibration: dict with keys
      calibration_factor_mbq_per_count: float|None
      acquisition_timestamp: str|None
      reference_timestamp: str|None

    Returns dict with dose_volume (np.ndarray), results (list of dicts), is_relative (bool).
    """
    spect = np.asarray(spect_volume, dtype=np.float64)
    N = spect.size

    c_cal = calibration.get("calibration_factor_mbq_per_count")
    is_relative = c_cal is None

    # Decay
    decay = 1.0
    t_s_str = calibration.get("acquisition_timestamp")
    t_r_str = calibration.get("reference_timestamp")
    if t_s_str and t_r_str:
        t_s = _parse_iso(t_s_str)
        t_r = _parse_iso(t_r_str)
        if t_s is not None and t_r is not None:
            dt_h = (t_r - t_s).total_seconds() / 3600.0
            decay = math.exp(-Y90_LAMBDA * dt_h)

    # Per-voxel density (priority: Tumor > Lung > Perfused > Liver)
    density_volume = np.full(N, 1.05, dtype=np.float64)
    for label in LABEL_PRIORITY:
        m = masks.get(label)
        if m is None:
            continue
        m_arr = np.asarray(m).astype(bool).reshape(-1)
        rho = density_for_label(label)
        density_volume[m_arr] = rho

    # Per-voxel dose
    spect_clamped = np.maximum(spect, 0)
    factor = decay if is_relative else (c_cal * decay)
    A_mbq = spect_clamped * factor
    mass_kg = (voxel_volume_cc / 1000.0) * density_volume
    # Avoid divide-by-zero
    valid = mass_kg > 0
    dose_volume = np.zeros(N, dtype=np.float64)
    dose_volume[valid] = A_mbq[valid] * 0.001 * K_LED / mass_kg[valid]

    # ROI stats
    results = []
    for label, mask in masks.items():
        m_arr = np.asarray(mask).astype(bool).reshape(-1)
        doses = dose_volume[m_arr]
        if doses.size == 0:
            results.append({
                "roi_label": label,
                "units": "relative" if is_relative else "gy",
                "voxel_count": 0,
                "not_evaluated": True,
            })
            continue
        sorted_doses = np.sort(doses)
        n = sorted_doses.size
        mean = float(sorted_doses.sum() / n)
        max_v = float(sorted_doses[-1])
        d95 = _percentile_sorted(sorted_doses, 5.0)
        d70 = _percentile_sorted(sorted_doses, 30.0)
        if is_relative:
            results.append({
                "roi_label": label, "units": "relative", "voxel_count": int(n),
                "mean_relative": mean, "max_relative": max_v,
                "d95_relative": d95, "d70_relative": d70,
            })
        else:
            results.append({
                "roi_label": label, "units": "gy", "voxel_count": int(n),
                "mean_gy": mean, "max_gy": max_v,
                "d95_gy": d95, "d70_gy": d70,
            })
    return {"dose_volume": dose_volume, "results": results, "is_relative": is_relative}


def _percentile_sorted(sorted_asc, pct):
    n = sorted_asc.size
    if n == 0:
        return 0.0
    if n == 1:
        return float(sorted_asc[0])
    idx = (pct / 100.0) * (n - 1)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return float(sorted_asc[lo])
    return float(sorted_asc[lo] + (idx - lo) * (sorted_asc[hi] - sorted_asc[lo]))


# ==============================================================
# DVH — Cumulative
# ==============================================================

def compute_dvh(dose_volume, mask, *, bins=100, dose_max=600.0, units="gy"):
    """Cumulative V(D) curve. Returns dict matching schema dvhSeries."""
    dose = np.asarray(dose_volume, dtype=np.float64).reshape(-1)
    m = np.asarray(mask).astype(bool).reshape(-1)
    selected = dose[m]
    voxel_count = int(selected.size)
    bin_width = dose_max / bins

    if voxel_count == 0:
        return {"points": [], "voxel_count": 0, "overflow_count": 0, "units": units}

    bin_idx = np.floor(selected / bin_width).astype(int)
    overflow = int((bin_idx >= bins).sum())
    bin_idx = np.clip(bin_idx, 0, bins - 1)
    H = np.bincount(bin_idx, minlength=bins)

    points = []
    cum = voxel_count
    for i in range(bins):
        points.append({"dose": i * bin_width, "volume_pct": 100.0 * cum / voxel_count})
        cum -= int(H[i])
    points.append({"dose": dose_max, "volume_pct": 0.0})
    return {"points": points, "voxel_count": voxel_count, "overflow_count": overflow, "units": units}


# ==============================================================
# Kabsch SVD — Manual Landmark Registration
# ==============================================================

def kabsch(src, tgt, mode="rigid"):
    """Compute rigid (or similarity) transform mapping src → tgt.

    src, tgt: arrays of shape (N, 3) in mm. N >= 3.
    mode: 'rigid' (R, t) or 'similarity' (R, t, scale).

    Returns dict { R, t, scale, transform4x4, residual_rms_mm }.
    """
    src = np.asarray(src, dtype=np.float64)
    tgt = np.asarray(tgt, dtype=np.float64)
    if src.shape[0] < 3 or src.shape != tgt.shape or src.shape[1] != 3:
        raise ValueError(f"kabsch: need ≥3 paired (N,3) points, got src {src.shape} tgt {tgt.shape}")

    c_src = src.mean(axis=0)
    c_tgt = tgt.mean(axis=0)
    P = src - c_src
    Q = tgt - c_tgt
    H = P.T @ Q
    # Use numpy's SVD (via LAPACK)
    U, S, Vt = np.linalg.svd(H)
    # Reflection check: d = sign(det(V × Uᵀ))
    d = 1.0 if np.linalg.det(Vt.T @ U.T) >= 0 else -1.0
    D = np.diag([1.0, 1.0, d])
    R = Vt.T @ D @ U.T

    scale = 1.0
    if mode == "similarity":
        trace_DS = float(np.trace(D @ np.diag(S)))
        sum_p_sq = float((P * P).sum())
        scale = trace_DS / sum_p_sq if sum_p_sq > 0 else 1.0

    t = c_tgt - scale * (R @ c_src)

    # Residual
    transformed = (scale * (R @ src.T)).T + t
    residuals = transformed - tgt
    residual_rms_mm = float(math.sqrt((residuals * residuals).sum() / src.shape[0]))

    sR = scale * R
    transform4x4 = np.eye(4)
    transform4x4[:3, :3] = sR
    transform4x4[:3, 3] = t

    return {
        "R": R.tolist(),
        "t": t.tolist(),
        "scale": scale,
        "transform4x4": transform4x4.tolist(),
        "residual_rms_mm": residual_rms_mm,
    }


# ==============================================================
# Exports / public API
# ==============================================================

__all__ = [
    "K_LED", "Y90_T_HALF_H", "Y90_LAMBDA", "PARTITION_FACTOR",
    "density_for_label",
    "TumorInput",
    "method1_from_inputs",
    "method2_voxel_dose",
    "compute_dvh",
    "kabsch",
]
