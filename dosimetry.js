/* ========= Y-90 Dosimetry Planner v2 — Sheet-based UI ========= */
(function() {
'use strict';

let REFS = { thresholds: [], cases: [] };
fetch('references.json').then(r=>r.json()).then(d=>{ REFS=d; renderRefs(); }).catch(()=>{});

const C = 49670; // Gy·g/GBq
const CASES_KEY = 'dosimetry_cases';
const PW_KEY = 'dosimetry_admin_pw';

// ====== Case DB Functions ======
function loadCases() { try { return JSON.parse(localStorage.getItem(CASES_KEY)||'[]'); } catch { return []; } }
function saveCases(cases) { localStorage.setItem(CASES_KEY, JSON.stringify(cases)); }

function savePartitionCase() {
  const c = {
    id: Date.now().toString(36),
    savedAt: new Date().toISOString(),
    model: 'Partition',
    micro: tabMicro.partition,
    hospital: document.getElementById('p_hospital')?.value || '',
    mrn: document.getElementById('p_mrn')?.value || '',
    patId: document.getElementById('p_patId')?.value || '',
    sex: document.getElementById('p_sex')?.value || '',
    age: document.getElementById('p_age')?.value || '',
    dx: document.getElementById('p_dx')?.value || '',
    date: document.getElementById('p_date')?.value || new Date().toISOString().slice(0,10),
    cps: document.getElementById('p_cps')?.value || '',
    intent: document.getElementById('p_intent')?.value || '',
    scenario: document.getElementById('p_scenario')?.value || '',
    memo: document.getElementById('p_memo')?.value || '',
    // Input values
    liverVol: document.getElementById('p_liverVol')?.value || '',
    tumorVol: document.getElementById('p_tumorVol')?.value || '',
    wholeVol: document.getElementById('p_wholeVol')?.value || '',
    tn: document.getElementById('p_tn')?.value || '',
    lsf: document.getElementById('p_lsf')?.value || '',
    lungMass: document.getElementById('p_lungMass')?.value || '',
    desiredDose: document.getElementById('p_desiredDose')?.value || '',
    liverLimit: document.getElementById('p_liverLimit')?.value || '',
    lungLimit: document.getElementById('p_lungLimit')?.value || '',
    prescribedA: document.getElementById('p_prescribedA')?.value || '',
    // Results (from DOM)
    r1_activity: document.getElementById('p_r1_activity')?.textContent || '',
    r1_normal: document.getElementById('p_r1_normal')?.textContent || '',
    r1_lung: document.getElementById('p_r1_lung')?.textContent || '',
    r2_tumor: document.getElementById('p_r2_tumor')?.textContent || '',
    r2_activity: document.getElementById('p_r2_activity')?.textContent || '',
    r3_tumor: document.getElementById('p_r3_tumor')?.textContent || '',
    r3_activity: document.getElementById('p_r3_activity')?.textContent || '',
    r4_tumor: document.getElementById('p_r4_tumor')?.textContent || '',
    r4_normal: document.getElementById('p_r4_normal')?.textContent || '',
    r4_lung: document.getElementById('p_r4_lung')?.textContent || '',
  };
  const cases = loadCases();
  cases.unshift(c);
  saveCases(cases);
  return c;
}

function saveMIRDCase() {
  const c = {
    id: Date.now().toString(36),
    savedAt: new Date().toISOString(),
    model: 'MIRD',
    micro: tabMicro.mird,
    hospital: document.getElementById('m_hospital')?.value || '',
    mrn: document.getElementById('m_mrn')?.value || '',
    patId: document.getElementById('m_patId')?.value || '',
    sex: document.getElementById('m_sex')?.value || '',
    age: document.getElementById('m_age')?.value || '',
    dx: document.getElementById('m_dx')?.value || '',
    date: document.getElementById('m_date')?.value || new Date().toISOString().slice(0,10),
    cps: document.getElementById('m_cps')?.value || '',
    intent: document.getElementById('m_intent')?.value || '',
    scenario: document.getElementById('m_scenario')?.value || '',
    memo: document.getElementById('m_memo')?.value || '',
    targetVol: document.getElementById('m_targetVol')?.value || '',
    desiredDose: document.getElementById('m_desiredDose')?.value || '',
    lsf: document.getElementById('m_lsf')?.value || '',
    residual: document.getElementById('m_residual')?.value || '',
    lungMass: document.getElementById('m_lungMass')?.value || '',
    prevLung: document.getElementById('m_prevLung')?.value || '',
    activity: document.getElementById('m_activity')?.textContent || '',
    lungDose: document.getElementById('m_lungDose')?.textContent || '',
  };
  const cases = loadCases();
  cases.unshift(c);
  saveCases(cases);
  return c;
}

function checkPassword(action, callback) {
  const stored = localStorage.getItem(PW_KEY);
  if (!stored) {
    const pw = prompt('관리자 비밀번호를 설정하세요 (최초 1회):');
    if (pw) { localStorage.setItem(PW_KEY, pw); callback(); }
  } else {
    const pw = prompt(`${action} 비밀번호 입력:`);
    if (pw === stored) callback();
    else if (pw !== null) alert('비밀번호가 틀렸습니다.');
  }
}

function renderCaseList() {
  const cases = loadCases();
  const container = document.getElementById('caseList');
  const empty = document.getElementById('caseEmpty');
  const stats = document.getElementById('caseStats');
  const search = (document.getElementById('caseSearch')?.value||'').toLowerCase();
  const sortBy = document.getElementById('caseSort')?.value || 'date';

  if (!container) return;

  let filtered = cases;
  if (search) {
    filtered = cases.filter(c => {
      const text = [c.hospital, c.mrn, c.patId, c.memo, c.dx, c.scenario, c.micro, c.date].join(' ').toLowerCase();
      return text.includes(search);
    });
  }

  // Sort
  filtered.sort((a, b) => {
    if (sortBy === 'date') return (b.date||'').localeCompare(a.date||'');
    if (sortBy === 'micro') return (a.micro||'').localeCompare(b.micro||'');
    if (sortBy === 'scenario') return (a.scenario||'').localeCompare(b.scenario||'');
    if (sortBy === 'dx') return (a.dx||'').localeCompare(b.dx||'');
    return 0;
  });

  if (stats) stats.textContent = `총 ${cases.length}건${search?` (필터: ${filtered.length}건)`:''}`;

  if (!filtered.length) {
    container.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  container.innerHTML = filtered.map(c => `
    <div class="case-card" data-id="${c.id}">
      <div class="case-header">
        <span class="case-id">${c.hospital?c.hospital+' ':''}${c.mrn?'#'+c.mrn+' ':''}${c.patId || '익명'} ${c.sex?'('+c.sex+(c.age?'/'+c.age:'')+')':''}</span>
        <span class="case-date">${c.date||'날짜없음'}</span>
      </div>
      <div class="case-tags">
        <span class="case-tag ${c.micro}">${c.micro||''}</span>
        <span class="case-tag">${c.model||''}</span>
        <span class="case-tag">${c.scenario||''}</span>
        <span class="case-tag">${c.dx||''}</span>
        <span class="case-tag">${c.cps?'CPS '+c.cps:''}</span>
      </div>
      <div class="case-summary">
        ${c.model==='Partition'?`Tumor ${c.desiredDose||'—'}Gy | A: ${c.r1_activity||'—'} | Prescribed: ${c.prescribedA?c.prescribedA+'GBq':'—'}`:
        `Dose ${c.desiredDose||'—'}Gy | Vol ${c.targetVol||'—'}cc | A: ${c.activity||'—'}`}
        ${c.memo?` | ${c.memo}`:''}
      </div>
      <div class="case-actions">
        <button class="case-action-btn case-load-btn" data-id="${c.id}">불러오기</button>
        <button class="case-action-btn danger case-del-btn" data-id="${c.id}">삭제</button>
      </div>
    </div>
  `).join('');

  // Event: load case
  container.querySelectorAll('.case-load-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const caseData = cases.find(c => c.id === btn.dataset.id);
      if (caseData) loadCaseToTab(caseData);
    });
  });

  // Event: delete case
  container.querySelectorAll('.case-del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      checkPassword('삭제', () => {
        const updated = cases.filter(c => c.id !== btn.dataset.id);
        saveCases(updated);
        renderCaseList();
      });
    });
  });
}

