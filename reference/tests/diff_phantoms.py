"""Cross-validation: diff JS vs Python reference output.

Runs run_phantoms.js + run_phantoms.py and compares output_js.json vs output_py.json
under SPEC-DOSI-VOXEL-SHARED-001 § Tolerance Matrix.

Usage:  python3 reference/tests/diff_phantoms.py
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Tolerances from validation.md § Tolerance Matrix
TOL = {
    "method1_dose": dict(rel=0.001, abs=0.01),    # ±0.1%
    "method2_stat": dict(rel=0.02, abs=0.05),     # ±2%
    "dvh_volume_pct": dict(rel=0.02, abs=0.5),    # ±2%
    "kabsch_rms": dict(rel=1.0, abs=1e-6),
    "kabsch_R": dict(rel=1.0, abs=1e-9),
    "default": dict(rel=0.005, abs=0.001),
}


def run(cmd, cwd):
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode != 0:
        raise SystemExit(f"FAIL: {' '.join(cmd)} returned {result.returncode}")


def within_tol(a, b, tol):
    if a is None or b is None:
        return a == b
    if not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        return a == b
    diff = abs(a - b)
    if diff <= tol["abs"]:
        return True
    denom = max(abs(a), abs(b), 1e-12)
    return (diff / denom) <= tol["rel"]


def diff_value(label, a, b, tol_key, mismatches):
    tol = TOL[tol_key]
    if not within_tol(a, b, tol):
        mismatches.append((label, a, b, tol_key))


def diff_phantoms():
    mismatches = []
    js = json.loads((HERE / "output_js.json").read_text())
    py = json.loads((HERE / "output_py.json").read_text())

    # Phantom 1 / 5 / 2 — Method 2 stats
    for ph in ("phantom1", "phantom2", "phantom5"):
        liver_js = js[ph]["liver"]
        liver_py = py[ph]["liver"]
        for k in ("mean_gy", "max_gy", "d95_gy", "d70_gy",
                  "mean_relative", "max_relative", "d95_relative", "d70_relative"):
            if k in liver_js or k in liver_py:
                diff_value(f"{ph}.liver.{k}", liver_js.get(k), liver_py.get(k),
                           "method2_stat", mismatches)
        # DVH
        dvh_js = js[ph].get("dvh")
        dvh_py = py[ph].get("dvh")
        if dvh_js and dvh_py:
            if len(dvh_js["points"]) != len(dvh_py["points"]):
                mismatches.append((f"{ph}.dvh.length", len(dvh_js["points"]),
                                   len(dvh_py["points"]), "default"))
            else:
                for i, (pj, pp) in enumerate(zip(dvh_js["points"], dvh_py["points"])):
                    diff_value(f"{ph}.dvh[{i}].dose", pj["dose"], pp["dose"],
                               "default", mismatches)
                    diff_value(f"{ph}.dvh[{i}].volume_pct", pj["volume_pct"],
                               pp["volume_pct"], "dvh_volume_pct", mismatches)

    # Phantom 3 — Method 1
    res_js = {(r["roi_label"], r.get("derived_from")): r for r in js["phantom3"]["results"]}
    res_py = {(r["roi_label"], r.get("derived_from")): r for r in py["phantom3"]["results"]}
    keys = set(res_js) & set(res_py)
    if not keys:
        mismatches.append(("phantom3.results", res_js, res_py, "default"))
    for k in keys:
        for f in ("dose_gy", "tn_ratio", "v_t_cc", "v_n_cc"):
            if f in res_js[k] or f in res_py[k]:
                diff_value(f"phantom3.{k}.{f}", res_js[k].get(f), res_py[k].get(f),
                           "method1_dose", mismatches)

    # Phantom 4 — Kabsch
    reg_js = js["phantom4"]["reg"]
    reg_py = py["phantom4"]["reg"]
    for i in range(3):
        for j in range(3):
            diff_value(f"phantom4.R[{i}][{j}]", reg_js["R"][i][j], reg_py["R"][i][j],
                       "kabsch_R", mismatches)
    for i in range(3):
        diff_value(f"phantom4.t[{i}]", reg_js["t"][i], reg_py["t"][i],
                   "kabsch_R", mismatches)
    diff_value("phantom4.residual_rms_mm", reg_js["residual_rms_mm"],
               reg_py["residual_rms_mm"], "kabsch_rms", mismatches)

    return mismatches


def main():
    print("--- Running JS reference ---")
    run(["node", "reference/tests/run_phantoms.js"], cwd=HERE.parent.parent)
    print("\n--- Running Python reference ---")
    run([sys.executable, "reference/tests/run_phantoms.py"], cwd=HERE.parent.parent)

    print("\n--- Cross-validating JS vs Python ---")
    mismatches = diff_phantoms()
    if mismatches:
        print(f"\n{len(mismatches)} MISMATCHES:", file=sys.stderr)
        for label, a, b, tk in mismatches:
            print(f"  [{tk}] {label}: js={a} py={b}", file=sys.stderr)
        sys.exit(1)
    print("PASS — all phantoms agree within tolerance")


if __name__ == "__main__":
    main()
