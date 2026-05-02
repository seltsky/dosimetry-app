// SPEC-DOSI-VOXEL-SHARED-001 reference implementation (JavaScript).
// Pure functions. No DOM, no DICOM. Mirrors voxel_core.py byte-for-byte on
// phantoms #1~#5 (per validation.md tolerance matrix).
//
// Constants from algorithms.md § 0.

'use strict';

const K_LED = 49.67;        // J/kg/GBq, Y-90 LED constant
const Y90_T_HALF_H = 64.1;  // hours
const Y90_LAMBDA = Math.LN2 / Y90_T_HALF_H;
const PARTITION_FACTOR = 49670; // K * 1000, with V in cm³ and density implicit 1.0

const DEFAULT_DENSITY = {
  Liver: 1.05,
  Perfused: 1.05,
  Lung: 0.30,
  Tumor: 1.05,
};

function densityForLabel(label) {
  if (label.startsWith('Tumor')) return DEFAULT_DENSITY.Tumor;
  return DEFAULT_DENSITY[label] ?? 1.05;
}

// ============================================================
// Method 1 — ROI Partition Model
// ============================================================

/**
 * Per-tumor partition model.
 * @param {{tumors: {label, mean_count, V_T_cc}[], count_NT, V_N_cc, A_gbq, lsf_fraction}} args
 * @returns {Array<method1Result>}
 */
function method1FromInputs({ tumors, count_NT, V_N_cc, A_gbq, lsf_fraction }) {
  const out = [];
  if (count_NT == null || count_NT === 0) {
    return out.concat(tumors.map((t) => ({
      roi_label: t.label,
      units: 'gy',
      tn_ratio: 0,
      v_t_cc: t.V_T_cc,
      v_n_cc: V_N_cc,
      not_evaluated: true,
    })));
  }
  const oneMinusLsf = 1 - lsf_fraction;
  for (const t of tumors) {
    const tn = t.mean_count / count_NT;
    const denom = tn * t.V_T_cc + V_N_cc;
    if (denom <= 0) {
      out.push({ roi_label: t.label, units: 'gy', not_evaluated: true });
      continue;
    }
    const D_T = A_gbq * PARTITION_FACTOR * oneMinusLsf * tn / denom;
    out.push({
      roi_label: t.label,
      units: 'gy',
      dose_gy: D_T,
      tn_ratio: tn,
      v_t_cc: t.V_T_cc,
      v_n_cc: V_N_cc,
    });
    // Non-tumor compartment dose per-tumor (algorithms § 2 step 9)
    out.push({
      roi_label: 'Liver',
      units: 'gy',
      dose_gy: D_T / tn,
      v_n_cc: V_N_cc,
      derived_from: t.label,
    });
  }
  return out;
}

// ============================================================
// Method 2 — LED Voxel Dose
// ============================================================

/**
 * @param {Object} args
 * @param {Float32Array|Float64Array|number[]} args.spectVolume
 * @param {Map<string, Uint8Array>} args.masks  label → mask (0/1) same length as spectVolume
 * @param {number} args.voxel_volume_cc
 * @param {{calibration_factor_mbq_per_count: number|null,
 *          acquisition_timestamp: string|null, reference_timestamp: string|null}} args.calibration
 * @returns {{doseVolume: Float64Array, results: Array<method2Result>, isRelative: boolean}}
 */