function loadCaseToTab(c) {
  if (c.model === 'Partition') {
    // Switch to partition tab
    document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc=>tc.classList.remove('active'));
    document.querySelector('[data-tab="partition"]').classList.add('active');
    document.getElementById('tab-partition').classList.add('active');
    // Fill values
    const fields = {p_hospital:'hospital',p_mrn:'mrn',p_liverVol:'liverVol',p_tumorVol:'tumorVol',p_wholeVol:'wholeVol',p_tn:'tn',p_lsf:'lsf',p_lungMass:'lungMass',p_desiredDose:'desiredDose',p_liverLimit:'liverLimit',p_lungLimit:'lungLimit',p_prescribedA:'prescribedA',p_cps:'cps',p_intent:'intent',p_scenario:'scenario',p_memo:'memo',p_patId:'patId',p_sex:'sex',p_age:'age',p_dx:'dx',p_date:'date'};
    Object.entries(fields).forEach(([elId, key]) => {
      const el = document.getElementById(elId);
      if (el && c[key]) el.value = c[key];
    });
    // Set micro
    tabMicro.partition = c.micro || 'resin';
    document.querySelectorAll('.micro-btn[data-parent="partition"]').forEach(b => b.classList.toggle('active', b.dataset.micro === tabMicro.partition));
    calcPartitionAll();
  } else {
    // Switch to MIRD tab
    document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc=>tc.classList.remove('active'));
    document.querySelector('[data-tab="mird"]').classList.add('active');
    document.getElementById('tab-mird').classList.add('active');
    const fields = {m_hospital:'hospital',m_mrn:'mrn',m_targetVol:'targetVol',m_desiredDose:'desiredDose',m_lsf:'lsf',m_residual:'residual',m_lungMass:'lungMass',m_prevLung:'prevLung',m_cps:'cps',m_intent:'intent',m_scenario:'scenario',m_memo:'memo',m_patId:'patId',m_sex:'sex',m_age:'age',m_dx:'dx',m_date:'date'};
    Object.entries(fields).forEach(([elId, key]) => {
      const el = document.getElementById(elId);
      if (el && c[key]) el.value = c[key];
    });
    tabMicro.mird = c.micro || 'glass';
    document.querySelectorAll('.micro-btn[data-parent="mird"]').forEach(b => b.classList.toggle('active', b.dataset.micro === tabMicro.mird));
    calcMIRDAll();
  }
}
const tabMicro = { partition:'resin', mird:'glass', simplicity:'resin' };
const tabScenario = { partition:'segmentectomy', mird:'segmentectomy', simplicity:'segmentectomy' };

