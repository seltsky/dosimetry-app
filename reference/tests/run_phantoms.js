// Runs SHARED-001 phantoms #1~#4 against voxel-core.js reference.
// Asserts expected values per validation.md and writes output_js.json.
//
// Usage:  node reference/tests/run_phantoms.js

'use strict';

const fs = require('fs');
const path = require('path');
const VC = require('../voxel-core.js');

function approx(actual, expected, absTol, relTol) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  const diff = Math.abs(actual - expected);
  if (diff <= absTol) return true;
  const ratio = Math.abs(diff / (expected || 1));
  return ratio <= relTol;
}

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(`FAIL ${name}: ${detail}`);
  else console.log(`PASS ${name}`);
}

// ============================================================
// Phantom #1 — uniform activity
// ============================================================
function runPhantom1() {
  const N = 1000; // 10×10×10
  const spect = new Float64Array(N).fill(100);
  const liverMask = new Uint8Array(N).fill(1);
  const out = VC.method2VoxelDose({
    spectVolume: spect,
    masks: new Map([['Liver', liverMask]]),
    voxel_volume_cc: 1.0,
    calibration: {
      calibration_factor_mbq_per_count: 0.01,
      acquisition_timestamp: null,
      reference_timestamp: null,
    },
  });
  const liver = out.results.find(r => r.roi_label === 'Liver');
  const expected = 47.30476190476;
  check('Phantom1 mean_gy', approx(liver.mean_gy, expected, 0.01, 0.005),
    `got ${liver.mean_gy} expected ${expected}`);
  check('Phantom1 max_gy', approx(liver.max_gy, expected, 0.01, 0.005),
    `got ${liver.max_gy}`);
  check('Phantom1 d95_gy', approx(liver.d95_gy, expected, 0.01, 0.005),
    `got ${liver.d95_gy}`);
  check('Phantom1 d70_gy', approx(liver.d70_gy, expected, 0.01, 0.005),
    `got ${liver.d70_gy}`);
  check('Phantom1 voxel_count', liver.voxel_count === 1000,
    `got ${liver.voxel_count}`);
  // DVH
  const dvh = VC.computeDVH(out.doseVolume, liverMask, { bins: 100, dose_max: 600 });
  check('Phantom1 DVH point count', dvh.points.length === 101,
    `got ${dvh.points.length}`);
  check('Phantom1 DVH V(0)', dvh.points[0].volume_pct === 100,
    `got ${dvh.points[0].volume_pct}`);
  check('Phantom1 DVH V(48) = 0', dvh.points[8].volume_pct === 0,
    `got ${dvh.points[8].volume_pct}`);
  return { liver, dvh, doseSample: out.doseVolume[0] };
}

// ============================================================
// Phantom #2 — single hot voxel
// ============================================================
function runPhantom2() {
  const N = 1000;
  const spect = new Float64Array(N);
  spect[555] = 10000; // single hot voxel
  const liverMask = new Uint8Array(N).fill(1);
  const out = VC.method2VoxelDose({
    spectVolume: spect,
    masks: new Map([['Liver', liverMask]]),
    voxel_volume_cc: 1.0,
    calibration: {
      calibration_factor_mbq_per_count: 0.1,
      acquisition_timestamp: null,
      reference_timestamp: null,
    },
  });
  const liver = out.results.find(r => r.roi_label === 'Liver');
  const expectedHot = 47304.7619;
  check('Phantom2 max_gy hot voxel', approx(liver.max_gy, expectedHot, 1, 0.005),
    `got ${liver.max_gy}`);
  check('Phantom2 mean_gy', approx(liver.mean_gy, expectedHot / 1000, 0.001, 0.005),
    `got ${liver.mean_gy}`);
  check('Phantom2 d95_gy = 0', liver.d95_gy === 0, `got ${liver.d95_gy}`);
  check('Phantom2 d70_gy = 0', liver.d70_gy === 0, `got ${liver.d70_gy}`);
  // DVH
  const dvh = VC.computeDVH(out.doseVolume, liverMask, { bins: 100, dose_max: 600 });
  check('Phantom2 DVH overflow_count', dvh.overflow_count === 1,
    `got ${dvh.overflow_count}`);
  check('Phantom2 DVH V(0) = 100', dvh.points[0].volume_pct === 100,
    `got ${dvh.points[0].volume_pct}`);
  check('Phantom2 DVH V(6) = 0.1', approx(dvh.points[1].volume_pct, 0.1, 1e-9, 1e-9),
    `got ${dvh.points[1].volume_pct}`);
  return { liver, dvh, hotDose: out.doseVolume[555] };
}