function method2VoxelDose({ spectVolume, masks, voxel_volume_cc, calibration }) {
  const N = spectVolume.length;
  const cCal = calibration.calibration_factor_mbq_per_count;
  const isRelative = (cCal == null);

  // Decay
  let decay = 1.0;
  if (calibration.acquisition_timestamp && calibration.reference_timestamp) {
    const t_s = Date.parse(calibration.acquisition_timestamp);
    const t_r = Date.parse(calibration.reference_timestamp);
    if (!Number.isNaN(t_s) && !Number.isNaN(t_r)) {
      const dt_h = (t_r - t_s) / 3600000;
      decay = Math.exp(-Y90_LAMBDA * dt_h);
    }
  }

  // Per-voxel effective density (priority: Tumor > Lung > Perfused > Liver)
  const labelPriority = [
    'Tumor10','Tumor9','Tumor8','Tumor7','Tumor6','Tumor5',
    'Tumor4','Tumor3','Tumor2','Tumor1','Lung','Perfused','Liver',
  ];
  const densityVolume = new Float64Array(N);
  densityVolume.fill(1.05);
  for (const label of labelPriority) {
    const m = masks.get(label);
    if (!m) continue;
    const rho = densityForLabel(label);
    for (let i = 0; i < N; i++) if (m[i]) densityVolume[i] = rho;
  }

  // Per-voxel dose
  const massConvertCcToKgUnitDensity = voxel_volume_cc / 1000;
  const doseVolume = new Float64Array(N);
  const factor = isRelative ? decay : (cCal * decay);
  for (let i = 0; i < N; i++) {
    const count = Math.max(0, spectVolume[i]);
    const A_mbq = count * factor;
    const m_kg = massConvertCcToKgUnitDensity * densityVolume[i];
    if (m_kg <= 0) continue;
    doseVolume[i] = A_mbq * 0.001 * K_LED / m_kg;
  }

  // ROI stats
  const results = [];
  for (const [label, mask] of masks.entries()) {
    const doses = [];
    for (let i = 0; i < N; i++) if (mask[i]) doses.push(doseVolume[i]);
    if (doses.length === 0) {
      results.push({ roi_label: label, units: isRelative ? 'relative' : 'gy',
        voxel_count: 0, not_evaluated: true });
      continue;
    }
    doses.sort((a, b) => a - b);
    const n = doses.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += doses[i];
    const mean = sum / n;
    const max = doses[n - 1];
    const d95 = percentileSorted(doses, 5);
    const d70 = percentileSorted(doses, 30);
    if (isRelative) {
      results.push({ roi_label: label, units: 'relative', voxel_count: n,
        mean_relative: mean, max_relative: max, d95_relative: d95, d70_relative: d70 });
    } else {
      results.push({ roi_label: label, units: 'gy', voxel_count: n,
        mean_gy: mean, max_gy: max, d95_gy: d95, d70_gy: d70 });
    }
  }
  return { doseVolume, results, isRelative };
}