// ====== Dose Guides (journal refs) ======
const GUIDES = {
  resin: [
    ['RS Tumor (optimal)', '≥300 Gy', 'Hermann 2024, Radiology'],
    ['RS Tumor (min)', '≥250 Gy', 'NCT04172714'],
    ['Lobectomy (Partition)', '≥250 Gy', 'NCT04172714'],
    ['Lobectomy (MIRD)', '≥100 Gy', 'Hermann 2020, Radiology'],
    ['HCC OR / CR', '≥176 / ≥247 Gy', 'Vouche 2023, JVIR'],
    ['NTAD safe', '<40 Gy', 'Strigari 2010, JNM (TD50 52)'],
    ['Lung (Korean)', '<15 Gy/session', 'KLCA Guideline'],
  ],
  glass: [
    ['RS Perfused', '≥400 Gy', 'Salem 2021, J Hepatol (LEGACY)'],
    ['Lobectomy Tumor', '>205, ideally >250 Gy', 'Garin 2021, Lancet Gastro'],
    ['HCC OR / CR', '≥290 / ≥481 Gy', 'Vouche 2023, JVIR'],
    ['NTAD Lobectomy', '<120 Gy', '2022 EJNMMI Consensus'],
    ['NTAD (whole liver)', '<75 Gy', '2025 EJNMMI Expert'],
    ['Lung (Korean M/F)', '<25/<20 Gy', 'KLCA Guideline'],
  ],
};

const SCENARIO_GUIDES = {
  resin: {
    segmentectomy: [['Tumor (optimal)','≥300 Gy','Hermann 2024'],['Tumor (min)','≥250 Gy','NCT04172714'],['MIRD enough','','Salem 2021'],['Lung','<15 Gy','KLCA']],
    lobectomy: [['Tumor (Partition)','≥250 Gy','NCT04172714'],['Tumor (MIRD)','≥100 Gy','Hermann 2020'],['NTAD','~70 Gy','Strigari 2010'],['Lung','<15 Gy','KLCA']],
    largeHCC: [['Tumor','100~157 Gy','Hermann 2020/Doyle'],['STRATUM','150 Gy','NCT03000439'],['NTAD','<40~70 Gy','Strigari 2010'],['Lung','<15 Gy','KLCA']],
    unilobar: [['Tumor','≥250 Gy','NCT04172714'],['NTAD','40~70 Gy','Strigari/CIRT'],['MIRD','≥150 Gy','STRATUM'],['Lung','<15 Gy','KLCA']],
    bilobar: [['Tumor','>100 Gy','Hermann 2020'],['NTAD','<40 Gy','Strigari 2010'],['Lung','<15 Gy','KLCA']],
    pvt: [['Tumor','>100 Gy','Hermann 2020'],['NTAD CPS A','>70 Gy','Strigari/CIRT'],['NTAD CPS B','40~70 Gy','Strigari'],['Lung','<15 Gy','KLCA']],
  },
  glass: {
    segmentectomy: [['Perfused','≥400 Gy','Salem 2021 LEGACY'],['Necrosis','400 Gy','LEGACY'],['MIRD enough','','Salem 2021'],['Lung M/F','<25/<20 Gy','KLCA']],
    lobectomy: [['Tumor (Partition)','>205, ideally >250','Garin 2021 DOSISPHERE'],['Tumor (MIRD)','>150 Gy','Garin 2021'],['NTAD','<120 Gy','2022 EJNMMI'],['Lung M/F','<25/<20 Gy','KLCA']],
    largeHCC: [['Tumor','>205 (pref 250)','Garin 2021'],['NTAD','<120 Gy','2022 EJNMMI'],['Reserve','>30%','2022 EJNMMI'],['Lung M/F','<25/<20 Gy','KLCA']],
    unilobar: [['Tumor','>205 (ideal 250)','Garin 2021'],['NTAD CPS A','<100 Gy','2022 EJNMMI'],['NTAD CPS B','<70 Gy','2022 EJNMMI'],['Lung M/F','<25/<20 Gy','KLCA']],
    bilobar: [['Tumor','>205 (ideal 250)','Garin 2021'],['NTAD CPS A','40~70 Gy','2022 EJNMMI'],['Lung M/F','<25/<20 Gy','KLCA']],
    pvt: [['Tumor','>205 (ideal 250)','Garin 2021'],['NTAD','<120 Gy','2022 EJNMMI'],['NTAD CPS B','<70 Gy','2022 EJNMMI'],['Lung M/F','<25/<20 Gy','KLCA']],
  }
};

function renderGuide(containerId, micro, scenario) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const g = (SCENARIO_GUIDES[micro]||{})[scenario||'segmentectomy'] || GUIDES[micro] || [];
  el.innerHTML = g.map(r => `<div class="dose-guide-row"><span class="dose-guide-scenario">${r[0]}</span><span class="dose-guide-dose">${r[1]}</span></div><div style="font-size:10px;color:var(--dim);padding:0 0 3px 8px">${r[2]}</div>`).join('');
}

