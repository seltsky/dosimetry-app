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
  seriesByUid: new Map(),       // seriesUID → { modality, files, label }
  baseUid: null,                 // diagnostic base series uid
  ovlUid: null,                  // overlay series uid
  baseVolume: null,              // Volume {data, dims, spacing, ijkToRas, modality, range}
  ovlVolume: null,
  resampledOvl: null,            // overlay resampled to base grid
  baseSlice: 0,                  // current base k-index
  windowCenter: 40,
  windowWidth: 400,
  ovlCenter: null,               // auto-determined from data
  ovlWidth: null,
  opacity: 0.5,
  colormap: 'hot',
  landmarkMode: false,
  landmarkTarget: 'base',        // 'base' or 'ovl' — next click target
  landmarks: [],                 // [{srcMm, tgtMm, label, clicked: {base?, ovl?}}]
  pendingLandmark: null,         // { base?: voxel, ovl?: voxel, slice }
  registration: null,            // {R, t, scale, transform4x4, residual_rms_mm}
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
// Render a single axial slice of base volume (grayscale with windowing)
// =====================================================================
function renderBaseSlice(canvas, vol, k, center, width) {
  const ctx = canvas.getContext('2d');
  const [cols, rows] = vol.dims;
  if (canvas.width !== cols || canvas.height !== rows) {
    canvas.width = cols; canvas.height = rows;
  }
  const img = ctx.createImageData(cols, rows);
  const lo = center - width / 2;
  const hi = center + width / 2;
  const inv = 255 / Math.max(1e-6, hi - lo);
  const off = k * cols * rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = vol.data[off + y * cols + x];
      let g = (v - lo) * inv;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      const i4 = (y * cols + x) * 4;
      img.data[i4]   = g;
      img.data[i4+1] = g;
      img.data[i4+2] = g;
      img.data[i4+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderOverlaySlice(canvas, ovl, baseVol, k, center, width, opacity, lut) {
  const ctx = canvas.getContext('2d');
  const [cols, rows] = baseVol.dims;
  if (canvas.width !== cols || canvas.height !== rows) {
    canvas.width = cols; canvas.height = rows;
  }
  const img = ctx.createImageData(cols, rows);
  if (!ovl) {
    ctx.clearRect(0, 0, cols, rows);
    return;
  }
  const lo = center;
  const hi = Math.max(lo + 1e-6, lo + width);
  const off = k * cols * rows;
  const data = ovl.data;
  const alpha = Math.round(opacity * 255);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = data[off + y * cols + x];
      const i4 = (y * cols + x) * 4;
      if (v <= lo) {
        img.data[i4+3] = 0;
        continue;
      }
      let t = (v - lo) / (hi - lo);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const idx = Math.round(t * 255) * 3;
      img.data[i4]   = lut[idx];
      img.data[i4+1] = lut[idx+1];
      img.data[i4+2] = lut[idx+2];
      img.data[i4+3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
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

  // Set slice slider
  if (state.baseVolume) {
    const slider = document.getElementById('voxelSlice');
    slider.max = state.baseVolume.dims[2] - 1;
    state.baseSlice = Math.floor(state.baseVolume.dims[2] / 2);
    slider.value = state.baseSlice;
  }
  setText('voxelSeriesInfo',
    `Base: ${state.baseVolume?.modality} ${state.baseVolume?.dims.join('×')}` +
    (state.ovlVolume ? ` · Overlay: ${state.ovlVolume.modality} ${state.ovlVolume.dims.join('×')}` : ''));
  redraw();
}

// =====================================================================
// Redraw loop
// =====================================================================
let _colormapName = 'hot';
let _colormapLut = buildColormap('hot');

function redraw() {
  const canvas = document.getElementById('voxelCanvas');
  const ovlCanvas = document.getElementById('voxelOvlCanvas');
  if (!state.baseVolume || !canvas || !ovlCanvas) return;
  renderBaseSlice(canvas, state.baseVolume, state.baseSlice,
    state.windowCenter, state.windowWidth);

  if (state.colormap !== _colormapName) {
    _colormapName = state.colormap;
    _colormapLut = buildColormap(state.colormap);
  }
  const overlayVol = state.resampledOvl || (
    state.registration ? null : state.ovlVolume   // before registration: show on base grid only if dims match
  );
  if (overlayVol && overlayVol.dims.join(',') === state.baseVolume.dims.join(',')) {
    renderOverlaySlice(ovlCanvas, overlayVol, state.baseVolume, state.baseSlice,
      state.ovlCenter, state.ovlWidth, state.opacity, _colormapLut);
  } else {
    const ctx = ovlCanvas.getContext('2d');
    ctx.clearRect(0, 0, ovlCanvas.width, ovlCanvas.height);
  }
  drawLandmarkMarkers();
  setText('voxelSliceVal', `${state.baseSlice + 1}/${state.baseVolume.dims[2]}`);
}

// =====================================================================
// Landmark markers overlay
// =====================================================================
function drawLandmarkMarkers() {
  // Draw landmark dots on the BASE canvas overlay (we re-use ovl canvas after
  // its content is already painted, layering on top via 2D ctx).
  const ovlCanvas = document.getElementById('voxelOvlCanvas');
  if (!ovlCanvas || !state.baseVolume) return;
  const ctx = ovlCanvas.getContext('2d');
  // We assume coordinates are in base voxel grid. The current displayed slice
  // is state.baseSlice. Markers within ±1 slice highlight; others dim.
  const k0 = state.baseSlice;
  const drawDot = (i, j, kdiff, color) => {
    const r = kdiff === 0 ? 5 : 3;
    ctx.beginPath();
    ctx.arc(i, j, r, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.globalAlpha = kdiff === 0 ? 1 : 0.4;
    ctx.fill();
    ctx.globalAlpha = 1;
  };
  // Pending click markers
  state.landmarks.forEach((lm, idx) => {
    if (lm.baseVoxel) {
      const kd = lm.baseVoxel[2] - k0;
      drawDot(lm.baseVoxel[0], lm.baseVoxel[1], kd, '#00ffff');
      if (kd === 0) {
        ctx.fillStyle = '#00ffff';
        ctx.font = 'bold 11px monospace';
        ctx.fillText(`B${idx+1}`, lm.baseVoxel[0]+6, lm.baseVoxel[1]-6);
      }
    }
    if (lm.ovlVoxel && state.ovlVolume) {
      // We don't have a separate ovl viewport, so we project ovl voxel→world→
      // base voxel for display ONLY if registration exists. Otherwise skip.
      if (state.registration) {
        const ovlWorld = ijkToWorldMm(state.ovlVolume, ...lm.ovlVoxel);
        const baseWorld = affineMul(state.registration.transform4x4, ovlWorld);
        const rasToIjkBase = inverseAffine4(state.baseVolume.ijkToRas);
        if (rasToIjkBase) {
          const bv = affineMul(rasToIjkBase, baseWorld);
          const kd = Math.round(bv[2]) - k0;
          drawDot(Math.round(bv[0]), Math.round(bv[1]), kd, '#ff66ff');
        }
      }
    }
  });
}

// =====================================================================
// Click handler — convert canvas click → base voxel
// =====================================================================
function setupCanvasClick() {
  const canvas = document.getElementById('voxelCanvas');
  if (!canvas) return;
  canvas.addEventListener('click', (e) => {
    if (!state.landmarkMode || !state.baseVolume) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const i = Math.round((e.clientX - rect.left) * sx);
    const j = Math.round((e.clientY - rect.top) * sy);
    const k = state.baseSlice;
    addLandmarkClick(state.landmarkTarget, [i, j, k]);
  });
}

function addLandmarkClick(target, voxel) {
  // Find an open landmark slot for this target
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

  const sliceSlider = document.getElementById('voxelSlice');
  sliceSlider?.addEventListener('input', () => {
    state.baseSlice = parseInt(sliceSlider.value, 10);
    redraw();
  });

  // Landmark mode
  const btnLM = document.getElementById('voxelLandmarkMode');
  btnLM?.addEventListener('click', () => {
    state.landmarkMode = !state.landmarkMode;
    btnLM.textContent = `Landmark mode: ${state.landmarkMode ? 'ON' : 'OFF'}`;
    btnLM.style.background = state.landmarkMode ? '#3a7' : '';
  });
  document.getElementById('voxelLandmarkBase')?.addEventListener('click', () => {
    state.landmarkTarget = 'base';
    document.getElementById('voxelLandmarkBase').style.background = '#36a';
    document.getElementById('voxelLandmarkOvl').style.background = '';
  });
  document.getElementById('voxelLandmarkOvl')?.addEventListener('click', () => {
    state.landmarkTarget = 'ovl';
    document.getElementById('voxelLandmarkOvl').style.background = '#36a';
    document.getElementById('voxelLandmarkBase').style.background = '';
  });
  document.getElementById('voxelLandmarkClear')?.addEventListener('click', clearLandmarks);
  document.getElementById('voxelComputeReg')?.addEventListener('click', computeRegistration);

  setupCanvasClick();
  refreshLandmarkList();

  // Mouse wheel: scroll slice
  const canvas = document.getElementById('voxelCanvas');
  canvas?.addEventListener('wheel', (e) => {
    if (!state.baseVolume) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY);
    const max = state.baseVolume.dims[2] - 1;
    state.baseSlice = Math.max(0, Math.min(max, state.baseSlice + dir));
    document.getElementById('voxelSlice').value = state.baseSlice;
    redraw();
  }, { passive: false });
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