function percentileSorted(sortedAsc, pct) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (pct / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (idx - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

// ============================================================
// DVH — Cumulative
// ============================================================

/**
 * @param {Float64Array|number[]} doseVolume
 * @param {Uint8Array} mask
 * @param {{bins?: number, dose_max?: number, units?: 'gy'|'relative'}} options
 * @returns {{points: {dose, volume_pct}[], voxel_count, overflow_count, units}}
 */
function computeDVH(doseVolume, mask, options = {}) {
  const bins = options.bins ?? 100;
  const dose_max = options.dose_max ?? 600;
  const units = options.units ?? 'gy';
  const bin_width = dose_max / bins;
  const N = doseVolume.length;
  const H = new Int32Array(bins);
  let voxel_count = 0;
  let overflow_count = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    voxel_count++;
    let bi = Math.floor(doseVolume[i] / bin_width);
    if (bi >= bins) { bi = bins - 1; overflow_count++; }
    if (bi < 0) bi = 0;
    H[bi]++;
  }
  if (voxel_count === 0) {
    return { points: [], voxel_count: 0, overflow_count: 0, units };
  }
  const points = [];
  let cum = voxel_count;
  for (let i = 0; i < bins; i++) {
    points.push({ dose: i * bin_width, volume_pct: 100 * cum / voxel_count });
    cum -= H[i];
  }
  points.push({ dose: dose_max, volume_pct: 0 });
  return { points, voxel_count, overflow_count, units };
}

// ============================================================
// Kabsch SVD — Manual Landmark Registration
// ============================================================

/**
 * Manual landmark registration via Horn's quaternion method (1987).
 * Handles rank-deficient (3-coplanar-point) cases that trip up direct SVD.
 *
 * @param {number[][]} src  N×3 mm
 * @param {number[][]} tgt  N×3 mm
 * @param {'rigid'|'similarity'} mode
 * @returns {{R: number[][], t: number[], scale: number, transform4x4: number[][], residual_rms_mm: number}}
 */
function kabsch(src, tgt, mode = 'rigid') {
  const N = src.length;
  if (N < 3 || tgt.length !== N) {
    throw new Error(`kabsch: need at least 3 paired points, got ${N}`);
  }
  // Centroids
  const c_src = [0, 0, 0], c_tgt = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    for (let a = 0; a < 3; a++) {
      c_src[a] += src[i][a];
      c_tgt[a] += tgt[i][a];
    }
  }
  for (let a = 0; a < 3; a++) { c_src[a] /= N; c_tgt[a] /= N; }
  // Center
  const P = new Array(N), Q = new Array(N);
  for (let i = 0; i < N; i++) {
    P[i] = [src[i][0] - c_src[0], src[i][1] - c_src[1], src[i][2] - c_src[2]];
    Q[i] = [tgt[i][0] - c_tgt[0], tgt[i][1] - c_tgt[1], tgt[i][2] - c_tgt[2]];
  }
  // M[a][b] = sum_i P_i[a] * Q_i[b]   (3x3)
  const M = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < N; i++) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        M[a][b] += P[i][a] * Q[i][b];
      }
    }
  }
  // Build Horn's symmetric 4x4 N matrix.
  const Sxx = M[0][0], Sxy = M[0][1], Sxz = M[0][2];
  const Syx = M[1][0], Syy = M[1][1], Syz = M[1][2];
  const Szx = M[2][0], Szy = M[2][1], Szz = M[2][2];
  const NN = [
    [ Sxx+Syy+Szz,  Syz-Szy,      Szx-Sxz,      Sxy-Syx     ],
    [ Syz-Szy,      Sxx-Syy-Szz,  Sxy+Syx,      Szx+Sxz     ],
    [ Szx-Sxz,      Sxy+Syx,     -Sxx+Syy-Szz,  Syz+Szy     ],
    [ Sxy-Syx,      Szx+Sxz,      Syz+Szy,     -Sxx-Syy+Szz ],
  ];
  // Largest eigenvalue's eigenvector is the optimal quaternion q = (w, x, y, z).
  const { Q: eigVecs, lambdas } = jacobiEigen4(NN);
  let imax = 0;
  for (let i = 1; i < 4; i++) if (lambdas[i] > lambdas[imax]) imax = i;
  let w = eigVecs[0][imax], qx = eigVecs[1][imax], qy = eigVecs[2][imax], qz = eigVecs[3][imax];
  // Normalize and fix sign convention (w >= 0).
  const qnorm = Math.sqrt(w*w + qx*qx + qy*qy + qz*qz);
  if (qnorm > 0) { w /= qnorm; qx /= qnorm; qy /= qnorm; qz /= qnorm; }
  if (w < 0) { w = -w; qx = -qx; qy = -qy; qz = -qz; }
  // Quaternion → 3x3 rotation
  const R = [
    [ w*w + qx*qx - qy*qy - qz*qz,  2*(qx*qy - w*qz),               2*(qx*qz + w*qy)             ],
    [ 2*(qx*qy + w*qz),             w*w - qx*qx + qy*qy - qz*qz,    2*(qy*qz - w*qx)             ],
    [ 2*(qx*qz - w*qy),             2*(qy*qz + w*qx),               w*w - qx*qx - qy*qy + qz*qz ],
  ];

  let scale = 1.0;
  if (mode === 'similarity') {
    // Optimal scale: s = sum_i (R P_i) · Q_i / sum_i |P_i|²
    let num = 0, den = 0;
    for (let i = 0; i < N; i++) {
      const RP = matvec3(R, P[i]);
      num += RP[0]*Q[i][0] + RP[1]*Q[i][1] + RP[2]*Q[i][2];
      den += P[i][0]*P[i][0] + P[i][1]*P[i][1] + P[i][2]*P[i][2];
    }
    scale = den > 0 ? num / den : 1.0;
  }

  // t = c_tgt − scale × R × c_src
  const Rc_src = matvec3(R, c_src);
  const t = [
    c_tgt[0] - scale * Rc_src[0],
    c_tgt[1] - scale * Rc_src[1],
    c_tgt[2] - scale * Rc_src[2],
  ];

  // Residual
  let sumSq = 0;
  for (let i = 0; i < N; i++) {
    const Rs_i = matvec3(R, src[i]);
    const dx = scale * Rs_i[0] + t[0] - tgt[i][0];
    const dy = scale * Rs_i[1] + t[1] - tgt[i][1];
    const dz = scale * Rs_i[2] + t[2] - tgt[i][2];
    sumSq += dx*dx + dy*dy + dz*dz;
  }
  const residual_rms_mm = Math.sqrt(sumSq / N);

  // 4×4 transform
  const sR = [
    [scale*R[0][0], scale*R[0][1], scale*R[0][2]],
    [scale*R[1][0], scale*R[1][1], scale*R[1][2]],
    [scale*R[2][0], scale*R[2][1], scale*R[2][2]],
  ];
  const transform4x4 = [
    [sR[0][0], sR[0][1], sR[0][2], t[0]],
    [sR[1][0], sR[1][1], sR[1][2], t[1]],
    [sR[2][0], sR[2][1], sR[2][2], t[2]],
    [0, 0, 0, 1],
  ];
  return { R, t, scale, transform4x4, residual_rms_mm };
}