// ====== Scenario-based Safety Evaluation ======
const SAFETY_THRESHOLDS = {
  resin: {
    segmentectomy: { tumorOpt:300, tumorMin:250, ntadMax:null, lungMax:15, tumorRef:'Hermann 2024', ntadRef:'Ablation intent', lungRef:'KLCA' },
    lobectomy: { tumorOpt:250, tumorMin:100, ntadMax:70, lungMax:15, tumorRef:'NCT04172714/SARAH', ntadRef:'Strigari 2010', lungRef:'KLCA' },
    largeHCC: { tumorOpt:157, tumorMin:100, ntadMax:70, wlMax:40, lungMax:15, tumorRef:'Hermann 2020/Doyle', ntadRef:'Strigari 2010', lungRef:'KLCA' },
    unilobar: { tumorOpt:250, tumorMin:150, ntadMax:70, lungMax:15, tumorRef:'NCT04172714/STRATUM', ntadRef:'Strigari/CIRT', lungRef:'KLCA' },
    bilobar: { tumorOpt:150, tumorMin:100, ntadMax:40, wlMax:40, lungMax:15, tumorRef:'Hermann 2020', ntadRef:'Strigari 2010', lungRef:'KLCA' },
    pvt: { tumorOpt:150, tumorMin:100, ntadMax:70, lungMax:15, tumorRef:'Hermann 2020', ntadRef:'Strigari/CIRT', lungRef:'KLCA' },
  },
  glass: {
    segmentectomy: { tumorOpt:400, tumorMin:400, ntadMax:null, lungMax:25, tumorRef:'LEGACY 2021', ntadRef:'Ablation intent', lungRef:'KLCA' },
    lobectomy: { tumorOpt:250, tumorMin:205, ntadMax:120, lungMax:25, tumorRef:'DOSISPHERE-01', ntadRef:'2022 EJNMMI', lungRef:'KLCA' },
    largeHCC: { tumorOpt:250, tumorMin:205, ntadMax:120, wlMax:75, lungMax:25, tumorRef:'DOSISPHERE-01', ntadRef:'2022 EJNMMI', lungRef:'KLCA' },
    unilobar: { tumorOpt:250, tumorMin:205, ntadMax:100, lungMax:25, tumorRef:'DOSISPHERE-01', ntadRef:'2022 EJNMMI', lungRef:'KLCA' },
    bilobar: { tumorOpt:250, tumorMin:205, ntadMax:70, lungMax:25, tumorRef:'DOSISPHERE-01', ntadRef:'2022 EJNMMI', lungRef:'KLCA' },
    pvt: { tumorOpt:250, tumorMin:205, ntadMax:120, lungMax:25, tumorRef:'DOSISPHERE-01', ntadRef:'2022 EJNMMI', lungRef:'KLCA' },
  }
};

function evalSafety(micro, tumorDose, ntad, wlNtad, lungDose, lsf, scenario, cps) {
  const items = [];
  const th = (SAFETY_THRESHOLDS[micro]||{})[scenario||'segmentectomy'] || SAFETY_THRESHOLDS[micro]?.segmentectomy;
  if (!th) return items;

  // CPS-adjusted NTAD for PVT/unilobar
  let ntadLimit = th.ntadMax;
  if ((scenario==='pvt'||scenario==='unilobar') && cps==='B') {
    ntadLimit = micro==='resin' ? 50 : 70; // stricter for CPS B
  }

  // Tumor dose
  const td = tumorDose || 0;
  items.push({
    icon: td>=th.tumorOpt?'✅':td>=th.tumorMin?'⚠️':'❌',
    text: `Tumor ${td.toFixed(1)} Gy (optimal ≥${th.tumorOpt}, min ≥${th.tumorMin})`,
    ref: th.tumorRef
  });

  // NTAD
  if (ntad!=null && ntadLimit!=null) {
    items.push({
      icon: ntad<=ntadLimit?'✅':ntad<=52?'⚠️':'❌',
      text: `NTAD ${ntad.toFixed(1)} Gy (${scenario} limit <${ntadLimit}${cps==='B'?' CPS B':''})`,
      ref: th.ntadRef
    });
  } else if (ntad!=null && ntadLimit==null) {
    items.push({ icon: '✅', text: `NTAD ${ntad.toFixed(1)} Gy (ablation intent — 제한 없음)`, ref: th.ntadRef });
  }

  // WL NTAD
  const wlMax = th.wlMax || 40;
  if (wlNtad!=null) {
    items.push({
      icon: wlNtad<=wlMax?'✅':wlNtad<=52?'⚠️':'❌',
      text: `WL NTAD ${wlNtad.toFixed(1)} Gy (safe <${wlMax}, TD50 52)`,
      ref: 'Strigari 2010'
    });
  }

  // Lung
  if (lungDose!=null) {
    items.push({
      icon: lungDose<=th.lungMax?'✅':lungDose<=30?'⚠️':'❌',
      text: `Lung ${lungDose.toFixed(1)} Gy (Korean <${th.lungMax})`,
      ref: th.lungRef
    });
  }

  // LSF
  if (lsf!=null) items.push({ icon: lsf<=10?'✅':lsf<=20?'⚠️':'❌', text: `LSF ${lsf.toFixed(1)}%`, ref:'' });

  return items;
}

