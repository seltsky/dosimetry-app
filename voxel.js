/* ========= SPEC-DOSI-VOXEL-WEB-001 — Voxel Tab (M1.1~M1.7) =================
   DICOM load + custom canvas rendering + manual landmark registration.
   Uses dwv.js v0.36.2 only as a DICOM parser; rendering / interaction is
   custom. ROI drawing (M2) and Methods 1/2/DVH (M3/M4) come in later rounds.
   Algorithms via VoxelCore (reference/voxel-core.js).
   =========================================================================== */
(function() {
'use strict';

// =====================================================================
// State
// =====================================================================
const state = {
  loaded: false,
  seriesByUid: new Map(),
  baseUid: null,
  ovlUid: null,
  baseVolume: null,
  ovlVolume: null,
  resampledOvl: null,
  cursorBase: { i: 0, j: 0, k: 0 },     // cross-hair in base voxel space
  cursorOvl:  { i: 0, j: 0, k: 0 },     // cross-hair in overlay voxel space
  viewMode: 'base',                      // 'base' shows base+overlay; 'ovl' shows ovl alone
  windowCenter: 40,
  windowWidth: 400,
  ovlCenter: null,
  ovlWidth: null,
  opacity: 0.5,
  colormap: 'hot',
  landmarkMode: false,
  landmarkTarget: 'base',
  landmarks: [],
  registration: null,
  phiFindings: [],
};

// =====================================================================
// DICOM tag helpers
// =====================================================================
const TAG = {
  Modality: 'x00080060',
  SeriesUID: 'x0020000e',
  IPP: 'x00200032',
  IOP: 'x00200037',
  PixelSpacing: 'x00280030',
  Rows: 'x00280010',
  Cols: 'x00280011',
  SliceThickness: 'x00180050',
  SpacingBetweenSlices: 'x00180088',
  BitsAllocated: 'x00280100',
  BitsStored: 'x00280101',
  PixelRepresentation: 'x00280103',
  RescaleSlope: 'x00281053',
  RescaleIntercept: 'x00281052',
  PixelData: 'x7fe00010',
  PatientName: 'x00100010',
  PatientID: 'x00100020',
  PatientBirthDate: 'x00100030',
  PatientAddress: 'x00101040',
  AccessionNumber: 'x00080050',
  StudyID: 'x00200010',
  ReferringPhysician: 'x00080090',
  FrameOfReferenceUID: 'x00200052',
};

function tagValue(els, key) {
  const el = els[key];
  if (!el || el.value == null) return undefined;
  const v = el.value;
  if (Array.isArray(v)) return v.length > 0 ? v[0] : undefined;
  return v;
}
function tagValues(els, key) {
  const el = els[key];
  if (!el || el.value == null) return [];
  return Array.isArray(el.value) ? el.value : [el.value];
}
function tagFloats(els, key) {
  const v = tagValue(els, key);
  if (v == null) return null;
  if (typeof v === 'string') return v.split('\\').map(Number);
  if (Array.isArray(v)) return v.map(Number);
  return [Number(v)];
}

// =====================================================================
// Parse one DICOM file → slice descriptor (no pixel decode yet)
// =====================================================================
async function readDicomMeta(file) {
  const buf = await file.arrayBuffer();
  try {
    const parser = new dwv.DicomParser();
    parser.parse(buf);
    const els = parser.getDicomElements();
    const phi = {
      PatientName: tagValue(els, TAG.PatientName) || '',
      PatientID: tagValue(els, TAG.PatientID) || '',
      PatientBirthDate: tagValue(els, TAG.PatientBirthDate) || '',
      PatientAddress: tagValue(els, TAG.PatientAddress) || '',
      AccessionNumber: tagValue(els, TAG.AccessionNumber) || '',
      StudyID: tagValue(els, TAG.StudyID) || '',
      ReferringPhysicianName: tagValue(els, TAG.ReferringPhysician) || '',
    };
    return {
      ok: true,
      modality: tagValue(els, TAG.Modality) || 'UNK',
      seriesUID: tagValue(els, TAG.SeriesUID) || '',
      frameOfRefUID: tagValue(els, TAG.FrameOfReferenceUID) || '',
      file, els, phi,
    };
  } catch (e) {
    return { ok: false, error: e.message, file };
  }
}

// =====================================================================
// Build a Volume from a list of slice descriptors of one series
// =====================================================================
function vec3sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vec3dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function vec3cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function vec3norm(a) {
  const m = Math.hypot(a[0], a[1], a[2]);
  return m > 0 ? [a[0]/m, a[1]/m, a[2]/m] : [0,0,0];
}

function decodePixelData(els, rows, cols) {
  const bitsAlloc = parseInt(tagValue(els, TAG.BitsAllocated) || 16, 10);
  const pixRep = parseInt(tagValue(els, TAG.PixelRepresentation) || 0, 10);
  const px = els[TAG.PixelData];
  if (!px) return null;
  let raw = px.value;
  if (Array.isArray(raw) && raw.length > 0 && (raw[0] instanceof ArrayBuffer ||
      raw[0]?.buffer || ArrayBuffer.isView(raw[0]))) {
    raw = raw[0];
  }
  if (!raw) return null;
  // raw can be Uint8Array, ArrayBuffer, or typed array. Normalize to ArrayBuffer + offset.
  let buffer, byteOffset, byteLength;
  if (raw instanceof ArrayBuffer) {
    buffer = raw; byteOffset = 0; byteLength = raw.byteLength;
  } else if (ArrayBuffer.isView(raw)) {
    buffer = raw.buffer; byteOffset = raw.byteOffset; byteLength = raw.byteLength;
  } else {
    return null;
  }
  const N = rows * cols;
  if (bitsAlloc === 16) {
    const Ctor = pixRep === 1 ? Int16Array : Uint16Array;
    const arr = new Ctor(buffer, byteOffset, Math.min(N, byteLength / 2 | 0));
    return arr;
  }
  if (bitsAlloc === 8) {
    const Ctor = pixRep === 1 ? Int8Array : Uint8Array;
    return new Ctor(buffer, byteOffset, Math.min(N, byteLength | 0));
  }
  if (bitsAlloc === 32) {
    return new Float32Array(buffer, byteOffset, Math.min(N, byteLength / 4 | 0));
  }
  return null;
}

async function buildVolumeFromSeries(slices) {
  if (!slices.length) return null;
  // Parse each file with elements available
  const els0 = slices[0].els;
  const cols = parseInt(tagValue(els0, TAG.Cols), 10);
  const rows = parseInt(tagValue(els0, TAG.Rows), 10);
  if (!cols || !rows) return null;
  const ipp0 = tagFloats(els0, TAG.IPP);
  const iop = tagFloats(els0, TAG.IOP);
  if (!ipp0 || !iop || iop.length < 6) return null;
  const X = vec3norm(iop.slice(0, 3));
  const Y = vec3norm(iop.slice(3, 6));
  const Z = vec3norm(vec3cross(X, Y));
  const ps = tagFloats(els0, TAG.PixelSpacing) || [1, 1];
  const Sy = ps[0]; // row spacing (j direction)
  const Sx = ps[1]; // column spacing (i direction)
  const sbs = parseFloat(tagValue(els0, TAG.SpacingBetweenSlices));
  const st = parseFloat(tagValue(els0, TAG.SliceThickness));

  // Sort slices by IPP projected onto Z
  slices.forEach((s) => {
    const ipp = tagFloats(s.els, TAG.IPP);
    s._kproj = ipp ? vec3dot(ipp, Z) : 0;
    s._ipp = ipp;
  });
  slices.sort((a, b) => a._kproj - b._kproj);

  // Compute slice spacing
  let Ss = !isNaN(sbs) ? sbs : (!isNaN(st) ? st : 1);
  if (slices.length > 1) {
    const observed = Math.abs(slices[1]._kproj - slices[0]._kproj);
    if (observed > 0.01) Ss = observed;
  }

  // Allocate volume
  const k = slices.length;
  const N = rows * cols * k;
  const data = new Float32Array(N);
  let minVal = Infinity, maxVal = -Infinity;
  for (let kk = 0; kk < k; kk++) {
    const s = slices[kk];
    const slope = parseFloat(tagValue(s.els, TAG.RescaleSlope) || '1');
    const intercept = parseFloat(tagValue(s.els, TAG.RescaleIntercept) || '0');
    const px = decodePixelData(s.els, rows, cols);
    if (!px) continue;
    const off = kk * rows * cols;
    const M = Math.min(px.length, rows * cols);
    for (let i = 0; i < M; i++) {
      const v = px[i] * slope + intercept;
      data[off + i] = v;
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
  }
  if (!isFinite(minVal)) { minVal = 0; maxVal = 0; }

  const ipp = slices[0]._ipp || [0, 0, 0];
  const ijkToRas = [
    [Sx * X[0], Sy * Y[0], Ss * Z[0], ipp[0]],
    [Sx * X[1], Sy * Y[1], Ss * Z[1], ipp[1]],
    [Sx * X[2], Sy * Y[2], Ss * Z[2], ipp[2]],
    [0, 0, 0, 1],
  ];

  return {
    data, dims: [cols, rows, k],
    spacing: [Sx, Sy, Ss],
    ijkToRas,
    modality: tagValue(els0, TAG.Modality) || 'UNK',
    frameOfRefUID: tagValue(els0, TAG.FrameOfReferenceUID) || '',
    range: [minVal, maxVal],
    iop, ipp0,
  };
}

function ijkToWorldMm(vol, i, j, k) {
  const M = vol.ijkToRas;
  return [
    M[0][0]*i + M[0][1]*j + M[0][2]*k + M[0][3],
    M[1][0]*i + M[1][1]*j + M[1][2]*k + M[1][3],
    M[2][0]*i + M[2][1]*j + M[2][2]*k + M[2][3],
  ];
}

// Inverse 4×4 affine of ijkToRas (for resampling)
function inverseAffine4(M) {
  // 3×3 linear part
  const a = [[M[0][0],M[0][1],M[0][2]],[M[1][0],M[1][1],M[1][2]],[M[2][0],M[2][1],M[2][2]]];
  const det = a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])
            - a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])
            + a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0]);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [[0,0,0],[0,0,0],[0,0,0]];
  inv[0][0] = (a[1][1]*a[2][2] - a[1][2]*a[2][1]) / det;
  inv[0][1] = (a[0][2]*a[2][1] - a[0][1]*a[2][2]) / det;
  inv[0][2] = (a[0][1]*a[1][2] - a[0][2]*a[1][1]) / det;
  inv[1][0] = (a[1][2]*a[2][0] - a[1][0]*a[2][2]) / det;
  inv[1][1] = (a[0][0]*a[2][2] - a[0][2]*a[2][0]) / det;
  inv[1][2] = (a[0][2]*a[1][0] - a[0][0]*a[1][2]) / det;
  inv[2][0] = (a[1][0]*a[2][1] - a[1][1]*a[2][0]) / det;
  inv[2][1] = (a[0][1]*a[2][0] - a[0][0]*a[2][1]) / det;
  inv[2][2] = (a[0][0]*a[1][1] - a[0][1]*a[1][0]) / det;
  const t = [M[0][3], M[1][3], M[2][3]];
  const it = [
    -(inv[0][0]*t[0] + inv[0][1]*t[1] + inv[0][2]*t[2]),
    -(inv[1][0]*t[0] + inv[1][1]*t[1] + inv[1][2]*t[2]),
    -(inv[2][0]*t[0] + inv[2][1]*t[1] + inv[2][2]*t[2]),
  ];
  return [
    [inv[0][0], inv[0][1], inv[0][2], it[0]],
    [inv[1][0], inv[1][1], inv[1][2], it[1]],
    [inv[2][0], inv[2][1], inv[2][2], it[2]],
    [0, 0, 0, 1],
  ];
}