// ============================================================
// Phantom #3 — two tumor partition
// ============================================================
function runPhantom3() {
  const out = VC.method1FromInputs({
    tumors: [
      { label: 'Tumor1', mean_count: 5000, V_T_cc: 30 },
      { label: 'Tumor2', mean_count: 4000, V_T_cc: 20 },
    ],
    count_NT: 1000,
    V_N_cc: 950,
    A_gbq: 2.5,
    lsf_fraction: 0.10,
  });
  const t1 = out.find(r => r.roi_label === 'Tumor1' && !r.derived_from);
  const t2 = out.find(r => r.roi_label === 'Tumor2' && !r.derived_from);
  const liverFromT1 = out.find(r => r.derived_from === 'Tumor1');
  const liverFromT2 = out.find(r => r.derived_from === 'Tumor2');

  check('Phantom3 D_T1', approx(t1.dose_gy, 507.989, 0.5, 0.001),
    `got ${t1.dose_gy}`);
  check('Phantom3 T/N1', approx(t1.tn_ratio, 5.0, 1e-9, 1e-9),
    `got ${t1.tn_ratio}`);
  check('Phantom3 D_T2', approx(t2.dose_gy, 433.951, 0.5, 0.001),
    `got ${t2.dose_gy}`);
  check('Phantom3 T/N2', approx(t2.tn_ratio, 4.0, 1e-9, 1e-9),
    `got ${t2.tn_ratio}`);
  check('Phantom3 D_N1', approx(liverFromT1.dose_gy, 101.598, 0.1, 0.001),
    `got ${liverFromT1.dose_gy}`);
  check('Phantom3 D_N2', approx(liverFromT2.dose_gy, 108.488, 0.1, 0.001),
    `got ${liverFromT2.dose_gy}`);
  return { results: out };
}

// ============================================================
// Phantom #4 — Kabsch 90° z-rotation
// ============================================================
function runPhantom4() {
  const src = [[1,0,0],[0,1,0],[0,0,1]];
  const tgt = [[0,1,0],[-1,0,0],[0,0,1]];
  const reg = VC.kabsch(src, tgt, 'rigid');
  const expectedR = [[0,-1,0],[1,0,0],[0,0,1]];
  let maxRdiff = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    maxRdiff = Math.max(maxRdiff, Math.abs(reg.R[i][j] - expectedR[i][j]));
  }
  check('Phantom4 R matrix', maxRdiff < 1e-9,
    `max diff ${maxRdiff}`);
  check('Phantom4 t', Math.max(...reg.t.map(x => Math.abs(x))) < 1e-9,
    `t = ${JSON.stringify(reg.t)}`);
  check('Phantom4 residual_rms_mm', reg.residual_rms_mm < 1e-9,
    `got ${reg.residual_rms_mm}`);
  return { reg };
}

// ============================================================
// Phantom #5 — Calibration absent (relative mode)
// ============================================================
function runPhantom5() {
  const N = 1000;
  const spect = new Float64Array(N).fill(100);
  const liverMask = new Uint8Array(N).fill(1);
  const out = VC.method2VoxelDose({
    spectVolume: spect,
    masks: new Map([['Liver', liverMask]]),
    voxel_volume_cc: 1.0,
    calibration: {
      calibration_factor_mbq_per_count: null,
      acquisition_timestamp: null,
      reference_timestamp: null,
    },
  });
  const liver = out.results.find(r => r.roi_label === 'Liver');
  check('Phantom5 isRelative', out.isRelative === true,
    `got ${out.isRelative}`);
  check('Phantom5 units', liver.units === 'relative',
    `got ${liver.units}`);
  check('Phantom5 has mean_relative', typeof liver.mean_relative === 'number',
    `got ${liver.mean_relative}`);
  check('Phantom5 no mean_gy', liver.mean_gy === undefined,
    `got ${liver.mean_gy}`);
  return { liver };
}

// ============================================================
// Run all + emit JSON
// ============================================================
const out = {
  phantom1: runPhantom1(),
  phantom2: runPhantom2(),
  phantom3: runPhantom3(),
  phantom4: runPhantom4(),
  phantom5: runPhantom5(),
};

// Strip Float64Array fields before JSON serialize
function sanitize(v) {
  if (v instanceof Float64Array || v instanceof Uint8Array || v instanceof Int32Array) {
    return Array.from(v);
  }
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = sanitize(val);
    return o;
  }
  return v;
}
const outJson = sanitize(out);
const outPath = path.join(__dirname, 'output_js.json');
fs.writeFileSync(outPath, JSON.stringify(outJson, null, 2));
console.log(`\nWrote ${outPath}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILURES:`);
  for (const f of failures) console.error(' ', f);
  process.exit(1);
}
console.log(`\nAll JS phantom checks PASS`);