function renderSafety(containerId, items, scenario) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!items.length) { el.innerHTML=''; return; }
  const scenarioNames = {segmentectomy:'RS',lobectomy:'Lobectomy',largeHCC:'Large HCC',unilobar:'MF Unilobar',bilobar:'MF Bilobar',pvt:'MVI/PVT'};
  const label = scenarioNames[scenario] || scenario || '';
  el.innerHTML = `<div class="card"><h3>안전성 평가 — ${label}${containerId.includes('partition')?' (④ Prescribed 기준)':''}</h3>${items.map(s=>`<div class="safety-item"><span class="safety-icon">${s.icon}</span><div><div class="safety-text">${s.text}</div>${s.ref?`<div class="safety-ref">${s.ref}</div>`:''}</div></div>`).join('')}</div>`;
}

function renderCases(containerId, micro) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!REFS.cases) { el.innerHTML=''; return; }
  const m = micro==='resin'?'Resin':'Glass';
  const cases = REFS.cases.filter(c=>!c.Microsphere||c.Microsphere===m||c.Microsphere==='Both'||c.Microsphere==='?'||c.Microsphere==='N/A').slice(0,3);
  if (!cases.length) { el.innerHTML=''; return; }
  el.innerHTML = `<div class="card"><h3>⚠️ 유사 사례 주의</h3>${cases.map(c=>`<div class="warning-card"><div class="ref-title">${c.Title||''}</div><div class="ref-meta">${c.PMID?'PMID '+c.PMID+' | ':''}${c.Year||''} ${c.Journal||''}</div><div class="ref-finding">${c.Complication||''}</div></div>`).join('')}</div>`;
}

// ====== PARTITION TAB — Real-time calc ======
function calcPartitionAll() {
  const micro = tabMicro.partition;
  const V = parseFloat(document.getElementById('p_liverVol').value) || 0;
  const Vt = parseFloat(document.getElementById('p_tumorVol').value) || 0;
  const Vw = parseFloat(document.getElementById('p_wholeVol').value) || 0;
  const TN = parseFloat(document.getElementById('p_tn').value) || 0;
  const LSF = parseFloat(document.getElementById('p_lsf').value) || 0;
  const Lm = parseFloat(document.getElementById('p_lungMass').value) || 800;
  const Vn = V - Vt;

  if (!V || !Vt || !TN || LSF<0) return;

  // ① Desired tumor dose
  const Dt = parseFloat(document.getElementById('p_desiredDose').value) || 0;
  const Dn1 = Dt / TN;
  const Dp1 = (Vt*Dt + Vn*Dn1) / V;
  const A1 = (Dp1 * V) / (C * (1 - LSF/100));
  const Dl1 = (A1 * C * (LSF/100)) / Lm;
  set('p_r1_normal', Dn1.toFixed(1)+' Gy', Dn1<=40?'safe':Dn1<=52?'warn':'danger');
  set('p_r1_lung', Dl1.toFixed(2)+' Gy', Dl1<=(micro==='resin'?15:25)?'safe':'warn');
  set('p_r1_activity', A1.toFixed(3)+' GBq', 'highlight');

  // ② Liver limiting
  const LL = parseFloat(document.getElementById('p_liverLimit').value) || 70;
  const Dt2 = LL * TN;
  const Dp2 = (Vt*Dt2 + Vn*LL) / V;
  const A2 = (Dp2 * V) / (C * (1 - LSF/100));
  const Dl2 = (A2 * C * (LSF/100)) / Lm;
  set('p_r2_tumor', Dt2.toFixed(1)+' Gy');
  set('p_r2_lung', Dl2.toFixed(2)+' Gy');
  set('p_r2_activity', A2.toFixed(3)+' GBq');

  // ③ Lung limiting
  const LungL = parseFloat(document.getElementById('p_lungLimit').value) || 25;
  const A3 = (LungL * Lm) / (C * (LSF/100));
  const Dp3 = (A3 * C * (1-LSF/100)) / V;
  const Dt3 = Dp3 * TN * V / (TN*Vt + Vn);
  const Dn3 = Dt3 / TN;
  set('p_r3_normal', Dn3.toFixed(1)+' Gy');
  set('p_r3_tumor', Dt3.toFixed(1)+' Gy');
  set('p_r3_activity', A3.toFixed(3)+' GBq');

  // ④ Prescribed activity
  const A4 = parseFloat(document.getElementById('p_prescribedA').value) || 0;
  let safetyTumor = Dt, safetyNtad = Dn1, safetyLung = Dl1;
  if (A4 > 0) {
    const Dp4 = (A4 * C * (1-LSF/100)) / V;
    const Dt4 = Dp4 * TN * V / (TN*Vt + Vn);
    const Dn4 = Dt4 / TN;
    const Dl4 = (A4 * C * (LSF/100)) / Lm;
    set('p_r4_tumor', Dt4.toFixed(1)+' Gy');
    set('p_r4_normal', Dn4.toFixed(1)+' Gy');
    set('p_r4_lung', Dl4.toFixed(2)+' Gy');
    // Use prescribed values for safety evaluation
    safetyTumor = Dt4;
    safetyNtad = Dn4;
    safetyLung = Dl4;
  }

  // WL NTAD (based on safety values — prescribed if available, otherwise desired)
  let wlNtad = null;
  if (Vw > 0) {
    const totalNormal = Vw - Vt;
    wlNtad = (Vn * safetyNtad) / totalNormal;
  }

  // Safety — rendered on button click
  const pScenario = document.getElementById('p_scenario')?.value || 'segmentectomy';
  const pCps = document.getElementById('p_cps')?.value || 'A';
  window._partitionSafety = { micro, safetyTumor, safetyNtad, wlNtad, safetyLung, LSF, scenario: pScenario, cps: pCps };
}