// Apply 4×4 affine to a 3-vec
function affineMul(M, v) {
  return [
    M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2] + M[0][3],
    M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2] + M[1][3],
    M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2] + M[2][3],
  ];
}

function affineMulMat(A, B) {
  const C = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,1]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += A[i][k] * B[k][j];
    C[i][j] = s;
  }
  return C;
}

// =====================================================================
// Resample overlay onto base grid via nearest-neighbor
// =====================================================================
function resampleOverlay(baseVol, ovlVol, regTransform4x4) {
  // We have: world_base = baseVol.ijkToRas × ijk_base
  // After registration, ovl_world = regTransform × base_world (target → source)
  // No, regTransform maps src(ovl) → tgt(base). To resample ovl onto base grid,
  // for each base voxel, world_base, we need the *source* (ovl) location:
  //   ovl_world such that regTransform × ovl_world = world_base
  //   ovl_world = regTransform⁻¹ × world_base
  // Then convert ovl_world → ovl_ijk via ovlVol.rasToIjk.
  const rasToIjkOvl = inverseAffine4(ovlVol.ijkToRas);
  const regInv = inverseAffine4(regTransform4x4);
  if (!rasToIjkOvl || !regInv) return null;
  const baseIjkToRas = baseVol.ijkToRas;
  const [bi, bj, bk] = baseVol.dims;
  const [oi, oj, ok] = ovlVol.dims;
  const out = new Float32Array(bi * bj * bk);
  for (let z = 0; z < bk; z++) {
    for (let y = 0; y < bj; y++) {
      for (let x = 0; x < bi; x++) {
        const wbase = [
          baseIjkToRas[0][0]*x + baseIjkToRas[0][1]*y + baseIjkToRas[0][2]*z + baseIjkToRas[0][3],
          baseIjkToRas[1][0]*x + baseIjkToRas[1][1]*y + baseIjkToRas[1][2]*z + baseIjkToRas[1][3],
          baseIjkToRas[2][0]*x + baseIjkToRas[2][1]*y + baseIjkToRas[2][2]*z + baseIjkToRas[2][3],
        ];
        const wovl = affineMul(regInv, wbase);
        const ijk = affineMul(rasToIjkOvl, wovl);
        const ii = Math.round(ijk[0]);
        const jj = Math.round(ijk[1]);
        const kk = Math.round(ijk[2]);
        if (ii < 0 || ii >= oi || jj < 0 || jj >= oj || kk < 0 || kk >= ok) continue;
        out[z * bi * bj + y * bi + ii] = ovlVol.data[kk * oi * oj + jj * oi + ii];
      }
    }
  }
  // Compute resampled range
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (v < mn) mn = v; if (v > mx) mx = v;
  }
  if (!isFinite(mn)) { mn = 0; mx = 0; }
  return { data: out, dims: baseVol.dims, range: [mn, mx] };
}

