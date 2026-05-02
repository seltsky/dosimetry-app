/* ========= SPEC-DOSI-REPORT-001 — Clinical Report Generator =========
   Pure-function core (lib/report) + UI shell.
   References: ~/projects/moai-trial-uae/.moai/specs/SPEC-DOSI-REPORT-001/
   ===================================================================== */
(function() {
'use strict';

const LANG_KEY = 'dosimetry_report_lang';

let REFS = { thresholds: [], cases: [] };
fetch('references.json?v=' + Date.now())
  .then(r => r.json())
  .then(d => { REFS = d; })
  .catch(() => { /* E-9 fallback handled at render time */ });

// ====== TYPES (JSDoc) ===============================================
/**
 * @typedef {"ko"|"en"|"mixed"} ReportLang
 * @typedef {"partition"|"mird"|"simplicity"} ReportSource
 *
 * @typedef {Object} DosimetryReportInput
 * @property {ReportSource} source
 * @property {string} microsphere - "resin" | "glass"
 * @property {string} scenario - "segmentectomy" | "lobectomy" | "largeHCC" | "unilobar" | "bilobar" | "pvt"
 * @property {number|null} prescribedActivityGBq
 * @property {number|null} tumorDoseGy
 * @property {number|null} ntadGy
 * @property {number|null} wlNtadGy
 * @property {number|null} lungDoseGy
 * @property {number|null} LSF
 * @property {number|null} TN
 * @property {string} patientSex - "M" | "F" | "" (default conservative)
 * @property {string} intent
 * @property {string} bclcStage
 * @property {string} childPugh
 * @property {string} caseId
 * @property {string} dx - 진단명
 * @property {Object} freeText
 * @property {string} reportDate - YYYY-MM-DD
 */

// ====== CITATION HELPERS ============================================

const SCENARIO_LABEL_EN = {
  segmentectomy: 'radiation segmentectomy (RS)',
  lobectomy: 'radiation lobectomy',
  largeHCC: 'large HCC (multi-compartment)',
  unilobar: 'multifocal unilobar',
  bilobar: 'multifocal bilobar',
  pvt: 'macrovascular invasion / portal vein tumor thrombus',
};
const SCENARIO_LABEL_KO = {
  segmentectomy: '방사선 분절절제(RS)',
  lobectomy: '방사선 엽절제(lobectomy)',
  largeHCC: '대형 HCC (다구획 모델)',
  unilobar: '다발성 한쪽엽',
  bilobar: '다발성 양쪽엽',
  pvt: 'PVT/대혈관 침범',
};
const MICRO_LABEL = { resin: 'resin (SIR-Spheres)', glass: 'glass (TheraSphere)' };

const KOREAN_PERSPECTIVE_STAGE = {
  segmentectomy: { stage: 3, label_en: 'dose optimization (segmentectomy)', label_ko: '용량 최적화 (분절절제)' },
  lobectomy:     { stage: 4, label_en: 'normal liver preservation (radiation major hepatectomy)', label_ko: '정상간 보존 (radiation major hepatectomy)' },
  largeHCC:      { stage: 3, label_en: 'dose optimization (multi-compartment)', label_ko: '용량 최적화 (다구획 모델)' },
  unilobar:      { stage: 4, label_en: 'normal liver preservation (sequential, FLR-aware)', label_ko: '정상간 보존 (순차 시술, FLR 고려)' },
  bilobar:       { stage: 4, label_en: 'normal liver preservation (sequential, FLR-aware)', label_ko: '정상간 보존 (순차 시술, FLR 고려)' },
  pvt:           { stage: 3, label_en: 'dose optimization (palliative-intent)', label_ko: '용량 최적화 (palliative)' },
};

/**
 * Returns the references entry by 1-based row index in references.json.thresholds[].
 */
function refByIndex(idx) {
  return REFS.thresholds[idx - 1] || null;
}

/**
 * Format short citation: "(Author Year)".
 */
function shortCite(entry) {
  if (!entry) return '';
  const author = (entry['First Author'] || '').replace(/\(.*\)/, '').trim();
  const year = entry.Year || '';
  return `(${author}${year ? ' ' + year : ''})`;
}

/**
 * Format long reference line: "[N] Author, Year, Journal — PMID NNN"
 */
function longRef(entry, num) {
  if (!entry) return '';
  const author = entry['First Author'] || '';
  const year = entry.Year || '';
  const journal = entry.Journal || '';
  const pmid = entry.PMID ? `PMID ${entry.PMID}` : 'no PMID';
  return `[${num}] ${author}, ${year}, ${journal} — ${pmid}`;
}

/**
 * Find threshold entries whose tumorRef / ntadRef / lungRef hint matches.
 * In references.json the canonical short labels are partial substrings of the title or author.
 */
function findRefByHint(hint) {
  if (!hint || !REFS.thresholds) return null;
  const h = hint.toLowerCase();
  return REFS.thresholds.find(r => {
    const blob = ((r['First Author'] || '') + ' ' + (r.Title || '')).toLowerCase();
    return blob.includes(h);
  });
}

/**
 * Find lung complication cases matching microsphere.
 */
function findLungCases(microsphere) {
  if (!REFS.cases) return [];
  const m = microsphere === 'resin' ? 'Resin' : 'Glass';
  return REFS.cases.filter(c => {
    const okMicro = !c.Microsphere || c.Microsphere === m || c.Microsphere === 'Both' || c.Microsphere === '?' || c.Microsphere === 'N/A';
    const blob = ((c.Complication || '') + ' ' + (c.Title || '')).toLowerCase();
    return okMicro && (blob.includes('lung') || blob.includes('pneumon') || blob.includes('폐'));
  });
}

// ====== TEMPLATES (5 sections × 3 langs) =============================

function fmt(n, dp = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Number(n).toFixed(dp);
}

// ----- Table helpers ------------------------------------------------
function mdTable(headers, rows) {
  const out = [];
  out.push('| ' + headers.join(' | ') + ' |');
  out.push('|' + headers.map(() => ' --- ').join('|') + '|');
  rows.forEach(r => out.push('| ' + r.join(' | ') + ' |'));
  return out.join('\n');
}

// ----- # CASE INFO --------------------------------------------------
function tCaseInfo(input, lang, citations) {
  const sc = SCENARIO_LABEL_EN[input.scenario] || input.scenario;
  const scKo = SCENARIO_LABEL_KO[input.scenario] || input.scenario;
  const stage = KOREAN_PERSPECTIVE_STAGE[input.scenario];
  const microLbl = input.microsphere === 'resin' ? 'Resin (SIR-Spheres)' : 'Glass (TheraSphere)';
  const intentKo = { curative: '근치', palliative: '완화', bridging: '이식 가교' }[input.intent || ''] || input.intent || '';

  if (stage) citations.add(17);

  const isEn = lang === 'en';
  const isKo = lang === 'ko';
  const fields = isEn ? ['Field', 'Value'] : ['항목', '값'];
  const rows = [];
  rows.push(['Diagnosis', input.dx || 'HCC']);
  if (input.bclcStage) rows.push(['BCLC', input.bclcStage]);
  if (input.childPugh) rows.push(['Child-Pugh', input.childPugh]);
  if (input.intent) rows.push(['Intent', isEn ? input.intent : intentKo]);
  rows.push(['Microsphere', microLbl]);
  rows.push(['Scenario', isKo ? scKo : sc]);
  if (stage) {
    const stageLbl = isEn ? stage.label_en : stage.label_ko;
    rows.push(['Workflow', `Stage ${stage.stage} · ${stageLbl} [17]`]);
  }

  return '# CASE INFO\n' + mdTable(fields, rows);
}

// ----- # PROCEDURE --------------------------------------------------
function tProcedure(input, lang) {
  const TN = fmt(input.TN);
  const LSF = fmt(input.LSF);
  const A = fmt(input.prescribedActivityGBq, 2);
  const isEn = lang === 'en';
  const headers = isEn ? ['Parameter', 'Value'] : ['항목', '값'];
  const rows = [];
  if (TN) rows.push(['T/N ratio', TN]);
  if (LSF) rows.push(['Lung shunt fraction', `${LSF} %`]);
  if (A) rows.push([isEn ? 'Prescribed activity' : 'Prescribed activity', `${A} GBq`]);
  if (input.source === 'mird') rows.push([isEn ? 'Model' : 'Model', 'MIRD single-compartment']);
  if (input.source === 'simplicity') rows.push([isEn ? 'Model' : 'Model', 'Simplicity (post-hoc)']);
  if (rows.length === 0) return '';
  return '# PROCEDURE\n' + mdTable(headers, rows);
}

// ----- # DOSIMETRY (merged with safety) -----------------------------
function tDosimetry(input, lang, citations) {
  const isEn = lang === 'en';
  const headers = isEn
    ? ['Compartment', 'Dose', 'Threshold', 'Status']
    : ['항목', '용량', 'Threshold', '판정'];
  const rows = [];

  const td = input.tumorDoseGy;
  const ntad = input.ntadGy;
  const wl = input.wlNtadGy;
  const ld = input.lungDoseGy;
  const isResin = input.microsphere === 'resin';

  // Tumor row
  if (td != null) {
    let thresh = '', status = '⚪️';
    if (input.scenario === 'segmentectomy' && !isResin && td >= 400) {
      thresh = '≥400 Gy [4]'; status = '✅'; citations.add(4); citations.add(17);
    } else if (!isResin && td >= 205) {
      thresh = '≥205 Gy [3]'; status = '✅'; citations.add(3);
    } else if (!isResin) {
      thresh = '≥205 Gy [3]'; status = '⚠️'; citations.add(3);
    } else if (isResin && td >= 150) {
      thresh = '>150 Gy [1]'; status = '✅'; citations.add(1);
    } else if (isResin) {
      thresh = '>150 Gy [1]'; status = '⚠️'; citations.add(1);
    }
    rows.push([isEn ? 'Tumor' : '종양', `${fmt(td)} Gy`, thresh, status]);
  }

  // NTAD row
  if (ntad != null && ntad > 0) {
    const limit = isResin ? 70 : 120;
    const ok = ntad <= limit;
    citations.add(11);
    rows.push([isEn ? 'NTAD' : 'NTAD', `${fmt(ntad)} Gy`, `<${limit} Gy [11]`, ok ? '✅' : '⚠️']);
  }

  // WL NTAD row
  if (wl != null && wl > 0) {
    citations.add(6);
    const ok = wl <= 40;
    rows.push([isEn ? 'Whole-liver NTAD' : '전체간 NTAD', `${fmt(wl)} Gy`, '<40 Gy (TD50 52) [6]', ok ? '✅' : '⚠️']);
  }

  // Lung row
  if (ld != null && ld > 0) {
    const sex = input.patientSex;
    const conservative = !sex || sex === 'F' || sex === '기타' || sex === 'other';
    const limit = conservative ? 20 : 25;
    const ok = ld <= limit;
    citations.add(13); citations.add(17);
    const sexTag = conservative ? (isEn ? '(F-conservative)' : '(여성-보수적)') : (isEn ? '(M)' : '(남)');
    rows.push([
      isEn ? `Lung ${sexTag}` : `폐 ${sexTag}`,
      `${fmt(ld, 2)} Gy`,
      `<${limit} Gy [13][17]`,
      ok ? '✅' : '⚠️'
    ]);

    // Append cases below table when warning
    if (!ok) {
      const lungCases = findLungCases(input.microsphere).slice(0, 1);
      lungCases.forEach(c => {
        const auth = c['First Author'] || c.Author || 'Author';
        const cite = `${auth} ${c.Year || ''}${c.PMID ? ' · PMID ' + c.PMID : ''}`;
        rows.push([
          isEn ? '↳ Similar case' : '↳ 유사 사례',
          '',
          cite,
          (c.Complication || c.Title || '').substring(0, 60)
        ]);
      });
    }
  }

  if (rows.length === 0) return '';
  return '# DOSIMETRY\n' + mdTable(headers, rows);
}

// ----- # CITATIONS --------------------------------------------------
function tReferences(citations, lang) {
  const sorted = Array.from(citations).sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const lines = ['# CITATIONS'];
  sorted.forEach(idx => {
    const e = refByIndex(idx);
    if (!e) return;
    const author = (e['First Author'] || '').replace(/\(.*\)/, '').trim();
    const year = e.Year || '';
    const journal = e.Journal || '';
    const pmid = e.PMID ? ` · PMID ${e.PMID}` : '';
    lines.push(`[${idx}] ${author} ${year} · ${journal}${pmid}`);
  });
  return lines.join('\n');
}

// ====== BUILDER ======================================================

/**
 * Pure function: input + lang -> { text, citations[], wordCount, sections[] }
 * @param {DosimetryReportInput} input
 * @param {ReportLang} lang
 */
function generateClinicalReport(input, lang = 'mixed') {
  const citations = new Set();

  const refsLoaded = REFS && REFS.thresholds && REFS.thresholds.length > 0;

  // Header
  const headerLines = [];
  if (input.caseId) {
    headerLines.push(lang === 'en'
      ? `[CASE ${input.caseId}, generated ${input.reportDate}]`
      : `[CASE ${input.caseId}, ${input.reportDate} 작성]`);
  } else {
    headerLines.push(lang === 'en'
      ? `[Generated ${input.reportDate}]`
      : `[${input.reportDate} 작성]`);
  }

  // Evidence summary (U-12)
  let evidence = '';
  if (input.tumorDoseGy != null && input.tumorDoseGy > 0) {
    if (input.microsphere === 'glass' && input.tumorDoseGy >= 205) {
      evidence = lang === 'en'
        ? `Evidence summary: Tumor dose ${fmt(input.tumorDoseGy)} Gy meets DOSISPHERE-01 threshold (≥205 Gy).`
        : `요약: 종양 ${fmt(input.tumorDoseGy)} Gy로 DOSISPHERE-01 threshold (≥205 Gy) 충족.`;
    } else if (input.microsphere === 'resin' && input.tumorDoseGy >= 150) {
      evidence = lang === 'en'
        ? `Evidence summary: Tumor dose ${fmt(input.tumorDoseGy)} Gy meets resin effective threshold (>150 Gy).`
        : `요약: 종양 ${fmt(input.tumorDoseGy)} Gy로 Resin 유효 threshold (>150 Gy) 충족.`;
    } else {
      evidence = lang === 'en'
        ? `Evidence summary: Tumor dose ${fmt(input.tumorDoseGy)} Gy below recommended threshold.`
        : `요약: 종양 ${fmt(input.tumorDoseGy)} Gy, 권장 threshold 미달.`;
    }
  }

  const sections = [];
  sections.push(headerLines.join('\n') + (evidence ? '\n' + evidence : ''));
  sections.push(tCaseInfo(input, lang, citations));
  const proc = tProcedure(input, lang);
  if (proc) sections.push(proc);
  const dosi = tDosimetry(input, lang, citations);
  if (dosi) sections.push(dosi);

  if (!refsLoaded) {
    sections.push(lang === 'en'
      ? '# CITATIONS\n(References database failed to load — citations reflect computed values only.)'
      : '# CITATIONS\n(참고문헌 DB 로딩 실패 — 결과는 계산값만 반영.)');
  } else {
    const refs = tReferences(citations, lang);
    if (refs) sections.push(refs);
  }

  // PHI footer (always present)
  sections.push(lang === 'en'
    ? '---\n[PHI guard] Verify no patient identifiers before external transmission.'
    : '---\n[PHI 점검] 외부 시스템 전송 시 환자 식별정보 포함 여부를 반드시 확인하세요.');

  const text = sections.join('\n\n');
  return {
    text,
    citations: Array.from(citations).sort((a, b) => a - b).map(refByIndex).filter(Boolean),
    wordCount: text.length,
    sections: sections.length,
  };
}

// ====== UI SHELL =====================================================

function getLang() {
  return localStorage.getItem(LANG_KEY) || 'mixed';
}
function setLang(l) {
  localStorage.setItem(LANG_KEY, l);
}

/** Read patient + dosimetry inputs from a given tab. */
function readInputForSource(source) {
  const today = new Date().toISOString().slice(0, 10);
  const base = {
    source,
    reportDate: today,
    freeText: {},
  };

  if (source === 'partition') {
    const psafety = window._partitionSafety || {};
    const A = parseFloat(document.getElementById('p_prescribedA')?.value);
    return {
      ...base,
      microsphere: psafety.micro || (document.querySelector('.micro-btn.active[data-parent="partition"]')?.dataset?.micro) || 'resin',
      scenario: psafety.scenario || (document.getElementById('p_scenario')?.value) || 'segmentectomy',
      prescribedActivityGBq: !isNaN(A) && A > 0 ? A : null,
      tumorDoseGy: psafety.safetyTumor != null ? psafety.safetyTumor : null,
      ntadGy: psafety.safetyNtad != null ? psafety.safetyNtad : null,
      wlNtadGy: psafety.wlNtad != null ? psafety.wlNtad : null,
      lungDoseGy: psafety.safetyLung != null ? psafety.safetyLung : null,
      LSF: psafety.LSF != null ? psafety.LSF : (parseFloat(document.getElementById('p_lsf')?.value) || null),
      TN: parseFloat(document.getElementById('p_tn')?.value) || null,
      patientSex: document.getElementById('p_sex')?.value || '',
      intent: document.getElementById('p_intent')?.value || '',
      bclcStage: '',
      childPugh: document.getElementById('p_cps')?.value || '',
      caseId: '',
      dx: document.getElementById('p_dx')?.value || '',
    };
  }

  if (source === 'mird') {
    const Astr = (document.getElementById('m_activity')?.textContent || '').replace(/[^\d.]/g, '');
    const lungStr = (document.getElementById('m_lungDose')?.textContent || '').replace(/[^\d.]/g, '');
    return {
      ...base,
      microsphere: (document.querySelector('.micro-btn.active[data-parent="mird"]')?.dataset?.micro) || 'glass',
      scenario: document.getElementById('m_scenario')?.value || 'segmentectomy',
      prescribedActivityGBq: parseFloat(Astr) || null,
      tumorDoseGy: parseFloat(document.getElementById('m_desiredDose')?.value) || null,
      ntadGy: null,
      wlNtadGy: null,
      lungDoseGy: parseFloat(lungStr) || null,
      LSF: parseFloat(document.getElementById('m_lsf')?.value) || null,
      TN: null,
      patientSex: document.getElementById('m_sex')?.value || '',
      intent: document.getElementById('m_intent')?.value || '',
      bclcStage: '',
      childPugh: document.getElementById('m_cps')?.value || '',
      caseId: '',
      dx: document.getElementById('m_dx')?.value || '',
    };
  }

  // simplicity
  const td = parseFloat(document.getElementById('s_tumorDose')?.value);
  const ntad = parseFloat(document.getElementById('s_ntad')?.value);
  const wlNtad = parseFloat(document.getElementById('s_wlNtad')?.value);
  const ld = parseFloat(document.getElementById('s_lungDose')?.value);
  const A = parseFloat(document.getElementById('s_activity')?.value);
  const sScenario = document.querySelector('#tab-simplicity .scenario-tab.active')?.dataset?.scenario || 'segmentectomy';
  return {
    ...base,
    microsphere: (document.querySelector('.micro-btn.active[data-parent="simplicity"]')?.dataset?.micro) || 'resin',
    scenario: sScenario,
    prescribedActivityGBq: !isNaN(A) ? A : null,
    tumorDoseGy: !isNaN(td) ? td : null,
    ntadGy: !isNaN(ntad) ? ntad : null,
    wlNtadGy: !isNaN(wlNtad) ? wlNtad : null,
    lungDoseGy: !isNaN(ld) ? ld : null,
    LSF: null,
    TN: null,
    patientSex: '',
    intent: '',
    bclcStage: '',
    childPugh: '',
    caseId: '',
    dx: '',
  };
}

/** S-1: minimum field check. */
function checkMinFields(source, input) {
  const missing = [];
  if (!input.microsphere) missing.push('microsphere');
  if (!input.scenario) missing.push('scenario');
  if (source === 'partition') {
    if (input.prescribedActivityGBq == null && input.tumorDoseGy == null) missing.push('prescribed activity 또는 tumor dose');
  }
  if (source === 'mird') {
    if (input.tumorDoseGy == null) missing.push('desired dose');
    if (!input.prescribedActivityGBq) missing.push('activity (계산 미완료)');
  }
  if (source === 'simplicity') {
    if (input.tumorDoseGy == null) missing.push('tumor dose');
  }
  return missing;
}

/** Detect PHI patterns in free-text (best-effort warning). */
function looksLikePHI(s) {
  if (!s) return false;
  if (/\d{6}-?\d{7}/.test(s)) return true; // 주민번호
  if (/\b\d{8,}\b/.test(s)) return true;   // 차트번호스러운 긴 숫자
  if (/[가-힣]{2,4}\s*(님|환자|차트)/.test(s)) return true;
  return false;
}

function ensureModal() {
  let modal = document.getElementById('reportModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'reportModal';
  modal.className = 'report-modal';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="report-modal-backdrop"></div>
    <div class="report-modal-body">
      <div class="report-modal-head">
        <strong>임상 보고서</strong>
        <span class="report-lang-toggle">
          <button data-lang="ko">한글</button>
          <button data-lang="mixed">혼합</button>
          <button data-lang="en">English</button>
        </span>
        <span class="report-actions">
          <button id="reportCompactBtn" class="report-btn-secondary" style="display:none">압축</button>
          <button id="reportCopyBtn" class="report-btn-primary">복사</button>
          <button id="reportCloseBtn" class="report-btn-secondary">닫기</button>
        </span>
      </div>
      <div id="reportPhiWarn" class="report-phi-warn" style="display:none">⚠️ 환자 식별정보가 포함된 듯합니다. 외부 시스템 전송 전 점검하세요.</div>
      <div id="reportCopyConfirm" class="report-copy-confirm" style="display:none">복사됨</div>
      <pre id="reportContent" class="report-content"></pre>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('.report-modal-backdrop').addEventListener('click', () => closeModal());
  modal.querySelector('#reportCloseBtn').addEventListener('click', () => closeModal());

  modal.querySelectorAll('.report-lang-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      const l = btn.dataset.lang;
      setLang(l);
      reRender();
      updateLangButtons();
    });
  });

  modal.querySelector('#reportCopyBtn').addEventListener('click', copyToClipboard);
  modal.querySelector('#reportCompactBtn').addEventListener('click', () => {
    modal.dataset.compact = modal.dataset.compact === 'on' ? 'off' : 'on';
    reRender();
  });

  return modal;
}