/**
 * Jacobi eigendecomposition of symmetric 4×4 matrix.
 * Returns Q with eigenvectors as columns and lambdas as the diagonal eigenvalues.
 */
function jacobiEigen4(M) {
  const A = [[M[0][0],M[0][1],M[0][2],M[0][3]],
             [M[1][0],M[1][1],M[1][2],M[1][3]],
             [M[2][0],M[2][1],M[2][2],M[2][3]],
             [M[3][0],M[3][1],M[3][2],M[3][3]]];
  const Q = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p+1; q < 4; q++) off += Math.abs(A[p][q]);
    if (off < 1e-14) break;
    for (let p = 0; p < 3; p++) for (let q = p+1; q < 4; q++) {
      if (Math.abs(A[p][q]) < 1e-15) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      let tval;
      if (Math.abs(theta) > 1e15) tval = 1 / (2*theta);
      else tval = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta*theta + 1));
      const c = 1 / Math.sqrt(tval*tval + 1);
      const s = tval * c;
      const Apq = A[p][q];
      const App = A[p][p], Aqq = A[q][q];
      A[p][p] = App - tval * Apq;
      A[q][q] = Aqq + tval * Apq;
      A[p][q] = 0;
      A[q][p] = 0;
      for (let r = 0; r < 4; r++) {
        if (r !== p && r !== q) {
          const Arp = A[r][p], Arq = A[r][q];
          A[r][p] = c*Arp - s*Arq;
          A[p][r] = A[r][p];
          A[r][q] = s*Arp + c*Arq;
          A[q][r] = A[r][q];
        }
        const Qrp = Q[r][p], Qrq = Q[r][q];
        Q[r][p] = c*Qrp - s*Qrq;
        Q[r][q] = s*Qrp + c*Qrq;
      }
    }
  }
  return { Q, lambdas: [A[0][0], A[1][1], A[2][2], A[3][3]] };
}

// 3×3 helpers
function matmul3(A, B) {
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
    C[i][j] = s;
  }
  return C;
}
function transpose3(A) {
  return [[A[0][0],A[1][0],A[2][0]],[A[0][1],A[1][1],A[2][1]],[A[0][2],A[1][2],A[2][2]]];
}
function det3(A) {
  return A[0][0] * (A[1][1]*A[2][2] - A[1][2]*A[2][1])
       - A[0][1] * (A[1][0]*A[2][2] - A[1][2]*A[2][0])
       + A[0][2] * (A[1][0]*A[2][1] - A[1][1]*A[2][0]);
}
function matvec3(A, v) {
  return [
    A[0][0]*v[0] + A[0][1]*v[1] + A[0][2]*v[2],
    A[1][0]*v[0] + A[1][1]*v[1] + A[1][2]*v[2],
    A[2][0]*v[0] + A[2][1]*v[1] + A[2][2]*v[2],
  ];
}