// MAA auto-calc
function calcMAA() {
  const R = parseFloat(document.getElementById('p_maaR')?.value) || 0;
  const L = parseFloat(document.getElementById('p_maaL')?.value) || 0;
  const lung = R + L;
  const liver = parseFloat(document.getElementById('p_maaLiver')?.value) || 0;
  const tumor = parseFloat(document.getElementById('p_maaTumor')?.value) || 0;
  const Vt = parseFloat(document.getElementById('maa_tumorVol')?.value) || 0;
  const V = parseFloat(document.getElementById('maa_liverVol')?.value) || 0;

  // Display totals
  set('p_maaLungTotal', lung>0?lung.toFixed(1):'—');
  const normalCounts = liver>0&&tumor>0?liver-tumor:0;
  set('p_maaNormal', normalCounts>0?normalCounts.toFixed(0):'—');
  set('p_normalVol', V>0&&Vt>0?(V-Vt).toFixed(1):'—');

  if (lung>0 && liver>0 && tumor>0 && Vt>0 && V>0) {
    const Vn = V - Vt;
    const tn = (tumor/Vt) / (normalCounts/Vn);
    const lsf = (lung / (lung + liver)) * 100;
    set('p_maaTN', tn.toFixed(2));
    set('p_maaLSF', lsf.toFixed(2)+'%');
  }
}

// ====== MIRD TAB — Real-time calc + Time Table ======
function calcMIRDAll() {
  const micro = tabMicro.mird;
  const Vt = parseFloat(document.getElementById('m_targetVol').value) || 0;
  const Dd = parseFloat(document.getElementById('m_desiredDose').value) || 0;
  const LSF = parseFloat(document.getElementById('m_lsf').value) || 0;
  const res = parseFloat(document.getElementById('m_residual').value) || 0;
  const Lm = parseFloat(document.getElementById('m_lungMass').value) || 1000;
  const prevLung = parseFloat(document.getElementById('m_prevLung').value) || 0;

  if (!Vt || !Dd) return;

  const mass = Vt * 1.03 / 1000; // kg
  const A = (Dd * mass) / (49.67 * (1-LSF/100) * (1-res/100));
  const lungD = (A * 49.67 * (LSF/100)) / (Lm/1000);
  const cumLung = lungD + prevLung;
  const lungLimit = micro==='glass'?30:15;

  set('m_mass', mass.toFixed(4)+' kg');
  set('m_activity', A.toFixed(3)+' GBq', 'highlight');
  set('m_lungDose', lungD.toFixed(2)+' Gy', lungD<=lungLimit?'safe':'danger');
  set('m_cumLung', cumLung.toFixed(2)+' Gy', cumLung<=50?'safe':'danger');
  set('m_lungStatus', lungD<=lungLimit?'✅ Within limit':'❌ Exceeds limit');

  // Set dose size slider to closest standard size
  const sizes = [3,5,7,10,12,15,20];
  const closest = sizes.reduce((a,b)=>Math.abs(b-A)<Math.abs(a-A)?b:a);
  document.getElementById('m_doseSize').value = closest;
  document.getElementById('m_doseSizeNum').value = closest;

  buildTimeTable();

  const mScenario = document.getElementById('m_scenario')?.value || 'segmentectomy';
  const mCps = document.getElementById('m_cps')?.value || 'A';
  const safety = evalSafety(micro, Dd, null, null, lungD, LSF, mScenario, mCps);
  renderSafety('mirdSafety', safety, mScenario);
  renderCases('mirdCases', micro);
}