function updateLangButtons() {
  const cur = getLang();
  document.querySelectorAll('#reportModal .report-lang-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === cur);
  });
}

function closeModal() {
  const modal = document.getElementById('reportModal');
  if (modal) modal.style.display = 'none';
}

/** Render with current source/input/lang. */
function reRender() {
  const modal = document.getElementById('reportModal');
  if (!modal || !modal.dataset.source) return;
  const source = modal.dataset.source;
  const input = readInputForSource(source);
  const lang = getLang();
  const result = generateClinicalReport(input, lang);
  modal.querySelector('#reportContent').textContent =
    modal.dataset.compact === 'on'
      ? compactReport(result.text)
      : result.text;

  const compactBtn = modal.querySelector('#reportCompactBtn');
  if (result.wordCount > 8000) compactBtn.style.display = '';
  else compactBtn.style.display = 'none';

  // PHI guard scan
  const allText = JSON.stringify(input.freeText) + ' ' + (input.dx || '');
  modal.querySelector('#reportPhiWarn').style.display = looksLikePHI(allText) ? '' : 'none';
}

function compactReport(text) {
  const idx = text.indexOf('# CITATIONS');
  if (idx < 0) return text;
  return text.slice(0, idx).trim();
}

function openReport(source) {
  const modal = ensureModal();
  modal.dataset.source = source;

  const input = readInputForSource(source);
  const missing = checkMinFields(source, input);
  if (missing.length) {
    alert('보고서 생성에 필요한 항목이 부족합니다:\n- ' + missing.join('\n- '));
    return;
  }

  modal.style.display = 'flex';
  updateLangButtons();
  reRender();
}