/**
 * 3×3 SVD via one-sided Jacobi on AᵀA → eigenvectors V, then U = A V Σ⁻¹.
 * Returns Σ as a length-3 array of singular values (descending).
 * Adequate accuracy for landmark counts ≤ 32 (tested via phantom #4).
 */
function svd3(A) {
  // AᵀA
  const At = transpose3(A);
  const M = matmul3(At, A);
  const { Q: V, lambdas } = jacobiEigen3(M);
  // Sort descending by lambda
  const order = [0,1,2].sort((i,j) => lambdas[j] - lambdas[i]);
  const sortedLambdas = order.map(i => lambdas[i]);
  const Vsorted = [
    [V[0][order[0]], V[0][order[1]], V[0][order[2]]],
    [V[1][order[0]], V[1][order[1]], V[1][order[2]]],
    [V[2][order[0]], V[2][order[1]], V[2][order[2]]],
  ];
  const S = sortedLambdas.map(l => Math.sqrt(Math.max(0, l)));
  // U = A V Σ⁻¹
  const AV = matmul3(A, Vsorted);
  const U = [[0,0,0],[0,0,0],[0,0,0]];
  for (let j = 0; j < 3; j++) {
    const sj = S[j];
    for (let i = 0; i < 3; i++) {
      U[i][j] = sj > 1e-14 ? AV[i][j] / sj : 0;
    }
  }
  // Re-orthogonalize the third column if singular value was 0
  if (S[2] < 1e-14) {
    U[0][2] = U[1][0]*U[2][1] - U[2][0]*U[1][1];
    U[1][2] = U[2][0]*U[0][1] - U[0][0]*U[2][1];
    U[2][2] = U[0][0]*U[1][1] - U[1][0]*U[0][1];
  }
  return { U, S, Vt: transpose3(Vsorted) };
}

/**
 * Jacobi eigendecomposition of symmetric 3×3 matrix.
 * Returns Q (orthonormal columns = eigenvectors) and lambdas (eigenvalues).
 */
function jacobiEigen3(M) {
  const A = [[M[0][0],M[0][1],M[0][2]],[M[1][0],M[1][1],M[1][2]],[M[2][0],M[2][1],M[2][2]]];
  const Q = [[1,0,0],[0,1,0],[0,0,1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
    if (off < 1e-14) break;
    for (let p = 0; p < 2; p++) for (let q = p+1; q < 3; q++) {
      if (Math.abs(A[p][q]) < 1e-15) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      let tval;
      if (Math.abs(theta) > 1e15) tval = 1 / (2*theta);
      else tval = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta*theta + 1));
      const c = 1 / Math.sqrt(tval*tval + 1);
      const s = tval * c;
      // Apply rotation
      const Apq = A[p][q];
      const App = A[p][p], Aqq = A[q][q];
      A[p][p] = App - tval * Apq;
      A[q][q] = Aqq + tval * Apq;
      A[p][q] = 0;
      A[q][p] = 0;
      for (let r = 0; r < 3; r++) {
        if (r !== p && r !== q) {
          const Arp = A[r][p], Arq = A[r][q];
          A[r][p] = c*Arp - s*Arq;
          A[p][r] = A[r][p];
          A[r][q] = s*Arp + c*Arq;
          A[q][r] = A[r][q];
        }
        const Qrp = Q[r][p], Qrq = Q[r][q];
        Q[r][p] = c*Qrp - s*Qrq;
        Q[r][q] = s*Qrp + c*Qrq;
      }
    }
  }
  return { Q, lambdas: [A[0][0], A[1][1], A[2][2]] };
}

// ============================================================
// Exports
// ============================================================
const VoxelCore = {
  K_LED, Y90_T_HALF_H, Y90_LAMBDA, PARTITION_FACTOR,
  densityForLabel,
  method1FromInputs,
  method2VoxelDose,
  computeDVH,
  kabsch,
  // helpers exported for tests
  _percentileSorted: percentileSorted,
  _matmul3: matmul3,
  _transpose3: transpose3,
  _det3: det3,
  _svd3: svd3,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VoxelCore;
}
if (typeof window !== 'undefined') {
  window.VoxelCore = VoxelCore;
}