function buildTimeTable() {
  const el = document.getElementById('mirdTimeTable');
  if (!el) return;
  const vol = parseFloat(document.getElementById('m_targetVol')?.value) || 0;
  const desiredDose = parseFloat(document.getElementById('m_desiredDose')?.value) || 150;
  const lsf = parseFloat(document.getElementById('m_lsf')?.value) || 0;
  const res = parseFloat(document.getElementById('m_residual')?.value) || 0;
  const sz = parseFloat(document.getElementById('m_doseSizeNum')?.value) || 3;

  if (!vol) { el.innerHTML='<div class="empty-state">Target Volume을 입력하세요</div>'; return; }

  const mass = vol * 1.03 / 1000;
  const hl = 64.1;
  const lambda = Math.log(2) / hl;
  const tzOff = 14;

  const days = ['Sun(Cal)','Mon','Tue','Wed','Thu','Fri','Sat','Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const times = ['08:00','10:00','12:00','14:00','16:00','18:00','20:00'];

  let html = `<table class="time-table"><tr><th></th><th colspan="7" style="background:rgba(46,139,87,0.15);color:#2e8b57">Week 1</th><th colspan="7" style="background:rgba(30,144,255,0.1);color:#1e90ff">Week 2</th></tr><tr><th>Time</th>`;
  days.forEach(d => html += `<th>${d}</th>`);
  html += '</tr>';

  for (const t of times) {
    html += `<tr><td class="row-header">${t}</td>`;
    const [h] = t.split(':').map(Number);
    for (let di = 0; di < days.length; di++) {
      if (di === 0) { html += '<td style="color:var(--dim)">Cal</td>'; continue; }
      const hrs = di * 24 + (h - 12) + tzOff;
      if (hrs <= 0) { html += '<td>-</td>'; continue; }
      const decA = sz * Math.exp(-lambda * hrs);
      const dose = (decA * 49.67 * (1 - lsf/100) * (1 - res/100)) / mass;
      const pctDiff = Math.abs(dose - desiredDose) / desiredDose;
      const cls = pctDiff < 0.05 ? 'highlight' : pctDiff < 0.15 ? 'highlight' : '';
      html += `<td class="${cls}">${dose.toFixed(0)}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  el.innerHTML = html;
}

// ====== SIMPLICITY TAB — Evaluate inputs ======
function calcSimplicityAll() {
  const micro = tabMicro.simplicity;
  const td = parseFloat(document.getElementById('s_tumorDose').value);
  const ntad = parseFloat(document.getElementById('s_ntad').value);
  const wlNtad = parseFloat(document.getElementById('s_wlNtad').value);
  const ld = parseFloat(document.getElementById('s_lungDose').value);
  const pf = parseFloat(document.getElementById('s_perfFrac').value);

  const sScenario = document.querySelector('#tab-simplicity .scenario-tab.active')?.dataset?.scenario || 'segmentectomy';
  const safety = evalSafety(micro, td||0, isNaN(ntad)?null:ntad, isNaN(wlNtad)?null:wlNtad, isNaN(ld)?null:ld, null, sScenario);
  renderSafety('simplicitySafety', safety, sScenario);
  renderCases('simplicityCases', micro);
}

// ====== Helpers ======
function set(id, val, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.className = 'sheet-auto' + (cls ? ' '+cls : '');
}

// ====== References Tab ======
function renderRefs() {
  const container = document.getElementById('refsList');
  if (!container) return;
  const search = (document.getElementById('refSearch')?.value||'').toLowerCase();
  const filter = document.getElementById('refFilter')?.value||'all';
  const micro = document.getElementById('refMicro')?.value||'all';

  let items = [];
  if (filter==='all'||filter==='threshold') REFS.thresholds.forEach(r=>items.push({...r,_type:'threshold'}));
  if (filter==='all'||filter==='case') REFS.cases.forEach(r=>items.push({...r,_type:'case'}));
  if (micro!=='all') items = items.filter(r=>(r.Microsphere||'')=== micro||(r.Microsphere||'')==='Both'||!r.Microsphere);
  if (search) items = items.filter(r=>JSON.stringify(r).toLowerCase().includes(search));

  container.innerHTML = items.length===0?'<div class="empty-state">검색 결과 없음</div>':items.map(r=>{
    const isCase = r._type==='case';
    return `<div class="${isCase?'warning-card':'ref-card'}"><div class="ref-title">${r.Title||''}</div><div class="ref-meta">${r.PMID?'PMID '+r.PMID+' | ':''}${r.Year||''} ${r.Journal||''}</div><div class="ref-finding">${r['Key Finding']||r.Complication||''}</div><div class="ref-tags"><span class="ref-tag ${isCase?'case':''}">${isCase?'Case':'Threshold'}</span>${r.Microsphere?`<span class="ref-tag">${r.Microsphere}</span>`:''}</div></div>`;
  }).join('');
}

// ====== Init ======
function init() {
  // Main tabs — hide partition safety when switching away
  document.querySelectorAll('.tabs .tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc=>tc.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      // Reset eval button and hide safety on tab switch
      const ps = document.getElementById('partitionSafety');
      const pc = document.getElementById('partitionCases');
      const eb = document.getElementById('partitionEvalBtn');
      if(ps) ps.style.display='none';
      if(pc) pc.style.display='none';
      if(eb) eb.textContent='안전성 평가 ▼';
      if(tab.dataset.tab==='refs') renderRefs();
      if(tab.dataset.tab==='cases') renderCaseList();
    });
  });

  // Micro toggles per tab
  document.querySelectorAll('.micro-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const parent = btn.dataset.parent;
      document.querySelectorAll(`.micro-btn[data-parent="${parent}"]`).forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      tabMicro[parent] = btn.dataset.micro;
      renderGuide(parent+'Guide', btn.dataset.micro, tabScenario[parent]);
      if(parent==='partition') { document.getElementById('p_liverLimit').value=btn.dataset.micro==='resin'?70:120; document.getElementById('p_lungLimit').value=btn.dataset.micro==='resin'?15:25; calcPartitionAll(); }
      if(parent==='mird') calcMIRDAll();
      if(parent==='simplicity') calcSimplicityAll();
    });
  });

  // Scenario tabs per tab
  document.querySelectorAll('.scenario-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      const parent = tab.dataset.parent;
      document.querySelectorAll(`.scenario-tab[data-parent="${parent}"]`).forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      tabScenario[parent] = tab.dataset.scenario;
      renderGuide(parent+'Guide', tabMicro[parent], tab.dataset.scenario);
    });
  });

  // Partition inputs — live calc
  ['p_liverVol','p_tumorVol','p_wholeVol','p_tn','p_lsf','p_lungMass','p_desiredDose','p_liverLimit','p_lungLimit','p_prescribedA'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', calcPartitionAll);
  });
  // Partition volume inputs also trigger calc
  ['p_liverVol','p_tumorVol'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', calcPartitionAll);
  });

  // MIRD inputs
  ['m_targetVol','m_desiredDose','m_lsf','m_residual','m_lungMass','m_prevLung'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', calcMIRDAll);
  });

  // Simplicity inputs
  ['s_activity','s_tumorDose','s_perfDose','s_ntad','s_wlNtad','s_lungDose','s_perfFrac','s_perfVol','s_tumorVol','s_wholeVol'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', calcSimplicityAll);
  });

  // Save buttons
  const pSaveBtn = document.getElementById('partitionSaveBtn');
  if(pSaveBtn) pSaveBtn.addEventListener('click',()=>{
    savePartitionCase();
    alert('케이스가 저장되었습니다!');
  });
  const mSaveBtn = document.getElementById('mirdSaveBtn');
  if(mSaveBtn) mSaveBtn.addEventListener('click',()=>{
    saveMIRDCase();
    alert('케이스가 저장되었습니다!');
  });

  // Show save card after eval
  // Partition eval button
  const evalBtn = document.getElementById('partitionEvalBtn');
  if(evalBtn) evalBtn.addEventListener('click',()=>{
    calcPartitionAll();
    const d = window._partitionSafety;
    if(d) {
      const safety = evalSafety(d.micro, d.safetyTumor, d.safetyNtad, d.wlNtad, d.safetyLung, d.LSF, d.scenario, d.cps);
      renderSafety('partitionSafety', safety, d.scenario);
      renderCases('partitionCases', d.micro);
    }
    document.getElementById('partitionSafety').style.display = 'block';
    document.getElementById('partitionCases').style.display = 'block';
    const saveCard = document.getElementById('partitionSaveCard');
    if(saveCard) saveCard.style.display = 'block';
    // Set today's date
    const dateEl = document.getElementById('p_date');
    if(dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0,10);
    evalBtn.textContent = '안전성 평가 ▲';
  });

  // Scenario select → highlight scenario tab
  ['p_scenario','m_scenario'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('change',()=>{
      const parent = id.startsWith('p_')?'partition':'mird';
      const scenario = el.value;
      tabScenario[parent] = scenario;
      document.querySelectorAll(`.scenario-tab[data-parent="${parent}"]`).forEach(t=>{
        t.classList.toggle('active', t.dataset.scenario===scenario);
      });
      renderGuide(parent+'Guide', tabMicro[parent], scenario);
    });
  });

  // Gender buttons for lung mass
  document.querySelectorAll('.gender-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.gender-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('p_lungMass').value = btn.dataset.val;
      calcPartitionAll();
    });
  });

  // MAA tab: Apply to Partition
  const applyBtn = document.getElementById('applyMAA');
  if(applyBtn) applyBtn.addEventListener('click',()=>{
    const tn = document.getElementById('p_maaTN')?.textContent;
    const lsf = document.getElementById('p_maaLSF')?.textContent?.replace('%','');
    const lv = document.getElementById('maa_liverVol')?.value;
    const tv = document.getElementById('maa_tumorVol')?.value;
    if(tn&&tn!=='—') document.getElementById('p_tn').value = tn;
    if(lsf&&lsf!=='—') document.getElementById('p_lsf').value = lsf;
    if(lv) document.getElementById('p_liverVol').value = lv;
    if(tv) document.getElementById('p_tumorVol').value = tv;
    // Switch to Partition tab
    document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc=>tc.classList.remove('active'));
    document.querySelector('[data-tab="partition"]').classList.add('active');
    document.getElementById('tab-partition').classList.add('active');
    calcPartitionAll();
  });

  // MAA calc on input
  ['p_maaR','p_maaL','p_maaLiver','p_maaTumor','maa_liverVol','maa_tumorVol'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', calcMAA);
  });

  // MIRD dose size slider sync — prevent page scroll on touch
  const doseSlider = document.getElementById('m_doseSize');
  const doseNum = document.getElementById('m_doseSizeNum');
  if (doseSlider && doseNum) {
    doseSlider.addEventListener('input', () => { doseNum.value = doseSlider.value; buildTimeTable(); });
    doseNum.addEventListener('input', () => { doseSlider.value = doseNum.value; buildTimeTable(); });
    doseSlider.addEventListener('touchstart', (e) => { e.stopPropagation(); }, {passive:true});
  }

  // Refs
  ['refSearch','refFilter','refMicro'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) { el.addEventListener('input',renderRefs); el.addEventListener('change',renderRefs); }
  });

  // Case search/sort
  ['caseSearch','caseSort'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) { el.addEventListener('input',renderCaseList); el.addEventListener('change',renderCaseList); }
  });

  // Initial render
  renderGuide('partitionGuide','resin','segmentectomy');
  renderGuide('mirdGuide','glass','segmentectomy');
  renderGuide('simplicityGuide','resin','segmentectomy');
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
else init();
})();