// =====================================================================
// Colormaps (256-entry RGB LUTs)
// =====================================================================
function buildColormap(name) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r = 0, g = 0, b = 0;
    if (name === 'hot') {
      // black → red → yellow → white
      r = Math.min(1, t * 3);
      g = Math.max(0, Math.min(1, (t - 1/3) * 3));
      b = Math.max(0, Math.min(1, (t - 2/3) * 3));
    } else if (name === 'jet') {
      // blue → cyan → yellow → red
      r = Math.max(0, Math.min(1, 1.5 - Math.abs(4*t - 3)));
      g = Math.max(0, Math.min(1, 1.5 - Math.abs(4*t - 2)));
      b = Math.max(0, Math.min(1, 1.5 - Math.abs(4*t - 1)));
    } else { // viridis approx
      r = Math.max(0, Math.min(1, 0.267 + 1.27 * t - 0.4 * t*t));
      g = Math.max(0, Math.min(1, 0.005 + 1.5 * t - 0.5 * t*t));
      b = Math.max(0, Math.min(1, 0.33 + 0.5 * t - 0.7 * t*t + 0.3 * t*t*t));
    }
    lut[i*3]   = Math.round(r * 255);
    lut[i*3+1] = Math.round(g * 255);
    lut[i*3+2] = Math.round(b * 255);
  }
  return lut;
}

// =====================================================================
// Slice geometry: per-axis canvas dimensions + voxel access
// axis = 'axial' | 'sagittal' | 'coronal'
//   axial    fixes k, displays (i = canvas x, j = canvas y)
//   sagittal fixes i, displays (j = canvas x, k = canvas y)
//   coronal  fixes j, displays (i = canvas x, k = canvas y)
// =====================================================================
function viewportDims(vol, axis) {
  const [W, H, D] = vol.dims;
  if (axis === 'axial')    return [W, H];
  if (axis === 'sagittal') return [H, D];
  return [W, D]; // coronal
}

function voxelAt(vol, axis, sliceIdx, cx, cy) {
  const [W, H, D] = vol.dims;
  if (axis === 'axial')    return vol.data[sliceIdx * W * H + cy * W + cx];
  if (axis === 'sagittal') return vol.data[cy * W * H + cx * W + sliceIdx];
  return vol.data[cy * W * H + sliceIdx * W + cx]; // coronal
}

// Map (axis, sliceIdx, canvas x, canvas y) → volume voxel index (i, j, k)
function canvasToIjk(axis, sliceIdx, cx, cy) {
  if (axis === 'axial')    return [cx, cy, sliceIdx];
  if (axis === 'sagittal') return [sliceIdx, cx, cy];
  return [cx, sliceIdx, cy]; // coronal
}