async function copyToClipboard() {
  const text = document.getElementById('reportContent')?.textContent || '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const c = document.getElementById('reportCopyConfirm');
    if (c) {
      c.style.display = '';
      setTimeout(() => { c.style.display = 'none'; }, 1100);
    }
  } catch (e) {
    alert('복사 실패: ' + e.message);
  }
}

function injectButtons() {
  // Insert "보고서 생성" button after each safety container.
  const targets = [
    { afterId: 'partitionSafety',  source: 'partition' },
    { afterId: 'mirdSafety',       source: 'mird' },
    { afterId: 'simplicitySafety', source: 'simplicity' },
  ];
  targets.forEach(({ afterId, source }) => {
    const anchor = document.getElementById(afterId);
    if (!anchor) return;
    if (document.getElementById('reportBtn-' + source)) return;
    const btn = document.createElement('button');
    btn.id = 'reportBtn-' + source;
    btn.className = 'report-trigger-btn';
    btn.textContent = '📄 보고서 생성';
    btn.addEventListener('click', () => openReport(source));
    anchor.parentNode.insertBefore(btn, anchor.nextSibling);
  });
}

// ====== INIT =========================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectButtons);
} else {
  injectButtons();
}

// Expose for testing / debugging.
window._dosimetryReport = {
  generate: generateClinicalReport,
  readInput: readInputForSource,
  getRefs: () => REFS,
  open: openReport,
};

})();
