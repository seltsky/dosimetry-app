/* ========= Y-90 Dosimetry Planner — MVP ========= */
(function() {
'use strict';

// Load references JSON
let REFS = { thresholds: [], cases: [] };
fetch('references.json').then(r=>r.json()).then(d=>{ REFS=d; renderRefs(); });

// ====== Constants ======
const RESIN_CONST = 49670; // Gy·g/GBq for resin
const GLASS_CONST = 49670; // same formula, different thresholds

// ====== Thresholds ======
const THRESHOLDS = {
  resin: {
    segmentectomy: { tumorMin: 250, tumorOptimal: 300, ref: 'Hermann 2024' },
    lobectomy: { tumorPartition: 250, tumorMIRD: 100, ntadMax: 70, ref: 'PPT/NCT04172714' },
    general: { tumorOR: 176, tumorCR: 247, ref: 'Vouche 2023' },
    crclm: { tumorMin: 100, ref: 'SARAH/Doyle' },
    ntad: { safe: 40, td50: 52, ref: 'Strigari 2010' },
    ntadLobar: { max: 103, ref: 'PMID 40640409' },
    lung: { korean: 15, western: 30, ref: 'Korean/Salem 2006' },
  },
  glass: {
    segmentectomy: { perfusedMin: 400, ref: 'LEGACY/2025 EJNMMI' },
    lobectomy: { tumorMin: 205, tumorIdeal: 250, ntadMax: 120, ref: 'DOSISPHERE/2022 EJNMMI' },
    general: { tumorOR: 290, tumorCR: 481, ref: 'Vouche 2023' },
    ntad: { uniA: 100, uniB: 70, bi: 70, ref: '2022 EJNMMI' },
    lung: { koreanM: 25, koreanF: 20, western: 30, ref: 'Korean/Salem 2006' },
  }
};

// ====== Partition Model Calculation ======
function calcPartition(input) {
  const { perfusedVol, tumorVol, tnRatio, lsf, lungMass, targetTumorDose } = input;
  const normalVol = perfusedVol - tumorVol;
  const normalDose = targetTumorDose / tnRatio;
  const perfusedDose = (tumorVol * targetTumorDose + normalVol * normalDose) / perfusedVol;
  const perfusedMass = perfusedVol;
  const activity = (perfusedDose * perfusedMass) / (RESIN_CONST * (1 - lsf / 100));
  const lungDose = (activity * RESIN_CONST * (lsf / 100)) / lungMass;

  let wlNtad = null;
  if (input.wholeVol && input.wholeVol > 0) {
    const totalNormalLiver = input.wholeVol - tumorVol;
    wlNtad = (normalVol * normalDose) / totalNormalLiver;
  }

  const perfusedFraction = input.wholeVol ? (perfusedVol / input.wholeVol * 100) : null;
  const ntadLimit = input.microsphere === 'resin' ? 70 : 120;
  const liverLimitTumorDose = ntadLimit * tnRatio;

  return {
    activity: Math.round(activity * 100) / 100,
    tumorDose: targetTumorDose,
    normalDose: Math.round(normalDose * 100) / 100,
    perfusedDose: Math.round(perfusedDose * 100) / 100,
    lungDose: Math.round(lungDose * 100) / 100,
    wlNtad: wlNtad !== null ? Math.round(wlNtad * 100) / 100 : null,
    perfusedFraction: perfusedFraction !== null ? Math.round(perfusedFraction * 10) / 10 : null,
    normalVol,
    liverLimitTumorDose: Math.round(liverLimitTumorDose),
  };
}

// ====== MIRD (Single Compartment) Calculation ======
function calcMIRD(input) {
  const { perfusedVol, tumorVol, tnRatio, lsf, lungMass, targetTumorDose } = input;
  const normalVol = perfusedVol - tumorVol;
  const perfusedMass = perfusedVol;

  // MIRD: treat perfused volume as single compartment
  // Set perfused dose = target tumor dose (no T/N differentiation for activity calc)
  // This gives a HIGHER (more conservative) activity than Partition
  const mirdPerfusedDose = targetTumorDose;
  const mirdActivity = (mirdPerfusedDose * perfusedMass) / (RESIN_CONST * (1 - lsf / 100));

  // Back-calculate actual tumor/normal doses with T/N ratio applied
  const actualPerfusedDose = (mirdActivity * RESIN_CONST * (1 - lsf / 100)) / perfusedMass;
  const actualTumorDose = actualPerfusedDose * tnRatio * perfusedVol / (tnRatio * tumorVol + normalVol);
  const actualNormalDose = actualTumorDose / tnRatio;

  const lungDose = (mirdActivity * RESIN_CONST * (lsf / 100)) / lungMass;

  let wlNtad = null;
  if (input.wholeVol && input.wholeVol > 0) {
    const totalNormalLiver = input.wholeVol - tumorVol;
    wlNtad = (normalVol * actualNormalDose) / totalNormalLiver;
  }

  return {
    activity: Math.round(mirdActivity * 100) / 100,
    perfusedDose: Math.round(actualPerfusedDose * 100) / 100,
    tumorDose: Math.round(actualTumorDose * 100) / 100,
    normalDose: Math.round(actualNormalDose * 100) / 100,
    lungDose: Math.round(lungDose * 100) / 100,
    wlNtad: wlNtad !== null ? Math.round(wlNtad * 100) / 100 : null,
  };
}

// ====== Scenario Classification ======
function classifyScenario(input) {
  const { perfusedVol, wholeVol, segment, intent } = input;
  const pf = wholeVol ? (perfusedVol / wholeVol * 100) : null;

  if (intent === 'curative' && pf && pf <= 30) return 'Radiation Segmentectomy';
  if (pf && pf > 30 && pf <= 60) return 'Radiation Lobectomy';
  if (pf && pf > 60) return 'Multifocal/Bilobar';
  if (segment && segment.toLowerCase().includes('caudate')) return 'Caudate Segmentectomy';
  if (intent === 'palliative') return 'Palliative';
  return 'General';
}

// ====== Safety Evaluation ======
function evaluateSafety(input, result) {
  const micro = input.microsphere;
  const th = THRESHOLDS[micro];
  const items = [];
  const scenario = classifyScenario(input);

  // Tumor dose
  if (micro === 'resin') {
    if (scenario.includes('Segmentectomy')) {
      items.push({
        icon: result.tumorDose >= 300 ? '✅' : result.tumorDose >= 250 ? '⚠️' : '❌',
        text: `종양 선량 ${result.tumorDose} Gy (RS optimal ≥300 Gy, min ≥250 Gy)`,
        ref: 'Hermann 2024, Radiology',
        status: result.tumorDose >= 300 ? 'safe' : result.tumorDose >= 250 ? 'warn' : 'danger'
      });
    } else {
      items.push({
        icon: result.tumorDose >= 247 ? '✅' : result.tumorDose >= 176 ? '⚠️' : '❌',
        text: `종양 선량 ${result.tumorDose} Gy (CR ≥247 Gy, OR ≥176 Gy)`,
        ref: 'Vouche 2023, JVIR',
        status: result.tumorDose >= 247 ? 'safe' : result.tumorDose >= 176 ? 'warn' : 'danger'
      });
    }
  } else { // glass
    if (scenario.includes('Segmentectomy')) {
      items.push({
        icon: result.perfusedDose >= 400 ? '✅' : '⚠️',
        text: `Perfused dose ${result.perfusedDose} Gy (RS ≥400 Gy)`,
        ref: 'LEGACY/2025 EJNMMI',
        status: result.perfusedDose >= 400 ? 'safe' : 'warn'
      });
    } else {
      items.push({
        icon: result.tumorDose >= 250 ? '✅' : result.tumorDose >= 205 ? '⚠️' : '❌',
        text: `종양 선량 ${result.tumorDose} Gy (ideal ≥250 Gy, min ≥205 Gy)`,
        ref: 'DOSISPHERE-01',
        status: result.tumorDose >= 250 ? 'safe' : result.tumorDose >= 205 ? 'warn' : 'danger'
      });
    }
  }

  // Normal tissue
  const ntadSafe = micro === 'resin' ? 40 : 75;
  items.push({
    icon: result.normalDose <= ntadSafe ? '✅' : result.normalDose <= 52 ? '⚠️' : '❌',
    text: `Perfused NTAD ${result.normalDose} Gy (safe <${ntadSafe} Gy, TD50 52 Gy)`,
    ref: micro === 'resin' ? 'Strigari 2010' : '2025 EJNMMI Expert',
    status: result.normalDose <= ntadSafe ? 'safe' : result.normalDose <= 52 ? 'warn' : 'danger'
  });

  // WL NTAD
  if (result.wlNtad !== null) {
    items.push({
      icon: result.wlNtad <= 40 ? '✅' : result.wlNtad <= 52 ? '⚠️' : '❌',
      text: `WL NTAD ${result.wlNtad} Gy (safe <40 Gy, TD50 52 Gy)`,
      ref: 'Strigari 2010',
      status: result.wlNtad <= 40 ? 'safe' : result.wlNtad <= 52 ? 'warn' : 'danger'
    });
  }

  // Lung dose
  const lungLimit = micro === 'resin' ? 15 : 25;
  items.push({
    icon: result.lungDose <= lungLimit ? '✅' : result.lungDose <= 30 ? '⚠️' : '❌',
    text: `Lung dose ${result.lungDose} Gy (Korean <${lungLimit} Gy)`,
    ref: 'Korean guideline',
    status: result.lungDose <= lungLimit ? 'safe' : result.lungDose <= 30 ? 'warn' : 'danger'
  });

  // LSF
  items.push({
    icon: input.lsf <= 10 ? '✅' : input.lsf <= 20 ? '⚠️' : '❌',
    text: `LSF ${input.lsf}% (safe <10%, caution 10-20%)`,
    ref: '',
    status: input.lsf <= 10 ? 'safe' : input.lsf <= 20 ? 'warn' : 'danger'
  });

  return { items, scenario };
}

// ====== Find Similar Cases ======
function findSimilarCases(input, result) {
  const micro = input.microsphere === 'resin' ? 'Resin' : 'Glass';
  return REFS.cases.filter(c => {
    const matchMicro = !c.Microsphere || c.Microsphere === '?' || c.Microsphere === micro || c.Microsphere === 'Both' || c.Microsphere === 'N/A';
    return matchMicro;
  }).slice(0, 5);
}

// ====== Generate Report Text ======
function generateReport(input, result, safety) {
  const lines = [];
  lines.push(`═══ Y-90 Dosimetry Plan ═══`);
  lines.push(`Microsphere: ${input.microsphere === 'resin' ? 'Resin (SIR-Spheres)' : 'Glass (TheraSphere)'}`);
  lines.push(`Child-Pugh: ${input.childPugh} | Intent: ${input.intent}`);
  lines.push(`Scenario: ${safety.scenario}`);
  lines.push('');
  lines.push(`[입력]`);
  lines.push(`Perfused: ${input.perfusedVol} mL | Tumor: ${input.tumorVol} mL`);
  lines.push(`T/N: ${input.tnRatio} | LSF: ${input.lsf}%`);
  if (input.wholeVol) lines.push(`Whole liver: ${input.wholeVol} mL | Perfused fraction: ${result.perfusedFraction}%`);
  lines.push('');
  lines.push(`[Partition Model]`);
  lines.push(`Activity: ${result.activity} GBq`);
  lines.push(`Tumor AD: ${result.tumorDose} Gy | NTAD: ${result.normalDose} Gy`);
  lines.push(`Perfused AD: ${result.perfusedDose} Gy`);
  if (result.wlNtad !== null) lines.push(`WL NTAD: ${result.wlNtad} Gy`);
  lines.push(`Lung AD: ${result.lungDose} Gy`);
  lines.push('');
  lines.push(`[MIRD (Single Compartment)]`);
  const mirdData = calcMIRD(input);
  lines.push(`Activity: ${mirdData.activity} GBq`);
  lines.push(`Tumor AD: ${mirdData.tumorDose} Gy | NTAD: ${mirdData.normalDose} Gy`);
  lines.push(`Perfused AD: ${mirdData.perfusedDose} Gy`);
  if (mirdData.wlNtad !== null) lines.push(`WL NTAD: ${mirdData.wlNtad} Gy`);
  lines.push(`Lung AD: ${mirdData.lungDose} Gy`);
  lines.push('');
  lines.push(`[안전성 평가]`);
  safety.items.forEach(s => lines.push(`${s.icon} ${s.text}`));
  return lines.join('\n');
}

// ====== Render Results ======
function renderResults(input, result, mird, safety) {
  const container = document.getElementById('resultContainer');
  const cases = findSimilarCases(input, result);

  let html = `
    <div class="card">
      <span class="scenario-badge">${safety.scenario}</span>

      <div class="model-compare">
        <div class="model-col">
          <div class="model-header partition-header">Partition Model</div>
          <div class="model-value-big">${result.activity} <span class="model-unit">GBq</span></div>
          <div class="model-rows">
            <div class="result-row"><span class="result-label">Tumor AD</span><span class="result-value">${result.tumorDose} Gy</span></div>
            <div class="result-row"><span class="result-label">NTAD</span><span class="result-value ${result.normalDose<=40?'safe':result.normalDose<=52?'warn':'danger'}">${result.normalDose} Gy</span></div>
            <div class="result-row"><span class="result-label">Perfused AD</span><span class="result-value">${result.perfusedDose} Gy</span></div>
            ${result.wlNtad!==null ? `<div class="result-row"><span class="result-label">WL NTAD</span><span class="result-value ${result.wlNtad<=40?'safe':result.wlNtad<=52?'warn':'danger'}">${result.wlNtad} Gy</span></div>` : ''}
            <div class="result-row"><span class="result-label">Lung AD</span><span class="result-value ${result.lungDose<=15?'safe':result.lungDose<=30?'warn':'danger'}">${result.lungDose} Gy</span></div>
          </div>
        </div>
        <div class="model-col">
          <div class="model-header mird-header">MIRD (Single Compartment)</div>
          <div class="model-value-big">${mird.activity} <span class="model-unit">GBq</span></div>
          <div class="model-rows">
            <div class="result-row"><span class="result-label">Tumor AD</span><span class="result-value">${mird.tumorDose} Gy</span></div>
            <div class="result-row"><span class="result-label">NTAD</span><span class="result-value ${mird.normalDose<=40?'safe':mird.normalDose<=52?'warn':'danger'}">${mird.normalDose} Gy</span></div>
            <div class="result-row"><span class="result-label">Perfused AD</span><span class="result-value">${mird.perfusedDose} Gy</span></div>
            ${mird.wlNtad!==null ? `<div class="result-row"><span class="result-label">WL NTAD</span><span class="result-value ${mird.wlNtad<=40?'safe':mird.wlNtad<=52?'warn':'danger'}">${mird.wlNtad} Gy</span></div>` : ''}
            <div class="result-row"><span class="result-label">Lung AD</span><span class="result-value ${mird.lungDose<=15?'safe':mird.lungDose<=30?'warn':'danger'}">${mird.lungDose} Gy</span></div>
          </div>
        </div>
      </div>
      <div class="model-note">※ Partition = multi-compartment (T/N ratio 반영, Simplicity personalized dosimetry와 동일). MIRD = single compartment (보수적).</div>
    </div>

    <div class="card">
      <div class="result-section">
        <h3>4단계 계산 (Partition Model)</h3>
        <div style="font-size:12px">
          <div class="result-row" style="background:rgba(0,180,216,0.05);padding:8px;border-radius:6px;margin-bottom:4px">
            <span class="result-label"><strong>① Desired Tumor Dose ${result.tumorDose} Gy</strong></span>
            <span class="result-value">A = ${result.activity} GBq | NTAD ${result.normalDose} Gy | Lung ${result.lungDose} Gy</span>
          </div>
          <div class="result-row" style="padding:8px;margin-bottom:4px">
            <span class="result-label"><strong>② Liver Limiting (NTAD ${input.microsphere==='resin'?70:120} Gy)</strong></span>
            <span class="result-value">Tumor ${result.liverLimitTumorDose} Gy</span>
          </div>
          <div class="result-row" style="padding:8px;margin-bottom:4px">
            <span class="result-label"><strong>③ Lung Limiting (${input.microsphere==='resin'?15:25} Gy)</strong></span>
            <span class="result-value">A = ${((input.microsphere==='resin'?15:25) * (input.lungMass||1000) / (49670 * (input.lsf/100))).toFixed(2)} GBq</span>
          </div>
        </div>
      </div>

      <div class="result-section" style="margin-top:12px">
        ${result.perfusedFraction!==null ? `<div class="result-row"><span class="result-label">Perfused Fraction</span><span class="result-value">${result.perfusedFraction}%</span></div>` : ''}
        <div class="result-row"><span class="result-label">Liver Limiting Tumor Dose</span><span class="result-value">${result.liverLimitTumorDose} Gy</span></div>
      </div>
    </div>

    <div class="card">
      <div class="result-section">
        <h3>안전성 평가</h3>
        ${safety.items.map(s=>`
          <div class="safety-item">
            <span class="safety-icon">${s.icon}</span>
            <div>
              <div class="safety-text">${s.text}</div>
              ${s.ref ? `<div class="safety-ref">${s.ref}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Similar cases warnings
  if (cases.length > 0) {
    html += `<div class="card"><div class="result-section"><h3>⚠️ 유사 사례 부작용 주의</h3>`;
    cases.forEach(c => {
      html += `
        <div class="warning-card">
          <div class="ref-title">${c.Title || ''}</div>
          <div class="ref-meta">${c.PMID ? 'PMID '+c.PMID+' | ' : ''}${c.Year || ''} ${c.Journal || ''}</div>
          <div class="ref-finding">${c.Complication || c['Key Finding'] || ''}</div>
          <div class="ref-meta">결과: ${c.Outcome || ''}</div>
        </div>
      `;
    });
    html += `</div></div>`;
  }

  container.innerHTML = html;
}

// ====== Render References ======
function renderRefs() {
  const container = document.getElementById('refsList');
  if (!container) return;
  const search = (document.getElementById('refSearch')?.value || '').toLowerCase();
  const filter = document.getElementById('refFilter')?.value || 'all';
  const micro = document.getElementById('refMicro')?.value || 'all';

  let items = [];
  if (filter === 'all' || filter === 'threshold') {
    REFS.thresholds.forEach(r => items.push({...r, _type: 'threshold'}));
  }
  if (filter === 'all' || filter === 'case') {
    REFS.cases.forEach(r => items.push({...r, _type: 'case'}));
  }

  if (micro !== 'all') {
    items = items.filter(r => {
      const m = r.Microsphere || r.microsphere || '';
      return m === micro || m === 'Both' || m === '';
    });
  }

  if (search) {
    items = items.filter(r => {
      const text = JSON.stringify(r).toLowerCase();
      return text.includes(search);
    });
  }

  container.innerHTML = items.length === 0 ? '<div class="empty-state">검색 결과 없음</div>' :
    items.map(r => {
      const isCase = r._type === 'case';
      const title = r.Title || r.title || '';
      const pmid = r.PMID || r.pmid || '';
      const year = r.Year || r.year || '';
      const journal = r.Journal || r.journal || '';
      const finding = r['Key Finding'] || r.Complication || r['key_finding'] || '';
      const msphere = r.Microsphere || r.microsphere || '';

      return `
        <div class="${isCase ? 'warning-card' : 'ref-card'}">
          <div class="ref-title">${title}</div>
          <div class="ref-meta">${pmid ? 'PMID '+pmid+' | ' : ''}${year} ${journal}</div>
          <div class="ref-finding">${finding}</div>
          <div class="ref-tags">
            <span class="ref-tag ${isCase?'case':''}">${isCase?'Case/Complication':'Threshold'}</span>
            ${msphere ? `<span class="ref-tag">${msphere}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
}

// ====== Event Listeners ======
function init() {
  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc=>tc.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'refs') renderRefs();
    });
  });

  // Dose slider
  const slider = document.getElementById('targetDoseSlider');
  const doseVal = document.getElementById('targetDoseValue');
  slider.addEventListener('input', () => {
    doseVal.textContent = slider.value;
    document.querySelectorAll('.quick-dose').forEach(b => b.classList.toggle('active', b.dataset.dose === slider.value));
  });

  // Quick dose buttons
  document.querySelectorAll('.quick-dose').forEach(btn => {
    btn.addEventListener('click', () => {
      slider.value = btn.dataset.dose;
      doseVal.textContent = btn.dataset.dose;
      document.querySelectorAll('.quick-dose').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Scenario-specific dose guides
  // PPT 기반 시나리오별 dose guides
  const DOSE_GUIDES = {
    resin: {
      segmentectomy: [
        ['Tumor dose (min)', '>250 Gy', 'NCT04172714 (Partition/Voxel dosimetry)'],
        ['Tumor dose (optimal)', '≥300 Gy', 'Hermann 2024, Radiology'],
        ['Model', 'Single compartment (MIRD) enough', 'Salem 2021, Semin Nucl Med'],
        ['Curative intent', 'Late 1st week or early 2nd week', 'Vouche 2023, JVIR'],
        ['Lung', '<15 Gy/session', 'Korean Liver Cancer Assoc Guideline'],
      ],
      lobectomy: [
        ['Tumor dose (Partition)', '>250 Gy', 'NCT04172714'],
        ['Tumor dose (MIRD)', '>100 Gy', 'Hermann 2020, Radiology (SARAH sub-analysis)'],
        ['Perfused NTAD', '~70 Gy', 'Strigari 2010, J Nucl Med (TD50 52Gy 기반)'],
        ['용도', 'Bridging to LT / Neoadjuvant', 'Lewandowski 2009, JVIR'],
        ['Lung', '<15 Gy/session', 'Korean Liver Cancer Assoc Guideline'],
      ],
      largeHCC: [
        ['Tumor dose', '>100~157 Gy', 'Hermann 2020, Radiology / Doyle 2019'],
        ['STRATUM threshold', '150 Gy', 'STRATUM trial (NCT03000439)'],
        ['Normal tissue AD', '<40~70 Gy', 'Strigari 2010, J Nucl Med'],
        ['WL NTAD safe', '<40 Gy (TD50 52Gy)', 'Strigari 2010, J Nucl Med'],
        ['Lung', '<15 Gy/session', 'Korean Liver Cancer Assoc Guideline'],
      ],
      unilobar: [
        ['Tumor dose', '>250 Gy', 'NCT04172714'],
        ['Normal tissue AD', '40~70 Gy', 'Strigari 2010 / CIRT Study (JHEP Rep 2023)'],
        ['MIRD model', '150 Gy 이상 목표', 'STRATUM trial (NCT03000439)'],
        ['비종양선량에 초점', '', 'Chiesa 2015, Eur J Nucl Med Mol Imaging'],
        ['Lung', '<15 Gy/session', 'Korean Liver Cancer Assoc Guideline'],
      ],
      bilobar: [
        ['Tumor dose', '>100 Gy', 'Hermann 2020, Radiology (SARAH)'],
        ['Normal tissue AD', '<40 Gy', 'Strigari 2010, J Nucl Med'],
        ['Lung', '<15 Gy/session', 'Korean Liver Cancer Assoc Guideline'],
      ],
      pvt: [
        ['Tumor dose', '>100 Gy', 'Hermann 2020, Radiology (SARAH)'],
        ['NTAD CPS A', '>70 Gy', 'Strigari 2010 / CIRT Study (JHEP Rep 2023)'],
        ['NTAD CPS B', '40~70 Gy', 'Strigari 2010, J Nucl Med'],
        ['Lung', '<15 Gy/session', 'Korean Liver Cancer Assoc Guideline'],
      ],
    },
    glass: {
      segmentectomy: [
        ['Perfused dose', '≥400 Gy', 'Salem 2021, J Hepatol (LEGACY)'],
        ['Complete necrosis', '400 Gy (perfused)', 'Salem 2021, J Hepatol (LEGACY)'],
        ['Model', 'Single compartment (MIRD) enough', 'Salem 2021, Semin Nucl Med'],
        ['Curative intent', 'Late 1st week or early 2nd week', 'Vouche 2023, JVIR'],
        ['Lung (M/F)', '<25/<20 Gy', 'Korean Liver Cancer Assoc Guideline'],
      ],
      lobectomy: [
        ['Tumor dose (Partition)', '>205 Gy, ideally >250 Gy', 'Garin 2021, Lancet Gastro (DOSISPHERE-01)'],
        ['Tumor dose (MIRD)', '>150 Gy', 'Garin 2021, Lancet Gastro (DOSISPHERE-01)'],
        ['NTAD', '<120 Gy', '2022 EJNMMI Consensus'],
        ['Perfused NTAD', '88 Gy', 'Garin 2017, J Nucl Med'],
        ['용도', 'Bridging to LT', 'Lewandowski 2009, JVIR'],
        ['Lung (M/F)', '<25/<20 Gy', 'Korean Liver Cancer Assoc Guideline'],
      ],
      largeHCC: [
        ['Tumor dose', '>205 Gy (preferably 250 Gy)', 'Garin 2021, Lancet Gastro (DOSISPHERE-01)'],
        ['Normal tissue AD', '<120 Gy', '2022 EJNMMI Consensus'],
        ['Hepatic reserve', '>30% 필요', '2022 EJNMMI Consensus'],
        ['Normal tissue AD (wide)', '<40~70 Gy', 'Strigari 2010, J Nucl Med'],
        ['Radiation major hepatectomy', 'Perfused AD >200, lung limiting, split ≥4wk', 'Gabr 2021, Eur J Nucl Med Mol Imaging'],
        ['Lung (M/F)', '<25/<20 Gy', 'Korean Liver Cancer Assoc Guideline'],
      ],
      unilobar: [
        ['Tumor dose', '>205 Gy (ideally 250 Gy)', 'Garin 2021, Lancet Gastro (DOSISPHERE-01)'],
        ['Normal tissue AD CPS A', '<100 Gy', '2022 EJNMMI Consensus'],
        ['Normal tissue AD CPS B', '<70 Gy', '2022 EJNMMI Consensus'],
        ['MIRD model', '150 Gy 이상 목표', 'Garin 2017, J Nucl Med'],
        ['Lung (M/F)', '<25/<20 Gy', 'Korean Liver Cancer Assoc Guideline'],
      ],
      bilobar: [
        ['Tumor dose', '>205 Gy (ideally 250 Gy)', 'Garin 2021, Lancet Gastro (DOSISPHERE-01)'],
        ['Normal tissue AD CPS A', '40~70 Gy', '2022 EJNMMI Consensus'],
        ['Lung (M/F)', '<25/<20 Gy', 'Korean Liver Cancer Assoc Guideline'],
      ],
      pvt: [
        ['Tumor dose', '>205 Gy (ideally 250 Gy)', 'Garin 2021, Lancet Gastro (DOSISPHERE-01)'],
        ['NTAD', '<120 Gy', '2022 EJNMMI Consensus'],
        ['NTAD CPS B', '<70 Gy', '2022 EJNMMI Consensus'],
        ['Lung (M/F)', '<25/<20 Gy', 'Korean Liver Cancer Assoc Guideline'],
      ],
    }
  };

  let currentScenario = 'segmentectomy';

  function updateDoseGuide() {
    const micro = document.getElementById('microsphere').value;
    const el = document.getElementById('doseGuideContent');
    if (!el) return;
    const guides = DOSE_GUIDES[micro]?.[currentScenario] || [];

    el.innerHTML = guides.map(g => `
      <div class="dose-guide-row">
        <span class="dose-guide-scenario">${g[0]}</span>
        <span class="dose-guide-dose">${g[1]}</span>
      </div>
      ${g[2] ? `<div style="font-size:10px;color:var(--dim);padding:0 0 4px 8px">${g[2]}</div>` : ''}
    `).join('');

    // Auto-set recommended dose on slider
    const slider = document.getElementById('targetDoseSlider');
    const doseVal = document.getElementById('targetDoseValue');
    const recommended = {
      resin: { segmentectomy: 300, lobectomy: 250, largeHCC: 150, unilobar: 250, bilobar: 150, pvt: 150 },
      glass: { segmentectomy: 400, lobectomy: 250, largeHCC: 250, unilobar: 250, bilobar: 250, pvt: 250 },
    };
    const rec = recommended[micro]?.[currentScenario] || 250;
    slider.value = rec;
    doseVal.textContent = rec;
    document.querySelectorAll('.quick-dose').forEach(b => b.classList.toggle('active', parseInt(b.dataset.dose) === rec));
  }

  // ====== MAA Counts Toggle & Calculation ======
  document.querySelectorAll('.maa-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.maa-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('directInput').style.display = btn.dataset.mode === 'direct' ? 'grid' : 'none';
      document.getElementById('maaInput').style.display = btn.dataset.mode === 'maa' ? 'block' : 'none';
    });
  });

  ['maaLung','maaLiver','maaTumor'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      const lung = parseFloat(document.getElementById('maaLung').value) || 0;
      const liver = parseFloat(document.getElementById('maaLiver').value) || 0;
      const tumor = parseFloat(document.getElementById('maaTumor').value) || 0;
      if (lung > 0 && liver > 0 && tumor > 0) {
        const normalLiver = liver - tumor;
        const lsf = lung / (lung + liver) * 100;
        const tnRatioCalc = (tumor / parseFloat(document.getElementById('tumorVol').value || 1)) / (normalLiver / (parseFloat(document.getElementById('perfusedVol').value || 1) - parseFloat(document.getElementById('tumorVol').value || 1)));
        document.getElementById('tnRatio').value = tnRatioCalc.toFixed(2);
        document.getElementById('lsf').value = lsf.toFixed(2);
        document.getElementById('maaResult').innerHTML = `T/N Ratio: <strong>${tnRatioCalc.toFixed(2)}</strong> | LSF: <strong>${lsf.toFixed(2)}%</strong> | Normal liver counts: ${normalLiver.toFixed(0)}`;
      }
    });
  });

  // ====== Glass MIRD Time Table ======
  function calcGlassTimeTable() {
    const el = document.getElementById('glassTimeTable');
    if (!el) return;
    const targetVol = parseFloat(document.getElementById('perfusedVol').value) || 0;
    const desiredDose = parseInt(document.getElementById('targetDoseSlider').value) || 150;
    const lsf = parseFloat(document.getElementById('lsf').value) || 0;
    const residual = parseFloat(document.getElementById('residualWaste').value) || 1;
    const prevLung = parseFloat(document.getElementById('prevLungDose').value) || 0;
    const lungMass = parseFloat(document.getElementById('lungMass').value) || 1000;

    if (targetVol <= 0) { el.innerHTML = '<div class="empty-state">Perfused Volume을 입력하세요</div>'; return; }

    const targetMassKg = targetVol * 1.03 / 1000; // liver density ~1.03 g/mL
    const halfLife = 64.1; // hours
    const lambda = Math.log(2) / halfLife;

    // Required activity at administration
    const reqActivity = (desiredDose * targetMassKg) / (49.67 * (1 - lsf/100) * (1 - residual/100));

    // Lung dose
    const lungDoseCalc = (reqActivity * 49.67 * (lsf/100)) / (lungMass/1000);
    const cumLung = lungDoseCalc + prevLung;

    // Dose sizes to show
    const doseSizes = [3, 5, 7, 10, 12, 15, 20];
    // Days: Sun(calibration), Mon-Sat, Sun-Wed (week 2)
    const days = ['Sun(Cal)', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
    const times = ['08:00', '12:00', '16:00', '20:00'];
    const tzOffset = 14; // Korea = +14h from Eastern

    let html = `<div style="font-size:12px;margin-bottom:8px">`;
    html += `Required Activity: <strong>${reqActivity.toFixed(2)} GBq</strong> | `;
    html += `Lung Dose: <strong style="color:${lungDoseCalc<=30?'var(--safe)':'var(--danger)'}">${lungDoseCalc.toFixed(1)} Gy</strong>`;
    if (prevLung > 0) html += ` (Cumulative: ${cumLung.toFixed(1)} Gy)`;
    html += `</div>`;

    // Show table for the closest dose size
    const closestSize = doseSizes.reduce((a, b) => Math.abs(b - reqActivity) < Math.abs(a - reqActivity) ? b : a);
    const showSizes = [closestSize];
    if (closestSize > doseSizes[0]) showSizes.unshift(doseSizes[doseSizes.indexOf(closestSize) - 1]);
    if (closestSize < doseSizes[doseSizes.length - 1]) showSizes.push(doseSizes[doseSizes.indexOf(closestSize) + 1]);

    for (const size of showSizes) {
      html += `<div style="font-size:11px;font-weight:700;color:var(--accent);margin:8px 0 4px">${size} GBq dose size${size === closestSize ? ' ← closest' : ''}</div>`;
      html += `<table class="time-table"><tr><th>Time</th>`;
      days.forEach(d => html += `<th>${d}</th>`);
      html += `</tr>`;

      for (const time of times) {
        html += `<tr><td class="row-header">${time}</td>`;
        const [h] = time.split(':').map(Number);
        for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
          if (dayIdx === 0) {
            html += `<td style="color:var(--dim)">Cal Day</td>`;
            continue;
          }
          // Hours from calibration (Sunday 12:00 Eastern)
          const hoursFromCal = dayIdx * 24 + (h - 12) + tzOffset;
          if (hoursFromCal <= 0) { html += `<td>-</td>`; continue; }
          // Decayed activity
          const decayedActivity = size * Math.exp(-lambda * hoursFromCal);
          // Dose at this time
          const dose = (decayedActivity * 49.67 * (1 - lsf/100) * (1 - residual/100)) / targetMassKg;
          const isClose = Math.abs(dose - desiredDose) < desiredDose * 0.15;
          const cls = isClose ? 'highlight' : dose > desiredDose * 1.5 ? 'warn' : '';
          html += `<td class="${cls}">${dose.toFixed(0)}</td>`;
        }
        html += `</tr>`;
      }
      html += `</table>`;
    }

    el.innerHTML = html;
  }

  // Show/hide Glass time table
  function updateGlassPanel() {
    const micro = document.getElementById('microsphere').value;
    const card = document.getElementById('glassTimeCard');
    if (card) card.style.display = micro === 'glass' ? 'block' : 'none';
    if (micro === 'glass') calcGlassTimeTable();
  }

  // Microsphere toggle
  document.querySelectorAll('.micro-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.micro-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('microsphere').value = btn.dataset.micro;
      updateDoseGuide();
      updateGlassPanel();
    });
  });

  // Scenario tabs
  document.querySelectorAll('.scenario-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.scenario-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentScenario = tab.dataset.scenario;
      // Auto-set intent
      if (['segmentectomy'].includes(currentScenario)) {
        document.getElementById('intent').value = 'curative';
      }
      updateDoseGuide();
    });
  });

  updateDoseGuide();
  updateGlassPanel();

  // Recalc glass table on input changes
  ['targetDoseSlider','perfusedVol','lsf','lungMass','residualWaste','prevLungDose'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { if (document.getElementById('microsphere').value === 'glass') calcGlassTimeTable(); });
  });

  // Calculate
  document.getElementById('calcBtn').addEventListener('click', () => {
    const input = {
      microsphere: document.getElementById('microsphere').value,
      childPugh: document.getElementById('childPugh').value,
      intent: document.getElementById('intent').value,
      segment: document.getElementById('segment').value,
      perfusedVol: parseFloat(document.getElementById('perfusedVol').value),
      tumorVol: parseFloat(document.getElementById('tumorVol').value),
      wholeVol: parseFloat(document.getElementById('wholeVol').value) || null,
      tnRatio: parseFloat(document.getElementById('tnRatio').value),
      lsf: parseFloat(document.getElementById('lsf').value),
      lungMass: parseFloat(document.getElementById('lungMass').value) || 1000,
      targetTumorDose: parseInt(slider.value),
    };

    if (!input.perfusedVol || !input.tumorVol || !input.tnRatio || !input.lsf) {
      alert('필수 항목을 입력해주세요: Perfused Vol, Tumor Vol, T/N Ratio, LSF');
      return;
    }

    const result = calcPartition(input);
    const mird = calcMIRD(input);
    const safety = evaluateSafety(input, result);
    renderResults(input, result, mird, safety);

    // Switch to result tab
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc=>tc.classList.remove('active'));
    document.querySelector('[data-tab="result"]').classList.add('active');
    document.getElementById('tab-result').classList.add('active');
  });

  // References search
  ['refSearch','refFilter','refMicro'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderRefs);
    if (el) el.addEventListener('change', renderRefs);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