// Map (axis, ijk) → canvas (x, y) for cross-hair drawing
function ijkToCanvas(axis, i, j, k) {
  if (axis === 'axial')    return [i, j];
  if (axis === 'sagittal') return [j, k];
  return [i, k]; // coronal
}

function renderBaseToCanvas(canvas, vol, axis, sliceIdx, center, width) {
  const ctx = canvas.getContext('2d');
  const [cw, ch] = viewportDims(vol, axis);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw; canvas.height = ch;
  }
  const img = ctx.createImageData(cw, ch);
  const lo = center - width / 2;
  const inv = 255 / Math.max(1e-6, width);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const v = voxelAt(vol, axis, sliceIdx, cx, cy);
      let g = (v - lo) * inv;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      const i4 = (cy * cw + cx) * 4;
      img.data[i4] = g; img.data[i4+1] = g; img.data[i4+2] = g; img.data[i4+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderOvlToCanvas(canvas, ovl, baseVol, axis, sliceIdx, center, width, opacity, lut) {
  const ctx = canvas.getContext('2d');
  if (!ovl) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  // Overlay must be on the base grid (resampled). Use base dims for canvas.
  const [cw, ch] = viewportDims(baseVol, axis);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw; canvas.height = ch;
  }
  const img = ctx.createImageData(cw, ch);
  const lo = center;
  const hi = Math.max(lo + 1e-6, lo + width);
  const alpha = Math.round(opacity * 255);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const v = voxelAt(ovl, axis, sliceIdx, cx, cy);
      const i4 = (cy * cw + cx) * 4;
      if (v <= lo) { img.data[i4+3] = 0; continue; }
      let t = (v - lo) / (hi - lo);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const idx = Math.round(t * 255) * 3;
      img.data[i4] = lut[idx];
      img.data[i4+1] = lut[idx+1];
      img.data[i4+2] = lut[idx+2];
      img.data[i4+3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Draw cross-hair lines + landmark markers + slice indicator on top canvas
function renderCrossToCanvas(canvas, vol, axis, cursor) {
  const [cw, ch] = viewportDims(vol, axis);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw; canvas.height = ch;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  // Cross-hair: vertical at "horizontal cursor coord", horizontal at "vertical cursor coord"
  const [hx, hy] = ijkToCanvas(axis, cursor.i, cursor.j, cursor.k);
  ctx.strokeStyle = 'rgba(255, 215, 0, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hx + 0.5, 0); ctx.lineTo(hx + 0.5, ch);
  ctx.moveTo(0, hy + 0.5); ctx.lineTo(cw, hy + 0.5);
  ctx.stroke();
}

// =====================================================================
// Hardware-fused detection
// =====================================================================
function isHardwareFused(baseVol, ovlVol) {
  if (!baseVol || !ovlVol) return false;
  if (!baseVol.frameOfRefUID || !ovlVol.frameOfRefUID) return false;
  if (baseVol.frameOfRefUID !== ovlVol.frameOfRefUID) return false;
  // Check origin within 1 mm and orientation parallel
  const dipp = vec3sub(
    [baseVol.ijkToRas[0][3], baseVol.ijkToRas[1][3], baseVol.ijkToRas[2][3]],
    [ovlVol.ijkToRas[0][3], ovlVol.ijkToRas[1][3], ovlVol.ijkToRas[2][3]]
  );
  if (Math.hypot(dipp[0], dipp[1], dipp[2]) > 1) return false;
  return true;
}

function identityTransform4() {
  return [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
}

// =====================================================================
// UI: drop zone + role assignment
// =====================================================================
const PHI_FIELDS = ['PatientName', 'PatientID', 'PatientBirthDate',
  'PatientAddress', 'AccessionNumber', 'StudyID', 'ReferringPhysicianName'];

function classifyPhi(metaList) {
  const findings = [];
  for (const m of metaList) {
    if (!m.ok) continue;
    for (const f of PHI_FIELDS) {
      const v = (m.phi[f] || '').trim();
      if (v && v !== 'ANONYMOUS') {
        findings.push({ field: f, sample: v.substring(0, 30), file: m.file.name });
      }
    }
  }
  return findings;
}

function showPhiWarn(findings) {
  const el = document.getElementById('voxelPhiWarn');
  if (!el) return;
  if (!findings || findings.length === 0) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const fields = [...new Set(findings.map(f => f.field))];
  el.style.display = '';
  el.innerHTML = `⚠️ PHI 의심 필드 ${fields.length}개: ${fields.join(', ')} — 익명화 후 사용 권장`;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => f.size > 0);
  if (!files.length) return;
  setText('voxelSeriesInfo', `분석 중... (${files.length}개)`);
  setHidden('voxelOnboarding', true);
  setHidden('voxelViewerWrap', false);

  // Parse metadata
  const metaList = [];
  for (const f of files) {
    if (!/\.(dcm|ima)$|^[^.]*$/i.test(f.name) && !f.name.includes('DICOM')) continue;
    const m = await readDicomMeta(f);
    if (m.ok) metaList.push(m);
  }

  // Group by seriesUID
  const seriesByUid = new Map();
  for (const m of metaList) {
    const uid = m.seriesUID || `none-${m.modality}`;
    if (!seriesByUid.has(uid)) {
      seriesByUid.set(uid, { modality: m.modality, frameOfRefUID: m.frameOfRefUID, slices: [] });
    }
    seriesByUid.get(uid).slices.push(m);
  }
  state.seriesByUid = seriesByUid;
  state.phiFindings = classifyPhi(metaList);
  showPhiWarn(state.phiFindings);

  // Populate series role selects
  const baseSel = document.getElementById('voxelBaseSelect');
  const ovlSel = document.getElementById('voxelOvlSelect');
  baseSel.innerHTML = ''; ovlSel.innerHTML = '';
  let firstCT = null, firstFunc = null;
  let idx = 1;
  for (const [uid, info] of seriesByUid) {
    const label = `${info.modality} (${info.slices.length}슬라이스) — ${uid.slice(-8)}`;
    info.label = label;
    info.idx = idx++;
    const opt1 = document.createElement('option');
    opt1.value = uid; opt1.textContent = label;
    baseSel.appendChild(opt1);
    const opt2 = document.createElement('option');
    opt2.value = uid; opt2.textContent = label;
    ovlSel.appendChild(opt2);
    if (!firstCT && (info.modality === 'CT' || info.modality === 'MR')) firstCT = uid;
    if (!firstFunc && (info.modality === 'NM' || info.modality === 'PT')) firstFunc = uid;
  }
  if (firstCT) baseSel.value = firstCT;
  if (firstFunc) ovlSel.value = firstFunc;

  setText('voxelSeriesInfo', `${seriesByUid.size}개 시리즈 (${files.length}장)`);
  state.loaded = true;
}

async function applyRoles() {
  const baseUid = document.getElementById('voxelBaseSelect').value;
  const ovlUid = document.getElementById('voxelOvlSelect').value;
  if (!baseUid) return;
  setText('voxelSeriesInfo', '볼륨 빌드 중...');

  const baseInfo = state.seriesByUid.get(baseUid);
  state.baseUid = baseUid;
  state.baseVolume = await buildVolumeFromSeries(baseInfo.slices.map(s => ({ els: s.els })));

  if (ovlUid && ovlUid !== baseUid) {
    const ovlInfo = state.seriesByUid.get(ovlUid);
    state.ovlUid = ovlUid;
    state.ovlVolume = await buildVolumeFromSeries(ovlInfo.slices.map(s => ({ els: s.els })));
  } else {
    state.ovlVolume = null;
    state.ovlUid = null;
  }

  // Auto-detect hardware-fused
  const fusedHint = document.getElementById('voxelFusedHint');
  state.registration = null;
  state.resampledOvl = null;
  if (state.baseVolume && state.ovlVolume && isHardwareFused(state.baseVolume, state.ovlVolume)) {
    state.registration = {
      kind: 'identity',
      transform4x4: identityTransform4(),
      residual_rms_mm: 0,
    };
    fusedHint.style.display = '';
    fusedHint.textContent = '✓ Hardware-fused 감지 — 정합 불필요 (identity transform). FrameOfReferenceUID 일치';
    state.resampledOvl = resampleOverlay(state.baseVolume, state.ovlVolume,
      state.registration.transform4x4);
  } else if (state.baseVolume && state.ovlVolume) {
    fusedHint.style.display = '';
    fusedHint.textContent = '⚠ 별도 좌표계 — landmark registration 필요';
  } else {
    fusedHint.style.display = 'none';
  }

  // Auto window/level for base
  if (state.baseVolume) {
    const m = state.baseVolume.modality;
    if (m === 'CT') {
      state.windowCenter = 40; state.windowWidth = 400;
    } else {
      const [mn, mx] = state.baseVolume.range;
      state.windowCenter = (mn + mx) / 2;
      state.windowWidth = Math.max(1, mx - mn);
    }
    document.getElementById('voxelWLcenter').value = state.windowCenter;
    document.getElementById('voxelWLwidth').value = state.windowWidth;
  }

  // Auto overlay range
  if (state.ovlVolume) {
    const [mn, mx] = state.ovlVolume.range;
    state.ovlCenter = mn + (mx - mn) * 0.05; // skip the 5% noise floor
    state.ovlWidth = Math.max(1, mx - state.ovlCenter);
  }

  // Initialize cross-hair cursors at center
  if (state.baseVolume) {
    const [W, H, D] = state.baseVolume.dims;
    state.cursorBase = { i: W >> 1, j: H >> 1, k: D >> 1 };
  }
  if (state.ovlVolume) {
    const [W, H, D] = state.ovlVolume.dims;
    state.cursorOvl = { i: W >> 1, j: H >> 1, k: D >> 1 };
  }
  setText('voxelSeriesInfo',
    `Base: ${state.baseVolume?.modality} ${state.baseVolume?.dims.join('×')}` +
    (state.ovlVolume ? ` · Overlay: ${state.ovlVolume.modality} ${state.ovlVolume.dims.join('×')}` : ''));
  redraw();
}

// =====================================================================
// Redraw loop — multi-viewport (M1.4)
// =====================================================================
let _colormapName = 'hot';
let _colormapLut = buildColormap('hot');

const VIEWPORTS = [
  { axis: 'axial',    base: 'vpAxialBase', ovl: 'vpAxialOvl', cross: 'vpAxialCross', sliceIdx: (c) => c.k },
  { axis: 'sagittal', base: 'vpSagBase',   ovl: 'vpSagOvl',   cross: 'vpSagCross',   sliceIdx: (c) => c.i },
  { axis: 'coronal',  base: 'vpCorBase',   ovl: 'vpCorOvl',   cross: 'vpCorCross',   sliceIdx: (c) => c.j },
];

function activeVolume() {
  return state.viewMode === 'ovl' ? state.ovlVolume : state.baseVolume;
}
function activeCursor() {
  return state.viewMode === 'ovl' ? state.cursorOvl : state.cursorBase;
}

function redraw() {
  const vol = activeVolume();
  if (!vol) return;
  const cursor = activeCursor();

  if (state.colormap !== _colormapName) {
    _colormapName = state.colormap;
    _colormapLut = buildColormap(state.colormap);
  }

  // Overlay only when in 'base' viewMode and resampled overlay aligned to base
  const overlayVol = (state.viewMode === 'base' && state.resampledOvl
                      && state.resampledOvl.dims.join(',') === state.baseVolume.dims.join(','))
                     ? state.resampledOvl : null;

  for (const vp of VIEWPORTS) {
    const baseCv = document.getElementById(vp.base);
    const ovlCv = document.getElementById(vp.ovl);
    const crCv = document.getElementById(vp.cross);
    if (!baseCv || !ovlCv || !crCv) continue;
    const idx = clampSlice(vp.sliceIdx(cursor), vp.axis, vol);
    renderBaseToCanvas(baseCv, vol, vp.axis, idx, state.windowCenter, state.windowWidth);
    if (overlayVol) {
      renderOvlToCanvas(ovlCv, overlayVol, state.baseVolume, vp.axis, idx,
        state.ovlCenter, state.ovlWidth, state.opacity, _colormapLut);
    } else {
      const ctx = ovlCv.getContext('2d');
      ctx.clearRect(0, 0, ovlCv.width, ovlCv.height);
    }
    renderCrossToCanvas(crCv, vol, vp.axis, cursor);
    drawLandmarkMarkersOnViewport(crCv, vp.axis, idx, cursor, vol);
  }

  // Slider values
  const dims = vol.dims;
  setText('iVal', `${cursor.i + 1}/${dims[0]}`);
  setText('jVal', `${cursor.j + 1}/${dims[1]}`);
  setText('kVal', `${cursor.k + 1}/${dims[2]}`);
  const sI = document.getElementById('sliceI'), sJ = document.getElementById('sliceJ'), sK = document.getElementById('sliceK');
  if (sI && +sI.max !== dims[0] - 1) sI.max = dims[0] - 1;
  if (sJ && +sJ.max !== dims[1] - 1) sJ.max = dims[1] - 1;
  if (sK && +sK.max !== dims[2] - 1) sK.max = dims[2] - 1;
  if (sI) sI.value = cursor.i;
  if (sJ) sJ.value = cursor.j;
  if (sK) sK.value = cursor.k;
}

function clampSlice(idx, axis, vol) {
  const [W, H, D] = vol.dims;
  let max;
  if (axis === 'axial') max = D - 1;
  else if (axis === 'sagittal') max = W - 1;
  else max = H - 1;
  return Math.max(0, Math.min(max, idx));
}

// =====================================================================
// Landmark markers per viewport
// =====================================================================
function drawLandmarkMarkersOnViewport(crCanvas, axis, sliceIdx, cursor, vol) {
  if (!crCanvas) return;
  const ctx = crCanvas.getContext('2d');
  const sliceFor = (axisN, ijk) => {
    if (axisN === 'axial') return ijk[2];
    if (axisN === 'sagittal') return ijk[0];
    return ijk[1];
  };
  const drawDot = (canvasX, canvasY, sliceDiff, color, label) => {
    const r = sliceDiff === 0 ? 5 : 3;
    ctx.beginPath();
    ctx.arc(canvasX, canvasY, r, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.globalAlpha = sliceDiff === 0 ? 1 : 0.35;
    ctx.fill();
    if (sliceDiff === 0 && label) {
      ctx.fillStyle = color;
      ctx.font = 'bold 11px monospace';
      ctx.globalAlpha = 1;
      ctx.fillText(label, canvasX + 6, canvasY - 6);
    }
    ctx.globalAlpha = 1;
  };
  state.landmarks.forEach((lm, idx) => {
    // Base landmarks display when viewMode === 'base'
    if (state.viewMode === 'base' && lm.baseVoxel) {
      const ijk = lm.baseVoxel;
      const cx = ijkToCanvas(axis, ...ijk);
      drawDot(cx[0], cx[1], sliceFor(axis, ijk) - sliceIdx, '#00ffff', `B${idx+1}`);
    }
    // Overlay landmarks display when viewMode === 'ovl'
    if (state.viewMode === 'ovl' && lm.ovlVoxel) {
      const ijk = lm.ovlVoxel;
      const cx = ijkToCanvas(axis, ...ijk);
      drawDot(cx[0], cx[1], sliceFor(axis, ijk) - sliceIdx, '#ff66ff', `O${idx+1}`);
    }
  });
}

// =====================================================================
// Click handlers — per viewport
// =====================================================================
function setupViewportInteraction() {
  for (const vp of VIEWPORTS) {
    const wrap = document.getElementById(vp.cross)?.parentElement;
    if (!wrap) continue;
    wrap.addEventListener('click', (e) => onViewportClick(e, vp));
    wrap.addEventListener('wheel', (e) => onViewportWheel(e, vp), { passive: false });
  }
}

function onViewportClick(e, vp) {
  const vol = activeVolume();
  if (!vol) return;
  const baseCv = document.getElementById(vp.base);
  if (!baseCv) return;
  const rect = baseCv.getBoundingClientRect();
  const sx = baseCv.width / rect.width;
  const sy = baseCv.height / rect.height;
  const cx = Math.max(0, Math.min(baseCv.width - 1, Math.round((e.clientX - rect.left) * sx)));
  const cy = Math.max(0, Math.min(baseCv.height - 1, Math.round((e.clientY - rect.top) * sy)));
  const cursor = activeCursor();
  const sliceIdx = vp.sliceIdx(cursor);
  const ijk = canvasToIjk(vp.axis, sliceIdx, cx, cy);
  if (state.landmarkMode) {
    addLandmarkClick(state.landmarkTarget, ijk);
  } else {
    cursor.i = ijk[0]; cursor.j = ijk[1]; cursor.k = ijk[2];
    redraw();
  }
}

function onViewportWheel(e, vp) {
  const vol = activeVolume();
  if (!vol) return;
  e.preventDefault();
  const dir = Math.sign(e.deltaY);
  const cursor = activeCursor();
  const [W, H, D] = vol.dims;
  if (vp.axis === 'axial')         cursor.k = Math.max(0, Math.min(D-1, cursor.k + dir));
  else if (vp.axis === 'sagittal') cursor.i = Math.max(0, Math.min(W-1, cursor.i + dir));
  else                             cursor.j = Math.max(0, Math.min(H-1, cursor.j + dir));
  redraw();
}

function addLandmarkClick(target, voxel) {
  let slot = state.landmarks.find(lm =>
    (target === 'base' && !lm.baseVoxel) || (target === 'ovl' && !lm.ovlVoxel));
  if (!slot) {
    slot = { baseVoxel: null, ovlVoxel: null, label: '' };
    state.landmarks.push(slot);
  }
  if (target === 'base') slot.baseVoxel = voxel;
  else slot.ovlVoxel = voxel;
  refreshLandmarkList();
  redraw();
}

function clearLandmarks() {
  state.landmarks = [];
  state.registration = null;
  state.resampledOvl = null;
  refreshLandmarkList();
  setText('voxelRegStatus', '');
  document.getElementById('voxelFusedHint').style.display = 'none';
  redraw();
}

function refreshLandmarkList() {
  const el = document.getElementById('voxelLandmarkList');
  if (!el) return;
  if (!state.landmarks.length) {
    el.textContent = '클릭하여 landmark 추가하세요';
    return;
  }
  const lines = state.landmarks.map((lm, i) => {
    const b = lm.baseVoxel ? `B(${lm.baseVoxel[0]},${lm.baseVoxel[1]},${lm.baseVoxel[2]})` : 'B(--)';
    const o = lm.ovlVoxel ? `O(${lm.ovlVoxel[0]},${lm.ovlVoxel[1]},${lm.ovlVoxel[2]})` : 'O(--)';
    return `${i+1}. ${b}  ${o}`;
  });
  el.innerHTML = lines.join('<br>');
}

function computeRegistration() {
  if (!state.baseVolume || !state.ovlVolume) {
    setText('voxelRegStatus', '⚠ Base + Overlay 두 시리즈 모두 로드해야 합니다');
    return;
  }
  // Collect complete landmark pairs (both base and ovl clicked)
  const pairs = state.landmarks.filter(lm => lm.baseVoxel && lm.ovlVoxel);
  if (pairs.length < 3) {
    setText('voxelRegStatus', `⚠ 3쌍 이상의 landmark 필요 (현재 ${pairs.length}쌍)`);
    return;
  }
  const src = pairs.map(lm => ijkToWorldMm(state.ovlVolume, ...lm.ovlVoxel));
  const tgt = pairs.map(lm => ijkToWorldMm(state.baseVolume, ...lm.baseVoxel));
  const mode = document.getElementById('voxelRegMode').value;
  let reg;
  try {
    reg = window.VoxelCore.kabsch(src, tgt, mode);
  } catch (e) {
    setText('voxelRegStatus', `⚠ Registration 실패: ${e.message}`);
    return;
  }
  state.registration = {
    kind: mode,
    transform4x4: reg.transform4x4,
    residual_rms_mm: reg.residual_rms_mm,
    R: reg.R, t: reg.t, scale: reg.scale,
    landmark_count: pairs.length,
  };
  // Resample overlay
  state.resampledOvl = resampleOverlay(state.baseVolume, state.ovlVolume,
    state.registration.transform4x4);
  // Status
  const rms = state.registration.residual_rms_mm.toFixed(2);
  let color = '#9be59b';
  if (state.registration.residual_rms_mm > 10) color = '#ff6b6b';
  else if (state.registration.residual_rms_mm > 5) color = '#ffd24a';
  const el = document.getElementById('voxelRegStatus');
  if (el) {
    el.innerHTML = `Registration: ${mode}, ${pairs.length} pairs, ` +
      `<span style="color:${color};font-weight:700">residual RMS = ${rms} mm</span>` +
      (mode === 'similarity' ? ` · scale = ${reg.scale.toFixed(4)}` : '') +
      ` · overlay 재샘플링 완료`;
  }
  redraw();
}

// =====================================================================
// Reset
// =====================================================================
function resetViewer() {
  state.loaded = false;
  state.seriesByUid = new Map();
  state.baseVolume = null;
  state.ovlVolume = null;
  state.resampledOvl = null;
  state.registration = null;
  state.landmarks = [];
  state.phiFindings = [];
  state.cursorBase = { i: 0, j: 0, k: 0 };
  state.cursorOvl = { i: 0, j: 0, k: 0 };
  state.viewMode = 'base';
  setHidden('voxelOnboarding', false);
  setHidden('voxelViewerWrap', true);
  setText('voxelSeriesInfo', '-');
  showPhiWarn([]);
  refreshLandmarkList();
}

// =====================================================================
// Small helpers
// =====================================================================
function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }
function setHidden(id, hidden) { const el = document.getElementById(id); if (el) el.style.display = hidden ? 'none' : ''; }

// =====================================================================
// Sample phantom loader
// =====================================================================
const SAMPLE_PHANTOMS = {
  hardware_fused: {
    label: 'SPECT/CT 융합',
    base: 'reference/tests/sample_dicom/hardware_fused',
    series: [
      { dir: 'CT', count: 60 },
      { dir: 'SPECT', count: 30 },
    ],
  },
  separate: {
    label: '진단 CT + SPECT 별도',
    base: 'reference/tests/sample_dicom/separate',
    series: [
      { dir: 'DiagnosticCT', count: 100 },
      { dir: 'SPECT', count: 30 },
    ],
  },
};

async function loadSamplePhantom(key) {
  const cfg = SAMPLE_PHANTOMS[key];
  if (!cfg) return;
  const progress = document.getElementById('voxelSampleProgress');
  const setProgress = (msg) => { if (progress) progress.textContent = msg; };

  const urls = [];
  for (const s of cfg.series) {
    for (let i = 0; i < s.count; i++) {
      const idx = String(i).padStart(3, '0');
      const path = `${cfg.base}/${s.dir}/slice_${idx}.dcm`;
      urls.push({ path, name: `${s.dir}_slice_${idx}.dcm` });
    }
  }

  setProgress(`${cfg.label} 다운로드 중... 0/${urls.length}`);
  const files = [];
  let done = 0;
  const concurrency = 8;
  let nextIdx = 0;
  let aborted = false;
  async function worker() {
    while (!aborted) {
      const i = nextIdx++;
      if (i >= urls.length) return;
      const u = urls[i];
      try {
        const res = await fetch(u.path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        files.push(new File([buf], u.name, { type: 'application/dicom' }));
      } catch (err) {
        aborted = true;
        setProgress(`다운로드 실패: ${u.path} (${err.message})`);
        throw err;
      }
      done++;
      if (done % 5 === 0 || done === urls.length) {
        setProgress(`${cfg.label} 다운로드 중... ${done}/${urls.length}`);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } catch {
    return;
  }
  setProgress(`${cfg.label} 로드 완료 (${files.length} files) — 분석 시작`);
  await handleFiles(files);
  setProgress('');
}

// =====================================================================
// UI wiring
// =====================================================================
function init() {
  const dropZone = document.getElementById('voxelDropZone');
  if (!dropZone) return;
  const fileInput = document.getElementById('voxelFileInput');
  document.getElementById('voxelLoadBtn')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => handleFiles(fileInput.files));

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const items = e.dataTransfer.items;
    const files = [];
    if (items && items.length && items[0].webkitGetAsEntry) {
      const promises = [];
      for (const it of items) {
        const entry = it.webkitGetAsEntry();
        if (entry) promises.push(traverseEntry(entry, files));
      }
      await Promise.all(promises);
    } else {
      Array.from(e.dataTransfer.files).forEach(f => files.push(f));
    }
    handleFiles(files);
  });

  document.getElementById('voxelSampleHWBtn')?.addEventListener('click', () => loadSamplePhantom('hardware_fused'));
  document.getElementById('voxelSampleSepBtn')?.addEventListener('click', () => loadSamplePhantom('separate'));

  document.getElementById('voxelResetBtn')?.addEventListener('click', resetViewer);
  document.getElementById('voxelApplyRoles')?.addEventListener('click', applyRoles);

  // Sliders / inputs
  const op = document.getElementById('voxelOpacity');
  op?.addEventListener('input', () => {
    state.opacity = parseInt(op.value, 10) / 100;
    setText('voxelOpacityVal', `${op.value}%`);
    redraw();
  });
  document.getElementById('voxelColormap')?.addEventListener('change', (e) => {
    state.colormap = e.target.value;
    redraw();
  });
  document.getElementById('voxelWLcenter')?.addEventListener('input', (e) => {
    state.windowCenter = parseFloat(e.target.value);
    redraw();
  });
  document.getElementById('voxelWLwidth')?.addEventListener('input', (e) => {
    state.windowWidth = parseFloat(e.target.value);
    redraw();
  });
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      let c = 40, w = 400;
      if (p === 'liver') { c = 60; w = 150; }
      else if (p === 'lung') { c = -600; w = 1500; }
      state.windowCenter = c; state.windowWidth = w;
      document.getElementById('voxelWLcenter').value = c;
      document.getElementById('voxelWLwidth').value = w;
      redraw();
    });
  });

  // Per-axis sliders
  const sliceI = document.getElementById('sliceI');
  const sliceJ = document.getElementById('sliceJ');
  const sliceK = document.getElementById('sliceK');
  sliceI?.addEventListener('input', () => { activeCursor().i = parseInt(sliceI.value, 10); redraw(); });
  sliceJ?.addEventListener('input', () => { activeCursor().j = parseInt(sliceJ.value, 10); redraw(); });
  sliceK?.addEventListener('input', () => { activeCursor().k = parseInt(sliceK.value, 10); redraw(); });

  // Landmark mode + view-mode switching
  const btnLM = document.getElementById('voxelLandmarkMode');
  btnLM?.addEventListener('click', () => {
    state.landmarkMode = !state.landmarkMode;
    btnLM.textContent = `Landmark mode: ${state.landmarkMode ? 'ON' : 'OFF'}`;
    btnLM.style.background = state.landmarkMode ? '#3a7' : '';
  });
  document.getElementById('voxelLandmarkBase')?.addEventListener('click', () => {
    state.landmarkTarget = 'base';
    state.viewMode = 'base';
    document.getElementById('voxelLandmarkBase').style.background = '#36a';
    document.getElementById('voxelLandmarkOvl').style.background = '';
    redraw();
  });
  document.getElementById('voxelLandmarkOvl')?.addEventListener('click', () => {
    if (!state.ovlVolume) {
      setText('voxelRegStatus', '⚠ Overlay 시리즈가 로드되지 않았습니다');
      return;
    }
    state.landmarkTarget = 'ovl';
    state.viewMode = 'ovl';
    document.getElementById('voxelLandmarkOvl').style.background = '#36a';
    document.getElementById('voxelLandmarkBase').style.background = '';
    redraw();
  });
  document.getElementById('voxelLandmarkClear')?.addEventListener('click', clearLandmarks);
  document.getElementById('voxelComputeReg')?.addEventListener('click', computeRegistration);

  setupViewportInteraction();
  refreshLandmarkList();
}

function traverseEntry(entry, files) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(f => { files.push(f); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      reader.readEntries((entries) => {
        Promise.all(entries.map(e => traverseEntry(e, files))).then(resolve);
      });
    } else { resolve(); }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else { init(); }

// Expose for debugging
window._dosimetryVoxel = {
  state,
  redraw,
  reset: resetViewer,
  buildVolumeFromSeries,
  resampleOverlay,
  ijkToWorldMm,
  inverseAffine4,
};

})();
