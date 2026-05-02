"""Runs SHARED-001 phantoms #1~#5 against voxel_core.py reference.

Asserts expected values per validation.md and writes output_py.json.

Usage:  python3 reference/tests/run_phantoms.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

# Allow `import voxel_core` from sibling directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import voxel_core as VC  # noqa: E402


failures = []


def approx(actual, expected, abs_tol, rel_tol):
    if not (math.isfinite(actual) and math.isfinite(expected)):
        return False
    diff = abs(actual - expected)
    if diff <= abs_tol:
        return True
    return abs(diff / (expected or 1)) <= rel_tol


def check(name, ok, detail=""):
    if not ok:
        failures.append(f"FAIL {name}: {detail}")
    else:
        print(f"PASS {name}")


# ==============================================================
# Phantom #1
# ==============================================================
def run_phantom1():
    N = 1000
    spect = np.full(N, 100.0)
    liver_mask = np.ones(N, dtype=np.uint8)
    out = VC.method2_voxel_dose(
        spect_volume=spect,
        masks={"Liver": liver_mask},
        voxel_volume_cc=1.0,
        calibration={
            "calibration_factor_mbq_per_count": 0.01,
            "acquisition_timestamp": None,
            "reference_timestamp": None,
        },
    )
    liver = next(r for r in out["results"] if r["roi_label"] == "Liver")
    expected = 47.30476190476
    check("Phantom1 mean_gy", approx(liver["mean_gy"], expected, 0.01, 0.005),
          f"got {liver['mean_gy']} expected {expected}")
    check("Phantom1 max_gy", approx(liver["max_gy"], expected, 0.01, 0.005),
          f"got {liver['max_gy']}")
    check("Phantom1 d95_gy", approx(liver["d95_gy"], expected, 0.01, 0.005),
          f"got {liver['d95_gy']}")
    check("Phantom1 d70_gy", approx(liver["d70_gy"], expected, 0.01, 0.005),
          f"got {liver['d70_gy']}")
    check("Phantom1 voxel_count", liver["voxel_count"] == 1000,
          f"got {liver['voxel_count']}")
    dvh = VC.compute_dvh(out["dose_volume"], liver_mask, bins=100, dose_max=600)
    check("Phantom1 DVH point count", len(dvh["points"]) == 101,
          f"got {len(dvh['points'])}")
    check("Phantom1 DVH V(0) = 100", dvh["points"][0]["volume_pct"] == 100,
          f"got {dvh['points'][0]['volume_pct']}")
    check("Phantom1 DVH V(48) = 0", dvh["points"][8]["volume_pct"] == 0,
          f"got {dvh['points'][8]['volume_pct']}")
    return {"liver": liver, "dvh": dvh, "doseSample": float(out["dose_volume"][0])}


# ==============================================================
# Phantom #2
# ==============================================================
def run_phantom2():
    N = 1000
    spect = np.zeros(N)
    spect[555] = 10000
    liver_mask = np.ones(N, dtype=np.uint8)
    out = VC.method2_voxel_dose(
        spect_volume=spect,
        masks={"Liver": liver_mask},
        voxel_volume_cc=1.0,
        calibration={
            "calibration_factor_mbq_per_count": 0.1,
            "acquisition_timestamp": None,
            "reference_timestamp": None,
        },
    )
    liver = next(r for r in out["results"] if r["roi_label"] == "Liver")
    expected_hot = 47304.7619
    check("Phantom2 max_gy hot voxel", approx(liver["max_gy"], expected_hot, 1, 0.005),
          f"got {liver['max_gy']}")
    check("Phantom2 mean_gy", approx(liver["mean_gy"], expected_hot / 1000, 0.001, 0.005),
          f"got {liver['mean_gy']}")
    check("Phantom2 d95_gy = 0", liver["d95_gy"] == 0, f"got {liver['d95_gy']}")
    check("Phantom2 d70_gy = 0", liver["d70_gy"] == 0, f"got {liver['d70_gy']}")
    dvh = VC.compute_dvh(out["dose_volume"], liver_mask, bins=100, dose_max=600)
    check("Phantom2 DVH overflow_count", dvh["overflow_count"] == 1,
          f"got {dvh['overflow_count']}")
    check("Phantom2 DVH V(0) = 100", dvh["points"][0]["volume_pct"] == 100,
          f"got {dvh['points'][0]['volume_pct']}")
    check("Phantom2 DVH V(6) = 0.1", approx(dvh["points"][1]["volume_pct"], 0.1, 1e-9, 1e-9),
          f"got {dvh['points'][1]['volume_pct']}")
    return {"liver": liver, "dvh": dvh, "hotDose": float(out["dose_volume"][555])}


# ==============================================================
# Phantom #3
# ==============================================================
def run_phantom3():
    out = VC.method1_from_inputs(
        tumors=[
            VC.TumorInput(label="Tumor1", mean_count=5000, V_T_cc=30),
            VC.TumorInput(label="Tumor2", mean_count=4000, V_T_cc=20),
        ],
        count_NT=1000,
        V_N_cc=950,
        A_gbq=2.5,
        lsf_fraction=0.10,
    )
    t1 = next(r for r in out if r["roi_label"] == "Tumor1" and "derived_from" not in r)
    t2 = next(r for r in out if r["roi_label"] == "Tumor2" and "derived_from" not in r)
    liver_t1 = next(r for r in out if r.get("derived_from") == "Tumor1")
    liver_t2 = next(r for r in out if r.get("derived_from") == "Tumor2")
    check("Phantom3 D_T1", approx(t1["dose_gy"], 507.989, 0.5, 0.001),
          f"got {t1['dose_gy']}")
    check("Phantom3 T/N1", approx(t1["tn_ratio"], 5.0, 1e-9, 1e-9),
          f"got {t1['tn_ratio']}")
    check("Phantom3 D_T2", approx(t2["dose_gy"], 433.951, 0.5, 0.001),
          f"got {t2['dose_gy']}")
    check("Phantom3 T/N2", approx(t2["tn_ratio"], 4.0, 1e-9, 1e-9),
          f"got {t2['tn_ratio']}")
    check("Phantom3 D_N1", approx(liver_t1["dose_gy"], 101.598, 0.1, 0.001),
          f"got {liver_t1['dose_gy']}")
    check("Phantom3 D_N2", approx(liver_t2["dose_gy"], 108.488, 0.1, 0.001),
          f"got {liver_t2['dose_gy']}")
    return {"results": out}


# ==============================================================
# Phantom #4
# ==============================================================
def run_phantom4():
    src = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    tgt = [[0, 1, 0], [-1, 0, 0], [0, 0, 1]]
    reg = VC.kabsch(src, tgt, mode="rigid")
    expected_R = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
    max_diff = 0.0
    for i in range(3):
        for j in range(3):
            max_diff = max(max_diff, abs(reg["R"][i][j] - expected_R[i][j]))
    check("Phantom4 R matrix", max_diff < 1e-9, f"max diff {max_diff}")
    check("Phantom4 t", max(abs(x) for x in reg["t"]) < 1e-9,
          f"t = {reg['t']}")
    check("Phantom4 residual_rms_mm", reg["residual_rms_mm"] < 1e-9,
          f"got {reg['residual_rms_mm']}")
    return {"reg": reg}


# ==============================================================
# Phantom #5
# ==============================================================
def run_phantom5():
    N = 1000
    spect = np.full(N, 100.0)
    liver_mask = np.ones(N, dtype=np.uint8)
    out = VC.method2_voxel_dose(
        spect_volume=spect,
        masks={"Liver": liver_mask},
        voxel_volume_cc=1.0,
        calibration={
            "calibration_factor_mbq_per_count": None,
            "acquisition_timestamp": None,
            "reference_timestamp": None,
        },
    )
    liver = next(r for r in out["results"] if r["roi_label"] == "Liver")
    check("Phantom5 isRelative", out["is_relative"] is True,
          f"got {out['is_relative']}")
    check("Phantom5 units", liver["units"] == "relative",
          f"got {liver['units']}")
    check("Phantom5 has mean_relative", isinstance(liver.get("mean_relative"), float),
          f"got {liver.get('mean_relative')}")
    check("Phantom5 no mean_gy", "mean_gy" not in liver,
          f"got {liver.get('mean_gy')}")
    return {"liver": liver}


# ==============================================================
# Run all
# ==============================================================
def main():
    out = {
        "phantom1": run_phantom1(),
        "phantom2": run_phantom2(),
        "phantom3": run_phantom3(),
        "phantom4": run_phantom4(),
        "phantom5": run_phantom5(),
    }
    out_path = Path(__file__).parent / "output_py.json"
    out_path.write_text(json.dumps(out, indent=2, default=lambda o: o.tolist()))
    print(f"\nWrote {out_path}")
    if failures:
        print(f"\n{len(failures)} FAILURES:", file=sys.stderr)
        for f in failures:
            print(" ", f, file=sys.stderr)
        sys.exit(1)
    print("\nAll Python phantom checks PASS")


if __name__ == "__main__":
    main()
