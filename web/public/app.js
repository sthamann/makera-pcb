// makera-pcb browser UI (module). The 3D viewer (three.js) is loaded lazily so
// the core 2D workflow never depends on it.

import { t, applyI18n, getLang, setLang } from './i18n.js';

// Makera standard PCB blanks (FR4 1.5 mm) + generic/custom options.
const MATERIAL_PRESETS = [
  { id: 'mk-ss-100x150', label: 'Makera 1,5 mm · einseitig · 100×150', thickness: 1.5, sizeX: 150, sizeY: 100, sides: 'single' },
  { id: 'mk-ss-150x200', label: 'Makera 1,5 mm · einseitig · 150×200', thickness: 1.5, sizeX: 200, sizeY: 150, sides: 'single' },
  { id: 'mk-ds-100x150', label: 'Makera 1,5 mm · doppelseitig · 100×150', thickness: 1.5, sizeX: 150, sizeY: 100, sides: 'double' },
  { id: 'mk-ds-150x200', label: 'Makera 1,5 mm · doppelseitig · 150×200', thickness: 1.5, sizeX: 200, sizeY: 150, sides: 'double' },
  { id: 'fr4-1.6', label: 'FR4 generisch · 1,6 mm', thickness: 1.6, sizeX: null, sizeY: null, sides: 'single' },
  { id: 'custom', label: 'Eigenes Material …', thickness: null, sizeX: null, sizeY: null, sides: 'single' },
];

// Feeds/speeds per tool type (Makera PCB table), used to backfill empty fields.
const TYPE_DEFAULTS = {
  vbit: { feedXY: 500, plungeFeed: 200, rpm: 12000 },
  drill: { feedXY: 1000, plungeFeed: 200, rpm: 10000, peck: 1.0 },
  endmill: { feedXY: 500, plungeFeed: 300, rpm: 12000 },
  laser: { feedXY: 100, plungeFeed: 0, rpm: 0 },
};
function withToolDefaults(t) {
  const d = TYPE_DEFAULTS[t.type] || {};
  return {
    collet: 2, ...t,
    feedXY: t.feedXY ?? d.feedXY,
    plungeFeed: t.plungeFeed ?? d.plungeFeed,
    rpm: t.rpm ?? d.rpm,
    peck: t.peck ?? d.peck,
  };
}

// Recommended feeds/speeds for the PCB column of the official Makera "Speeds &
// Feeds" table (wiki.makera.com/en/speeds-and-feeds). RPM / Feed(mm/min) /
// PFeed(plunge mm/min) / DOC(depth of cut mm). Used for the "Makera-PCB" preset.
const MAKERA_PCB_FEEDS = {
  vbit: { rpm: 12000, feedXY: 500, plungeFeed: 200, doc: 0.1 }, // 0.2/0.1mm engraving
  endmill: { rpm: 12000, feedXY: 500, plungeFeed: 300, doc: 0.3 }, // corn bits, area/contour
  drill: { rpm: 10000, feedXY: 1000, plungeFeed: 200, doc: 1.0 },
  solderMask: { rpm: 6000, feedXY: 400, plungeFeed: 200, doc: 0.2 }, // 0.3mm*30° remover
  laser: { rpm: 0, feedXY: 100, plungeFeed: 0, doc: 0 }, // silk on soldermask, 20% power
};
// Return the Makera PCB-table feeds/speeds for a given tool.
function makeraPcbFeeds(t) {
  if (t.type === 'laser') return { ...MAKERA_PCB_FEEDS.laser };
  const isRemover = /entferner|removal|solder\s*mask|no\.?5/i.test(t.label || '');
  const key = isRemover ? 'solderMask' : t.type;
  const f = MAKERA_PCB_FEEDS[key] || MAKERA_PCB_FEEDS.endmill;
  const out = { rpm: f.rpm, feedXY: f.feedXY, plungeFeed: f.plungeFeed };
  if (t.type === 'drill') out.peck = f.doc; // one bite ~ DOC for PCB drills
  return out;
}

// Full standard Carvera Air toolkit (bits & materials that ship with the Air).
// Feeds/speeds are the official Makera PCB-table recommendations.
const STANDARD_TOOLS = [
  { number: 1, type: 'vbit', diameter: 0.2, collet: 2, label: 'V-Bit 30° 0.2mm (Isolation)', feedXY: 500, plungeFeed: 200, rpm: 12000 },
  { number: 2, type: 'vbit', diameter: 0.1, collet: 2, label: 'V-Bit 60° 0.1mm (fein)', feedXY: 500, plungeFeed: 200, rpm: 12000 },
  { number: 3, type: 'drill', diameter: 0.8, collet: 2, label: 'PCB-Bohrer 0.8mm', feedXY: 1000, plungeFeed: 200, rpm: 10000, peck: 1.0 },
  { number: 4, type: 'drill', diameter: 1.0, collet: 2, label: 'PCB-Bohrer 1.0mm', feedXY: 1000, plungeFeed: 200, rpm: 10000, peck: 1.0 },
  { number: 5, type: 'drill', diameter: 1.2, collet: 2, label: 'PCB-Bohrer 1.2mm', feedXY: 1000, plungeFeed: 200, rpm: 10000, peck: 1.0 },
  { number: 6, type: 'endmill', diameter: 0.8, collet: 2, label: 'Corn-Bit 0.8mm (Flächen/Bohren/Kontur)', feedXY: 500, plungeFeed: 300, rpm: 12000 },
  { number: 7, type: 'endmill', diameter: 1.0, collet: 2, label: 'Einzahnfräser 1.0mm', feedXY: 500, plungeFeed: 300, rpm: 12000 },
  { number: 8, type: 'endmill', diameter: 2.0, collet: 2, label: 'Einzahnfräser 2.0mm', feedXY: 500, plungeFeed: 300, rpm: 12000 },
  { number: 9, type: 'endmill', diameter: 3.175, collet: 2, label: 'Corn-Bit 3.175mm (Kontur)', feedXY: 500, plungeFeed: 300, rpm: 12000 },
  { number: 10, type: 'endmill', diameter: 0.9, collet: 2, label: 'Lötstopplack-Entferner (No.5)', feedXY: 400, plungeFeed: 200, rpm: 6000 },
  { number: 11, type: 'laser', diameter: 0.1, collet: 2, label: 'Laser 5W (Silkscreen-Gravur)', feedXY: 100, plungeFeed: 0, rpm: 0 },
];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- persistence ----------
function loadJSON(key, def) { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } }
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function loadTools() {
  const saved = loadJSON('makera_tools', null);
  const base = saved && Array.isArray(saved) && saved.length ? saved : STANDARD_TOOLS;
  return base.map(withToolDefaults); // backfill missing feed/plunge/rpm
}

const state = {
  files: { copper: null, edge: null, drill: null, silk: null },
  result: null,
  view: '2d',
  viewer3d: null,
  layers: { copper: true, silk: true, isolation: true, drills: true, outline: true, laser: true, stock: true },
  tools: loadTools(),
  assignment: loadJSON('makera_assignment', {}),
  conns: loadJSON('makera_conns', []),
  machine: { connected: false, timer: null },
  demo: { playing: false, raf: null },
  aiHasServerKey: false,
  aiLastHash: null,
  fab: { steps: [], done: {}, active: null, dry: {}, view: null, anim: { raf: null, playing: false } },
  projectLog: [],
};

// ---------- per-project process log ----------
function logEvent(key, vars, level = 'info') {
  const entry = { ts: Date.now(), key, vars: vars || {}, level };
  state.projectLog.push(entry);
  if (state.projectLog.length > 500) state.projectLog.shift();
  // persist into the current project (if one is open)
  const cur = currentProjectId ? currentProjectId() : '';
  if (cur) { const projs = loadProjects(); if (projs[cur]) { projs[cur].log = state.projectLog; saveProjects(projs); } }
  renderLog();
}
function renderLog() {
  const el = $('#fabLog');
  if (!el) return;
  el.textContent = state.projectLog.map((e) => {
    const time = new Date(e.ts).toLocaleTimeString(getLang() === 'de' ? 'de-DE' : 'en-GB');
    const mark = e.level === 'error' ? '✗' : e.level === 'warn' ? '⚠' : '·';
    return `${time} ${mark} ${t(e.key, e.vars)}`;
  }).join('\n');
  el.scrollTop = el.scrollHeight;
}

const PATTERNS = {
  copper: [/f[_.]?cu/i, /\.gtl$/i],
  edge: [/edge[_.]?cuts/i, /\.gm1$/i, /\.gko$/i, /profile/i],
  drill: [/\.drl$/i, /-pth/i, /\.xln$/i],
  silk: [/f[_.]?silk/i, /\.gto$/i],
};

// ---------- files ----------
function detectRole(name) {
  for (const [role, pats] of Object.entries(PATTERNS)) if (pats.some((p) => p.test(name))) return role;
  return null;
}
function setFile(role, name, content) {
  state.files[role] = { name, content };
  const slot = $(`.slot[data-role="${role}"]`);
  slot.classList.add('filled');
  $('[data-name]', slot).textContent = name;
  $('#generate').disabled = !state.files.copper;
  scheduleGenerate();
}
async function handleFiles(fileList) {
  for (const file of fileList) {
    const content = await file.text();
    const role = detectRole(file.name) || guessByContent(content);
    if (role) setFile(role, file.name, content);
    else toast(t('files.unknown', { name: file.name }), true);
  }
}
function guessByContent(c) {
  if (/M48|T\d+C[\d.]+/.test(c) && !/%FS/.test(c)) return 'drill';
  if (/FileFunction,Profile/.test(c)) return 'edge';
  if (/Silkscreen|Legend/.test(c)) return 'silk';
  if (/FileFunction,Copper/.test(c)) return 'copper';
  return null;
}

// ---------- config ----------
function readConfig() {
  const cfg = {};
  for (const el of $$('[data-path]')) {
    const path = el.dataset.path;
    let val;
    if (el.type === 'checkbox') val = el.checked;
    else { val = el.value; if (el.type === 'number') { if (val === '') continue; val = Number(val); } }
    setDeep(cfg, path, val);
  }
  cfg.tools = state.tools;
  cfg.toolAssignment = state.assignment;
  cfg.useCollet = true;
  cfg.stock = cfg.stock || {};
  cfg.stock.material = $('#matPreset')?.value || 'custom';
  cfg.stock.sides = state.matSides || 'single';
  return cfg;
}
function setDeep(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) { cur[keys[i]] = cur[keys[i]] || {}; cur = cur[keys[i]]; }
  cur[keys[keys.length - 1]] = value;
}

// ---------- generate ----------
let genTimer = null;
function scheduleGenerate() {
  drawMaterialPreview(); // live material preview even before a board is loaded
  if (!state.files.copper) return;
  clearTimeout(genTimer);
  genTimer = setTimeout(generate, 350);
}
async function generate() {
  if (!state.files.copper) return;
  const body = {
    copper: state.files.copper?.content || null,
    edge: state.files.edge?.content || null,
    drill: state.files.drill?.content || null,
    silk: state.files.silk?.content || null,
    config: readConfig(),
  };
  try {
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('gen.error'));
    state.result = data;
    renderAll();
    const n = Object.keys(data.files).length;
    const combined = data.files['0_full_job.nc'] ? t('gen.combined') : '';
    toast(t('gen.ok', { n, combined }));
    logEvent('log.generated', { n });
    flashButton($('#generate'));
    maybeAutoReview();
  } catch (err) { toast(err.message, true); logEvent('log.genError', { msg: err.message }, 'error'); }
}

let autoReviewTimer = null;
function maybeAutoReview() {
  if (!$('#aiAuto').checked || !aiKeyAvailable() || !state.result) return;
  const hash = JSON.stringify(readConfig()) + JSON.stringify(state.result.board);
  if (hash === state.aiLastHash) return; // nothing meaningful changed
  clearTimeout(autoReviewTimer);
  autoReviewTimer = setTimeout(() => { state.aiLastHash = hash; aiReview(); }, 2000);
}

function flashButton(btn) {
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = t('btn.generated');
  btn.classList.add('ok-flash');
  setTimeout(() => { btn.textContent = old; btn.classList.remove('ok-flash'); }, 1300);
}

// ---------- rendering ----------
function renderAll() {
  if (state.fab.anim.playing) fabStop();
  $('#placeholder').classList.add('hidden');
  if (state.view === '3d') show3d(); else drawPreview();
  renderBoardInfo();
  renderChecks();
  renderDownloads();
  renderReport();
  renderAssignments();
  renderRunFiles();
  renderFab();
  drawMaterialPreview();
  updateActionButtons();
}

function updateActionButtons() {
  const has = !!state.result;
  $('#demoPlay').disabled = !has || state.demo.playing;
  $('#aiReview').disabled = !has || !aiKeyAvailable();
  const fp = $('#fabPlay'); if (fp) fp.disabled = !has;
}
function renderBoardInfo() {
  const r = state.result;
  const gap = r.stats.minCopperGap;
  const drills = r.stats.drillGroups.map((g) => `${g.holes}×${g.diameter.toFixed(2)}mm`).join(', ');
  $('#boardInfo').innerHTML = [
    `${t('info.board')} <b>${r.board.width.toFixed(2)} × ${r.board.height.toFixed(2)} mm</b>`,
    t('info.isoRings', { n: r.stats.isolationRings }),
    drills ? `${t('info.drill')} <b>${drills}</b>` : '',
    gap != null ? `${t('info.minGap')} <b>${gap.toFixed(3)} mm</b>` : '',
  ].filter(Boolean).join(' · ');
}
function renderChecks() {
  const body = $('[data-body="checks"]');
  body.innerHTML = state.result.checks.messages.map((m) => {
    const ico = m.level === 'error' ? '⛔' : m.level === 'warn' ? '⚠' : '✓';
    return `<div class="check ${m.level}"><span class="ico">${ico}</span><span>${escapeHtml(m.text)}</span></div>`;
  }).join('');
}
function renderDownloads() {
  const body = $('[data-body="downloads"]');
  const files = state.result.files;
  const rows = Object.entries(files).map(([name, content]) => {
    const kb = (content.length / 1024).toFixed(1);
    const badge = name.startsWith('0_') ? ` <span class="meta">· ${t('dl.oneFile')}</span>` : '';
    return `<div class="dl-row"><div><div class="fn">${name}${badge}</div><div class="meta">${kb} kB</div></div><button class="btn small" data-dl="${name}">${t('dl.download')}</button></div>`;
  }).join('');
  body.innerHTML = `<div class="dl-actions"><button class="btn primary small" id="zipAll">${t('dl.zip')}</button><button class="btn small" id="dlReport">${t('dl.report')}</button></div><div class="dl-list">${rows}</div>`;
  $$('[data-dl]', body).forEach((b) => b.addEventListener('click', () => downloadText(b.dataset.dl, files[b.dataset.dl])));
  $('#zipAll', body).addEventListener('click', downloadZip);
  $('#dlReport', body).addEventListener('click', () => downloadText('FAB-PLAN.md', fabPlanText()));
}
// Fabrication plan generated client-side from the (translated) guided steps, so
// it follows the current language instead of the German server report.
function fabPlanText() {
  const r = state.result;
  if (!r) return '';
  const steps = state.fab.steps.length ? state.fab.steps : buildFabSteps();
  const b = r.board;
  const out = [];
  out.push(`# makera-pcb · ${t('nav.fab').replace(/^[^A-Za-z]+/, '')}`);
  out.push('');
  out.push(`${t('info.board')}: ${b.width.toFixed(2)} × ${b.height.toFixed(2)} mm`);
  if (r.times?.total != null) out.push(`Σ ≈ ${fmtDur(r.times.total)} · ${t('fab.stepsShort', { n: steps.length })}`);
  out.push('');
  steps.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title}`);
    if (s.tool) out.push(`- ${t('step.toolPrefix')}: ${s.tool}`);
    if (s.est) out.push(`- ≈ ${fmtDur(s.est)}`);
    if (s.file) out.push(`- ${t('run.upload')}: \`${s.file}\``);
    if (s.instr) out.push(`- ${s.instr}`);
    out.push('');
  });
  return out.join('\n');
}
function renderReport() { $('[data-body="report"]').innerHTML = `<div class="report">${escapeHtml(fabPlanText())}</div>`; }

// ---------- tool library ----------
function renderTools() {
  const tb = $('#toolBody');
  tb.innerHTML = state.tools.map((t, i) => `
    <tr data-i="${i}">
      <td><input class="tnum" type="number" value="${t.number}" data-f="number" title="Werkzeug-/Slot-Nummer (M6 Txx)" /></td>
      <td><select data-f="type" title="vbit=Isolation, drill=Bohren, endmill=Fräsen/Kontur, laser=Gravur">
        ${['vbit', 'drill', 'endmill', 'laser'].map((o) => `<option value="${o}" ${t.type === o ? 'selected' : ''}>${o}</option>`).join('')}
      </select></td>
      <td><input class="tdia" type="number" step="0.05" value="${t.diameter}" data-f="diameter" title="Durchmesser (mm)" /></td>
      <td><select data-f="collet" title="Spannzange – Air-Standard S2 = 1/8″">${[1, 2, 3, 4, 5, 6].map((s) => `<option value="${s}" ${t.collet === s ? 'selected' : ''}>S${s}</option>`).join('')}</select></td>
      <td><input class="tnum" type="number" value="${t.feedXY ?? ''}" data-f="feedXY" title="Vorschub XY mm/min" /></td>
      <td><input class="tnum" type="number" value="${t.plungeFeed ?? ''}" data-f="plungeFeed" title="Plunge mm/min" /></td>
      <td><input class="tnum" type="number" value="${t.rpm ?? ''}" data-f="rpm" title="Drehzahl" /></td>
      <td><input type="text" value="${escapeHtml(t.label || '')}" data-f="label" /></td>
      <td><button class="rm" title="entfernen">×</button></td>
    </tr>`).join('');
  $$('#toolBody tr').forEach((tr) => {
    const i = Number(tr.dataset.i);
    $$('[data-f]', tr).forEach((inp) => inp.addEventListener('change', () => {
      const f = inp.dataset.f;
      let v = inp.value;
      if (['number', 'diameter', 'collet', 'feedXY', 'plungeFeed', 'rpm', 'peck'].includes(f)) v = v === '' ? null : Number(v);
      state.tools[i][f] = v;
      saveJSON('makera_tools', state.tools);
      renderAssignments();
      scheduleGenerate();
    }));
    $('.rm', tr).addEventListener('click', () => { state.tools.splice(i, 1); saveJSON('makera_tools', state.tools); renderTools(); renderAssignments(); scheduleGenerate(); });
  });
}
// Localised display title for a pipeline operation (server titles are German).
function opTitle(op) {
  if (op.id === 'isolation') return t('op.isolation');
  if (op.id.startsWith('drill')) return t('op.drill', { dia: op.diameter.toFixed(2) });
  if (op.id === 'outline') return t('op.outline');
  return op.title || op.id;
}
// Drop/repair assignments that point to a missing tool or the WRONG tool type
// (e.g. after the tool list changed a stored number can map to a V-bit for a
// drilling step). Auto-picks the nearest tool of the correct type.
function validateAssignments() {
  const ops = state.result?.operations || [];
  let changed = false;
  let toolsChanged = false;
  const nextNum = () => (state.tools.reduce((m, t) => Math.max(m, t.number), 0) || 0) + 1;
  for (const op of ops) {
    const cur = state.assignment[op.id];
    const tool = cur != null ? state.tools.find((x) => x.number === cur) : null;
    const typeOk = tool && tool.type === op.toolType;

    if (op.toolType === 'drill') {
      // A hole needs an EXACT-diameter drill. Reuse one if present, otherwise
      // create it (you genuinely need that bit) so the assignment always matches.
      const exactOf = (d) => state.tools.find((x) => x.type === 'drill' && Math.abs(x.diameter - d) <= 0.051);
      if (typeOk && Math.abs(tool.diameter - op.diameter) <= 0.051) continue; // already exact
      let bit = exactOf(op.diameter);
      if (!bit) {
        bit = withToolDefaults({ number: nextNum(), type: 'drill', diameter: Number(op.diameter.toFixed(2)), collet: 2, label: `PCB-Bohrer ${op.diameter.toFixed(2)}mm` });
        state.tools.push(bit); toolsChanged = true;
      }
      state.assignment[op.id] = bit.number; changed = true;
      continue;
    }

    if (typeOk) continue; // v-bit / end mill: any valid same-type tool is fine
    // wrong type / missing → nearest tool of the correct type
    const cands = state.tools.filter((x) => x.type === op.toolType);
    let best = null, bestD = Infinity;
    for (const x of cands) { const d = Math.abs(x.diameter - op.diameter); if (d < bestD) { bestD = d; best = x; } }
    if (best) { state.assignment[op.id] = best.number; changed = true; }
    else if (cur != null) { delete state.assignment[op.id]; changed = true; }
  }
  if (toolsChanged) { saveJSON('makera_tools', state.tools); renderTools(); }
  if (changed) saveJSON('makera_assignment', state.assignment);
  return changed;
}
function renderAssignments() {
  const box = $('#assignBox');
  const ops = state.result?.operations || [];
  if (!ops.length) { box.innerHTML = `<p class="muted">${t('tools.assignPlaceholder')}</p>`; return; }
  // Repaired a stale/wrong assignment? Regenerate so the G-code uses the fix.
  if (validateAssignments()) scheduleGenerate();
  const opts = (sel) => state.tools.map((tl) => `<option value="${tl.number}" ${Number(sel) === tl.number ? 'selected' : ''}>T${tl.number} · ${tl.type} ${tl.diameter}${tl.label ? ' · ' + escapeHtml(tl.label) : ''}</option>`).join('');
  box.innerHTML = `<div class="dl-actions"><button class="btn small" id="autoAssign">${t('tools.auto')}</button></div>` +
    ops.map((op) => {
      const cur = state.assignment[op.id];
      const un = cur == null ? ' unassigned' : '';
      // Warn when a drill hole gets a bit of a different diameter (no exact match).
      const tool = cur != null ? state.tools.find((x) => x.number === cur) : null;
      const mismatch = tool && op.toolType === 'drill' && Math.abs(tool.diameter - op.diameter) > 0.05
        ? `<span class="assign-warn" title="${t('tools.mismatchTitle')}">${t('tools.mismatch', { tool: tool.diameter, op: op.diameter.toFixed(2) })}</span>` : '';
      return `<div class="assign-row${un}"><span>${escapeHtml(opTitle(op))} <span class="meta">(${op.toolType} ${op.diameter.toFixed(2)}mm)</span></span>
        <select data-op="${op.id}"><option value="">${t('tools.none')}</option>${opts(cur)}</select>${mismatch}</div>`;
    }).join('');
  $('#autoAssign', box).addEventListener('click', autoAssign);
  $$('select[data-op]', box).forEach((sel) => sel.addEventListener('change', () => {
    const v = sel.value;
    if (v === '') delete state.assignment[sel.dataset.op]; else state.assignment[sel.dataset.op] = Number(v);
    saveJSON('makera_assignment', state.assignment);
    scheduleGenerate();
  }));
}
function autoAssign() {
  const ops = state.result?.operations || [];
  for (const op of ops) {
    const candidates = state.tools.filter((t) => t.type === op.toolType);
    let best = candidates[0];
    let bestD = Infinity;
    for (const t of candidates) { const d = Math.abs(t.diameter - op.diameter); if (d < bestD) { bestD = d; best = t; } }
    if (best) state.assignment[op.id] = best.number;
  }
  saveJSON('makera_assignment', state.assignment);
  renderAssignments();
  scheduleGenerate();
}

// ---------- 2D canvas ----------
// Read the current stock (blank) dimensions from the config inputs.
function stockDims() {
  const sx = Number(document.querySelector('[data-path="stock.sizeX"]')?.value);
  const sy = Number(document.querySelector('[data-path="stock.sizeY"]')?.value);
  if (sx > 0 && sy > 0) return { sizeX: sx, sizeY: sy };
  return null;
}
// Fit an arbitrary extent {minX,minY,maxX,maxY} (mm) into a canvas; returns a
// transform. Y is flipped so +Y points up.
function fitScene(canvas, ext, maxH = 460) {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const margin = 16;
  const w = ext.maxX - ext.minX;
  const h = ext.maxY - ext.minY;
  const cssW = wrap.clientWidth || 700;
  let scale = (cssW - 2 * margin) / w;
  let cssH = h * scale + 2 * margin;
  if (cssH > maxH) { scale = (maxH - 2 * margin) / h; cssH = maxH; }
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return {
    ctx, scale, cssW, cssH,
    X: (x) => margin + (x - ext.minX) * scale,
    Y: (y) => cssH - margin - (y - ext.minY) * scale,
  };
}

// Board placement offset on the stock (centred), + scene extent (union).
function boardOnStock(board, stock) {
  if (!stock) return { offX: 0, offY: 0, ext: { minX: 0, minY: 0, maxX: board.width, maxY: board.height } };
  const offX = (stock.sizeX - board.width) / 2;
  const offY = (stock.sizeY - board.height) / 2;
  return {
    offX, offY,
    ext: {
      minX: Math.min(0, offX), minY: Math.min(0, offY),
      maxX: Math.max(stock.sizeX, offX + board.width), maxY: Math.max(stock.sizeY, offY + board.height),
    },
  };
}

// Live preview of the blank with the board placed on it (Material tab).
function drawMaterialPreview() {
  const canvas = $('#matCanvas');
  if (!canvas) return;
  const stock = stockDims();
  const board = state.result ? state.result.preview.board : null;
  const info = $('#matInfo');
  if (!stock && !board) { const c = canvas.getContext('2d'); c.clearRect(0, 0, canvas.width, canvas.height); if (info) info.textContent = ''; return; }
  const ext = stock ? boardOnStock(board || { width: 0, height: 0 }, stock).ext : { minX: 0, minY: 0, maxX: board.width, maxY: board.height };
  const v = fitScene(canvas, ext, 300);
  const { ctx, X, Y } = v;
  if (stock) {
    ctx.fillStyle = 'rgba(189,160,106,0.9)';
    ctx.fillRect(X(0), Y(stock.sizeY), stock.sizeX * v.scale, stock.sizeY * v.scale);
    ctx.strokeStyle = '#7a6a45'; ctx.lineWidth = 1; ctx.strokeRect(X(0), Y(stock.sizeY), stock.sizeX * v.scale, stock.sizeY * v.scale);
  }
  if (board) {
    const { offX, offY } = boardOnStock(board, stock);
    const p = state.result.preview;
    const BX = (x) => X(x + offX), BY = (y) => Y(y + offY);
    // fit ok?
    const fits = !stock || (board.width + 4 <= stock.sizeX && board.height + 4 <= stock.sizeY) || (board.height + 4 <= stock.sizeX && board.width + 4 <= stock.sizeY);
    // copper faint
    ctx.beginPath();
    for (const ring of p.copper) { ring.forEach(([x, y], i) => (i ? ctx.lineTo(BX(x), BY(y)) : ctx.moveTo(BX(x), BY(y)))); ctx.closePath(); }
    ctx.fillStyle = 'rgba(120,72,24,0.55)'; ctx.fill('evenodd');
    // board outline
    ctx.strokeStyle = fits ? '#2ecc71' : '#ff5a5a'; ctx.lineWidth = 1.5;
    ctx.strokeRect(BX(0), BY(board.height), board.width * v.scale, board.height * v.scale);
    if (info) info.innerHTML = `${t('mat.infoStock')} <b>${stock ? stock.sizeX + ' × ' + stock.sizeY : '—'} mm</b> · ${t('mat.infoBoard')} <b>${board.width.toFixed(1)} × ${board.height.toFixed(1)} mm</b> · ${fits ? `<span style="color:var(--ok)">${t('mat.fits')}</span>` : `<span style="color:var(--err)">${t('mat.notFits')}</span>`}`;
  } else if (info) {
    info.innerHTML = `${t('mat.infoStock')} <b>${stock.sizeX} × ${stock.sizeY} mm</b> ${t('mat.noBoard')}`;
  }
}

function drawPreview() {
  const canvas = $('#preview');
  const p = state.result.preview;
  const board = p.board;
  const stock = state.layers.stock ? stockDims() : null;
  const { offX, offY, ext } = boardOnStock(board, stock);
  const v = fitScene(canvas, ext, 460);
  const { ctx } = v;
  // Stock coords for the blank; board content is offset onto its placement.
  const SX = v.X, SY = v.Y;
  const X = (x) => v.X(x + offX);
  const Y = (y) => v.Y(y + offY);

  // stock blank
  if (stock) {
    ctx.fillStyle = 'rgba(189,160,106,0.85)';
    ctx.fillRect(SX(0), SY(stock.sizeY), stock.sizeX * v.scale, stock.sizeY * v.scale);
    ctx.strokeStyle = '#7a6a45'; ctx.lineWidth = 1;
    ctx.strokeRect(SX(0), SY(stock.sizeY), stock.sizeX * v.scale, stock.sizeY * v.scale);
  }

  ctx.strokeStyle = '#31405c';
  ctx.lineWidth = 1;
  ctx.strokeRect(X(0), Y(board.height), board.width * v.scale, board.height * v.scale);

  if (state.layers.copper && p.copper.length) {
    ctx.beginPath();
    for (const ring of p.copper) { ring.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); }
    ctx.fillStyle = 'rgba(217,130,43,0.85)';
    ctx.fill('evenodd');
  }
  if (state.layers.silk && p.silk && p.silk.length) {
    ctx.beginPath();
    for (const ring of p.silk) { ring.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); }
    ctx.fillStyle = 'rgba(240,240,240,0.9)';
    ctx.fill('evenodd');
  }
  if (state.layers.isolation) {
    ctx.strokeStyle = 'rgba(255,90,90,0.95)'; ctx.lineWidth = 1;
    for (const pass of p.isolation) for (const ring of pass) {
      ctx.beginPath(); ring.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); ctx.stroke();
    }
  }
  if (state.layers.outline) {
    for (const loop of p.outline) {
      ctx.strokeStyle = 'rgba(46,204,113,0.95)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); loop.pts.forEach((pt, i) => (i ? ctx.lineTo(X(pt.x), Y(pt.y)) : ctx.moveTo(X(pt.x), Y(pt.y)))); if (loop.closed) ctx.closePath(); ctx.stroke();
      ctx.fillStyle = '#f0b429';
      for (const pt of loop.pts) if (pt.tab) { ctx.beginPath(); ctx.arc(X(pt.x), Y(pt.y), 1.6, 0, 7); ctx.fill(); }
    }
  }
  if (state.layers.drills) {
    for (const d of p.drills) {
      const r = Math.max(1.2, (d.d / 2) * v.scale);
      ctx.beginPath(); ctx.arc(X(d.x), Y(d.y), r, 0, 7);
      ctx.fillStyle = 'rgba(76,141,255,0.35)'; ctx.fill();
      ctx.strokeStyle = 'rgba(76,141,255,0.95)'; ctx.lineWidth = 1; ctx.stroke();
    }
  }
  if (state.layers.laser && p.laser && p.laser.length) {
    ctx.strokeStyle = 'rgba(255,89,216,0.95)'; ctx.lineWidth = 1;
    for (const line of p.laser) { ctx.beginPath(); line.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.stroke(); }
  }
  ctx.strokeStyle = '#8b98a9'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(0) + 16, Y(0)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(0), Y(0) - 16); ctx.stroke();
  ctx.fillStyle = '#8b98a9'; ctx.font = '10px sans-serif'; ctx.fillText('0,0', X(0) + 3, Y(0) - 4);
}

// ---------- 3D ----------
function show3d() {
  const host = $('#view3dHost');
  host.classList.remove('hidden');
  $('#preview').classList.add('hidden');
  const Viewer3D = window.MakeraViewer3D;
  if (!Viewer3D) {
    host.innerHTML = `<div class="placeholder">${t('view3d.unavailable')}</div>`;
    return;
  }
  try {
    if (!state.viewer3d) state.viewer3d = new Viewer3D(host);
    if (state.result) { state.viewer3d.setData(state.result.preview); state.viewer3d.setLayers(state.layers); }
    requestAnimationFrame(() => state.viewer3d.resize());
  } catch (err) {
    host.innerHTML = `<div class="placeholder">3D-Fehler: ${escapeHtml(err.message)}</div>`;
    toast(t('view3d.error', { msg: err.message }), true);
  }
}
function show2d() {
  $('#view3dHost').classList.add('hidden');
  $('#preview').classList.remove('hidden');
  if (state.viewer3d) state.viewer3d.stop();
  if (state.result) drawPreview();
}

// ---------- workflow tabs ----------
function switchWf(name) {
  $$('.wf-tab').forEach((t) => t.classList.toggle('active', t.dataset.wf === name));
  $$('.wf-panel').forEach((p) => p.classList.toggle('active', p.dataset.wfPanel === name));
  saveJSON('makera_wf', name);
  // These need a visible (non-zero-width) container to size their canvas.
  if (name === 'preview' && state.result) {
    requestAnimationFrame(() => { if (state.view === '3d') show3d(); else drawPreview(); });
  }
  if (name === 'fab' && state.result) {
    requestAnimationFrame(() => renderFab());
  }
  if (name === 'material') {
    requestAnimationFrame(() => drawMaterialPreview());
  }
}
function fabTabActive() {
  return document.querySelector('.wf-panel[data-wf-panel="fab"]')?.classList.contains('active');
}
function updateFabLive(s) {
  if (!state.result) return;
  const play = s.play;
  if (play && play.length >= 2) {
    const pct = Math.max(0, Math.min(100, play[1]));
    if ($('#fabFill')) $('#fabFill').style.width = pct.toFixed(1) + '%';
    if ($('#fabPct')) $('#fabPct').textContent = pct.toFixed(1) + ' %';
    const elapsed = play[2] != null ? play[2] : null;
    let rem = null;
    if (elapsed != null && pct > 1) rem = (elapsed * (100 - pct)) / pct;
    if ($('#fabTime')) $('#fabTime').textContent = rem != null ? 'noch ~' + fmtDur(rem) : (state.result.times?.total ? '≈ ' + fmtDur(state.result.times.total) : '');
  }
  const fs = $('#fabStatus');
  if (fs) { fs.className = 'pill ' + (s.state === 'Run' ? 'run' : 'on'); fs.textContent = s.state || '—'; }
  if (state.fab.anim.playing || !fabTabActive()) return; // manual simulation owns the canvas
  const active = state.fab.steps[firstUndoneIdx()];
  const pct = (play && play.length >= 2) ? Math.max(0, Math.min(100, play[1])) : 0;
  if (s.state === 'Run' && active && active.kind === 'mill' && fabGeom(active) && pct > 0) drawFabReveal(active, pct / 100);
  else if (s.wpos && s.wpos.length >= 2) drawFab([s.wpos[0], s.wpos[1]]);
}

// ---------- fabrication (live) ----------
function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} min ${s}s` : `${s}s`;
}
function toolLabelFor(opId) {
  const num = state.assignment[opId];
  const t = num != null ? state.tools.find((x) => x.number === num) : null;
  return t ? `T${t.number} · ${t.label || t.type + ' ' + t.diameter}` : null;
}
function buildFabSteps() {
  const r = state.result;
  if (!r) return [];
  const cfg = readConfig();
  const times = r.times?.byOp || {};
  const steps = [];
  const files = r.files || {};
  const isoTool = toolLabelFor('isolation');

  // Preparation & safety, ordered like the Makera "Config and Run": wired probe
  // (margin/Z/leveling) first, cutting tool only afterwards.
  steps.push({ id: 'fixate', kind: 'manual', title: t('step.fixate.t'), instr: t('step.fixate.i') });
  steps.push({ id: 'setOrigin', kind: 'setup', action: 'setOriginXY', title: t('step.setOrigin.t'), instr: t('step.setOrigin.i') });
  steps.push({ id: 'insertProbe', kind: 'manual', title: t('step.insertProbe.t'), instr: t('step.insertProbe.i') });
  steps.push({ id: 'autoSetup', kind: 'setup', action: 'autoSetup', title: t('step.autoSetup.t'), instr: t('step.autoSetup.i') });
  steps.push({ id: 'insertTool', kind: 'manual', title: t('step.insertTool.t'), tool: isoTool, instr: t('step.insertTool.i') });

  steps.push({ id: 'isolation', kind: 'mill', title: t('step.isolation.t'), tool: isoTool, file: files['1_isolation.nc'] ? Object.keys(files).find((f) => f.startsWith('1_')) : null, est: times.isolation });

  if (cfg.solderMask?.enable) {
    steps.push({ id: 'clean', kind: 'manual', title: t('step.clean.t'), instr: t('step.clean.i') });
    steps.push({ id: 'applyMask', kind: 'manual', title: t('step.applyMask.t'), instr: t('step.applyMask.i') });
    steps.push({ id: 'cureMask', kind: 'dry', title: t('step.cureMask.t'), instr: t('step.cureMask.i'), dryMin: 10 });
    steps.push({ id: 'removeMask', kind: 'manual', title: t('step.removeMask.t'), tool: t('step.removeMask.tool'), instr: t('step.removeMask.i') });
  }
  for (const g of r.stats.drillGroups) {
    const id = `drill:${g.diameter.toFixed(2)}`;
    const file = Object.keys(files).find((f) => f.includes(`drill_${g.diameter.toFixed(2)}`));
    steps.push({ id, kind: 'mill', title: t('step.drill.t', { dia: g.diameter.toFixed(2), n: g.holes }), tool: toolLabelFor(id), file, est: times[id] });
  }
  if (files['4_outline.nc'] || Object.keys(files).some((f) => f.includes('outline'))) {
    const file = Object.keys(files).find((f) => f.includes('outline'));
    steps.push({ id: 'outline', kind: 'mill', title: t('step.outline.t'), tool: toolLabelFor('outline'), file, est: times.outline });
  }
  const laserFile = Object.keys(files).find((f) => f.includes('silkscreen_laser'));
  if (laserFile) {
    steps.push({ id: 'laser', kind: 'mill', title: t('step.laser.t'), tool: t('step.laser.tool'), file: laserFile, est: times.laser });
  }
  steps.push({ id: 'finish', kind: 'manual', title: t('step.finish.t'), instr: t('step.finish.i') });
  return steps;
}
// ---------- step illustrations (to real Carvera Air proportions) ----------
// Work area 300 × 200 mm, anchor 1 at the front-left corner, MDF waste board
// (Opferplatte) 1–2 mm under the PCB. Colours match the MakeraCAM machining
// preview: grey = anchor, blue = origin, green = range, bold green = scan margin,
// red = Z-probe, yellow matrix = auto-leveling, copper = board, tan = waste board.
const AIRW = 300, AIRH = 200, PX = 52, PY = 20;
const asx = (mm) => PX + mm;
const asy = (mm) => PY + (AIRH - mm);
const WOFF = { x: 15, y: 10 }; // Makera LED-example work offset from anchor 1

function figBoard() {
  const b = state.result?.board;
  const w = Math.max(24, Math.min(b ? b.width : 80, 230));
  const h = Math.max(18, Math.min(b ? b.height : 60, 150));
  return { w, h };
}
function svgWrap(inner, w = 404, h = 262) {
  return `<svg class="stepsvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">${inner}</svg>`;
}
function bedBase(holes = true) {
  let dots = '';
  if (holes) for (let x = 20; x <= AIRW - 20; x += 40) for (let y = 20; y <= AIRH - 20; y += 40)
    dots += `<circle cx="${asx(x)}" cy="${asy(y)}" r="1.5" fill="#3a465c"/>`;
  const bed = `<rect x="${asx(0)}" y="${asy(AIRH)}" width="${AIRW}" height="${AIRH}" rx="7" fill="#212a3b" stroke="#3d4a63"/>`;
  // L-bracket at anchor 1 (front-left): vertical + horizontal arm with the real
  // mounting pattern — 2 dowel pins (filled) + 3 M5 screws (rings).
  const lbracket =
    `<rect x="${asx(0)}" y="${asy(80)}" width="7" height="80" fill="#8a94a6"/>` +
    `<rect x="${asx(0)}" y="${asy(0) - 7}" width="80" height="7" fill="#8a94a6"/>` +
    `<circle cx="${asx(3.5)}" cy="${asy(62)}" r="2" fill="#222a37"/>` +
    `<circle cx="${asx(3.5)}" cy="${asy(38)}" r="2.6" fill="none" stroke="#222a37" stroke-width="1.3"/>` +
    `<circle cx="${asx(3.5)}" cy="${asy(14)}" r="2.6" fill="none" stroke="#222a37" stroke-width="1.3"/>` +
    `<circle cx="${asx(30)}" cy="${asy(3.5)}" r="2" fill="#222a37"/>` +
    `<circle cx="${asx(58)}" cy="${asy(3.5)}" r="2.6" fill="none" stroke="#222a37" stroke-width="1.3"/>`;
  const axes =
    `<text x="${asx(2)}" y="${asy(0) + 16}" class="lbl gr">${t('dg.anchor')}</text>` +
    `<text x="${asx(AIRW) - 4}" y="${asy(0) + 16}" class="lbl dim" text-anchor="end">300 mm (X)</text>` +
    `<text x="${asx(0) - 10}" y="${asy(AIRH / 2)}" class="lbl dim" transform="rotate(-90 ${asx(0) - 10} ${asy(AIRH / 2)})" text-anchor="middle">200 mm (Y)</text>`;
  return bed + dots + lbracket + axes;
}
function figBoardMM() {
  const b = state.result?.board;
  return { w: b ? Number(b.width.toFixed(1)) : 80, h: b ? Number(b.height.toFixed(1)) : 60 };
}
// Small colour-swatch legend, drawn at (x, y).
function legendBox(x, y, entries) {
  let s = `<text x="${x}" y="${y}" class="lbl gr">${t('dg.legend')}</text>`;
  entries.forEach((e, i) => {
    const yy = y + 15 + i * 16;
    s += `<rect x="${x}" y="${yy - 9}" width="12" height="11" rx="2" fill="${e.c}" ${e.stroke ? `stroke="${e.stroke}"` : ''}/>`;
    s += `<text x="${x + 17}" y="${yy}" class="lbl">${e.label}</text>`;
  });
  return s;
}
// Dimension lines for the PCB (width below, height to the right), labelled in mm.
function pcbDims(b) {
  const mm = figBoardMM();
  const y = b.y + b.h + 13;
  let s = `<line x1="${b.x}" y1="${y}" x2="${b.x + b.w}" y2="${y}" class="arr"/>` +
    `<line x1="${b.x}" y1="${y - 3}" x2="${b.x}" y2="${y + 3}" class="arr"/>` +
    `<line x1="${b.x + b.w}" y1="${y - 3}" x2="${b.x + b.w}" y2="${y + 3}" class="arr"/>` +
    `<text x="${b.x + b.w / 2}" y="${y + 12}" class="lbl blue" text-anchor="middle">${mm.w} mm</text>`;
  const xr = b.x + b.w + 8;
  s += `<line x1="${xr}" y1="${b.y}" x2="${xr}" y2="${b.y + b.h}" class="arr"/>` +
    `<line x1="${xr - 3}" y1="${b.y}" x2="${xr + 3}" y2="${b.y}" class="arr"/>` +
    `<line x1="${xr - 3}" y1="${b.y + b.h}" x2="${xr + 3}" y2="${b.y + b.h}" class="arr"/>` +
    `<text x="${xr + 12}" y="${b.y + b.h / 2}" class="lbl blue" transform="rotate(-90 ${xr + 12} ${b.y + b.h / 2})" text-anchor="middle">${mm.h} mm</text>`;
  return s;
}
function boardRect(highlight) {
  const { w, h } = figBoard();
  const x = asx(WOFF.x), y = asy(WOFF.y + h);
  return { w, h, x, y,
    svg: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="#c98a3a" stroke="${highlight || '#e0a84e'}" stroke-width="1.5"/>` };
}
function wasteRect() {
  const { w, h } = figBoard();
  const m = 12; // ~waste board margin around the PCB (shapes only; labelled via legend)
  return `<rect x="${asx(WOFF.x - m)}" y="${asy(WOFF.y + h + m)}" width="${w + 2 * m}" height="${h + 2 * m}" rx="3" fill="#8f6a3f" stroke="#a97f4c" stroke-dasharray="4 3"/>`;
}
// Two top clamps pressing the PCB down on the edges away from the L-bracket.
function clamps() {
  const b = boardRect();
  const clamp = (cx) => `<rect x="${cx - 9}" y="${b.y - 7}" width="18" height="15" rx="3" fill="#48566e" stroke="#5b6b88"/>`;
  return clamp(b.x + b.w * 0.34) + clamp(b.x + b.w * 0.7);
}
function offsetArrows() {
  const b = boardRect();
  const ax = asx(0), ay = asy(0);
  return `<line x1="${ax}" y1="${ay + 12}" x2="${b.x}" y2="${ay + 12}" class="arr x"/>` +
    `<text x="${(ax + b.x) / 2}" y="${ay + 24}" class="lbl blue" text-anchor="middle">X ${WOFF.x}</text>` +
    `<line x1="${ax - 12}" y1="${ay}" x2="${ax - 12}" y2="${b.y + b.h}" class="arr y"/>` +
    `<text x="${ax - 22}" y="${(ay + b.y + b.h) / 2}" class="lbl blue" text-anchor="middle" transform="rotate(-90 ${ax - 22} ${(ay + b.y + b.h) / 2})">Y ${WOFF.y}</text>`;
}
function originDot() {
  const b = boardRect();
  return `<circle cx="${b.x}" cy="${b.y + b.h}" r="5" fill="none" stroke="#4c8dff" stroke-width="2"/>` +
    `<circle cx="${b.x}" cy="${b.y + b.h}" r="1.6" fill="#4c8dff"/>`;
}
// Side-view layer stack explaining the waste board. Labels stay inside the
// viewBox (no clipping) and the notes sit on their own lines.
function sideStack() {
  const x = 34, w = 200, top = 30;
  const lx = x + w + 10; // right-side label column, safely inside the 420 viewBox
  const row = (yy, hh, fill, stroke) => `<rect x="${x}" y="${yy}" width="${w}" height="${hh}" fill="${fill}" stroke="${stroke || 'none'}"/>`;
  let s = `<text x="${x}" y="16" class="lbl gr">${t('dg.sideview')}</text>`;
  s += row(top, 24, '#2b3446', '#3d4a63'); // bed
  s += `<text x="${lx}" y="${top + 16}" class="lbl dim">${t('dg.bed')}</text>`;
  s += row(top + 24, 4, '#c85b5b'); // tape
  s += row(top + 28, 18, '#8f6a3f', '#a97f4c'); // waste
  s += `<text x="${lx}" y="${top + 41}" class="lbl tan">${t('dg.wasteThin')}</text>`;
  s += row(top + 46, 4, '#c85b5b'); // tape
  s += `<text x="${lx}" y="${top + 55}" class="lbl dim">${t('dg.tape')}</text>`;
  s += row(top + 50, 11, '#c98a3a', '#e0a84e'); // pcb
  s += `<text x="${lx}" y="${top + 68}" class="lbl">${t('dg.pcbCu')}</text>`;
  // drill breaking slightly through the PCB into the waste board
  s += `<rect x="${x + 96}" y="${top - 12}" width="8" height="76" fill="#9aa7bd"/>`;
  s += `<path d="M${x + 96} ${top + 61} L${x + 104} ${top + 61} L${x + 100} ${top + 68} Z" fill="#9aa7bd"/>`;
  s += `<text x="${x}" y="${top + 84}" class="lbl dim">${t('dg.drillNote')}</text>`;
  s += `<text x="${x}" y="${top + 98}" class="lbl tan">${t('dg.wasteSpec')}</text>`;
  return svgWrap(s, 420, 142);
}
// Spindle side view with a tool or probe reaching the surface.
function spindleSide(kind) {
  const cx = 150, top = 16;
  let s = `<rect x="${cx - 34}" y="${top}" width="68" height="60" rx="8" fill="#2b3446" stroke="#3d4a63"/>`;
  s += `<text x="${cx}" y="${top + 34}" class="lbl" text-anchor="middle">${t('dg.spindle')}</text>`;
  s += `<rect x="${cx - 12}" y="${top + 60}" width="24" height="16" rx="2" fill="#8a94a6"/>`; // collet
  s += `<text x="${cx + 22}" y="${top + 72}" class="lbl dim">${t('dg.collet')}</text>`;
  const surfY = top + 150, boardX = cx - 120, boardW = 240;
  s += `<rect x="${boardX}" y="${surfY}" width="${boardW}" height="14" fill="#c98a3a" stroke="#e0a84e"/>`; // pcb
  s += `<rect x="${boardX - 6}" y="${surfY + 14}" width="${boardW + 12}" height="16" fill="#8f6a3f" stroke="#a97f4c"/>`; // waste
  if (kind === 'probe') {
    s += `<rect x="${cx - 5}" y="${top + 76}" width="10" height="${surfY - top - 76}" fill="#b0b8c8"/>`; // probe body
    s += `<circle cx="${cx}" cy="${surfY}" r="5" fill="none" stroke="#ff5a5a" stroke-width="2"/>`;
    s += `<path d="M${cx + 5} ${top + 88} q26 6 30 40" fill="none" stroke="#e0b64e" stroke-width="2"/>`; // wire
    s += `<text x="${cx + 40}" y="${top + 128}" class="lbl">${t('dg.probe')}</text>`;
    s += `<text x="${boardX}" y="${surfY - 8}" class="lbl red">${t('dg.contact')}</text>`;
  } else if (kind === 'vbit') {
    s += `<rect x="${cx - 2.5}" y="${top + 76}" width="5" height="${surfY - top - 82}" fill="#c7cede"/>`;
    s += `<path d="M${cx - 4} ${surfY - 6} L${cx + 4} ${surfY - 6} L${cx} ${surfY} Z" fill="#c7cede"/>`;
    s += `<text x="${cx + 14}" y="${top + 118}" class="lbl">${t('dg.vbit')}</text>`;
  } else {
    s += `<rect x="${cx - 3}" y="${top + 76}" width="6" height="${surfY - top - 76}" fill="#c7cede"/>`;
    s += `<text x="${cx + 14}" y="${top + 118}" class="lbl">${t('dg.tool')}</text>`;
  }
  s += `<text x="${boardX}" y="${surfY + 44}" class="lbl tan">${t('dg.pcbOnWaste')}</text>`;
  return svgWrap(s, 404, 232);
}
// Dispatch: build the illustration for a given step.
function stepDiagram(step) {
  const id = step.id;
  if (id === 'fixate') {
    const b = boardRect();
    const inner =
      `<text x="${asx(0)}" y="13" class="lbl gr">${t('dg.topview')}</text>` +
      bedBase() + wasteRect() + b.svg + clamps() + pcbDims(b) +
      `<text x="${asx(2)}" y="${asy(0) + 30}" class="lbl dim">${t('dg.screws')}</text>` +
      legendBox(asx(AIRW) + 16, 40, [
        { c: '#8a94a6', label: t('dg.lgBracket') },
        { c: '#c98a3a', stroke: '#e0a84e', label: t('dg.lgBoard') },
        { c: '#8f6a3f', stroke: '#a97f4c', label: t('dg.lgWaste') },
        { c: '#48566e', label: t('dg.lgClamps') },
      ]);
    return svgWrap(inner, 500, 285) + sideStack();
  }
  if (id === 'insertTool') return spindleSide('vbit');
  if (id === 'insertProbe') return spindleSide('probe');
  if (id === 'setOrigin') {
    const inner = bedBase() + boardRect().svg + offsetArrows() + originDot() +
      `<text x="${boardRect().x + 8}" y="${boardRect().y + boardRect().h + 20}" class="lbl blue">${t('dg.origin')}</text>`;
    return svgWrap(inner);
  }
  if (id === 'probeZ') return spindleSide('probe');
  if (id === 'autoSetup') {
    const b = boardRect();
    let grid = '';
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++)
      grid += `<circle cx="${b.x + (b.w * i) / 4}" cy="${b.y + (b.h * j) / 4}" r="3" fill="none" stroke="#ffd23f" stroke-width="1.6"/>`;
    const inner = bedBase(false) + b.svg +
      `<rect x="${b.x - 3}" y="${b.y - 3}" width="${b.w + 6}" height="${b.h + 6}" fill="none" stroke="#3ecf7a" stroke-width="2.5"/>` + // scan margin
      grid + // leveling
      `<circle cx="${b.x}" cy="${b.y + b.h}" r="5" fill="none" stroke="#ff5a5a" stroke-width="2"/>` + // z-probe
      `<text x="${b.x}" y="${b.y - 10}" class="lbl grn">${t('dg.scanMargin')}</text>` +
      `<text x="${b.x + 78}" y="${b.y - 10}" class="lbl red">${t('dg.zprobe')}</text>` +
      `<text x="${b.x + 150}" y="${b.y - 10}" class="lbl yel">${t('dg.leveling')}</text>`;
    return svgWrap(inner);
  }
  if (id === 'levelMap') {
    const b = boardRect();
    let grid = '';
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const gx = b.x + (b.w * i) / 4, gy = b.y + (b.h * j) / 4;
      grid += `<circle cx="${gx}" cy="${gy}" r="3" fill="none" stroke="#ffd23f" stroke-width="1.6"/>`;
    }
    const inner = bedBase(false) + b.svg + grid +
      `<text x="${b.x}" y="${b.y - 8}" class="lbl yel">${t('dg.heightmap')}</text>`;
    return svgWrap(inner);
  }
  if (id === 'marginCheck') {
    const b = boardRect();
    const inner = bedBase(false) + b.svg +
      `<rect x="${b.x - 2}" y="${b.y - 2}" width="${b.w + 4}" height="${b.h + 4}" fill="none" stroke="#3ecf7a" stroke-width="3"/>` +
      `<text x="${b.x}" y="${b.y - 8}" class="lbl grn">${t('dg.marginTrace')}</text>`;
    return svgWrap(inner);
  }
  // milling operations: board top view with a schematic of the operation
  if (step.kind === 'mill') {
    const b = boardRect();
    let feat = '';
    if (id.startsWith('drill')) {
      for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++)
        feat += `<circle cx="${b.x + 20 + i * (b.w - 40) / 4}" cy="${b.y + 16 + j * (b.h - 32) / 2}" r="2.6" fill="#0d1017" stroke="#7fb3ff"/>`;
      feat += `<text x="${b.x}" y="${b.y - 8}" class="lbl">${t('dg.drill')}</text>`;
    } else if (id === 'outline') {
      feat = `<rect x="${b.x - 2}" y="${b.y - 2}" width="${b.w + 4}" height="${b.h + 4}" fill="none" stroke="#3ecf7a" stroke-width="2.5" stroke-dasharray="14 6"/>` +
        `<text x="${b.x}" y="${b.y - 8}" class="lbl grn">${t('dg.outline')}</text>`;
    } else if (id === 'laser') {
      feat = `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 4}" class="lbl" text-anchor="middle" style="font-size:13px;fill:#fff">SILK</text>` +
        `<circle cx="${b.x + 14}" cy="${b.y + 14}" r="4" fill="#ff5a5a"/>` +
        `<text x="${b.x}" y="${b.y - 8}" class="lbl red">${t('dg.laser')}</text>`;
    } else {
      for (let i = 0; i < 4; i++)
        feat += `<path d="M${b.x + 12} ${b.y + 12 + i * (b.h - 24) / 3} h ${b.w - 24}" stroke="#0d1017" stroke-width="3" fill="none"/>`;
      feat += `<rect x="${b.x + 6}" y="${b.y + 6}" width="${b.w - 12}" height="${b.h - 12}" fill="none" stroke="#0d1017" stroke-dasharray="3 3"/>` +
        `<text x="${b.x}" y="${b.y - 8}" class="lbl">${t('dg.isolation')}</text>`;
    }
    return svgWrap(bedBase(false) + b.svg + feat);
  }
  // manual/dry pictograms
  const b = boardRect();
  const base = bedBase(false) + wasteRect() + b.svg;
  let icon = '';
  if (id === 'clean') icon = `<rect x="${b.x + b.w / 2 - 16}" y="${b.y + b.h / 2 - 10}" width="32" height="20" rx="4" fill="#6fd0e0"/><text x="${b.x}" y="${b.y - 8}" class="lbl">${t('dg.clean')}</text>`;
  else if (id === 'applyMask') icon = `<rect x="${b.x + 6}" y="${b.y + 6}" width="${b.w - 12}" height="${b.h - 12}" fill="#1f7a4d" opacity="0.7"/><rect x="${b.x + b.w / 2 - 14}" y="${b.y - 14}" width="28" height="12" rx="3" fill="#48566e"/><text x="${b.x}" y="${b.y - 8}" class="lbl grn">${t('dg.applyMask')}</text>`;
  else if (id === 'cureMask') icon = `<circle cx="${b.x + b.w / 2}" cy="${b.y - 22}" r="10" fill="#a06bff"/>${[0,45,90,135,180,225,270,315].map(a=>`<line x1="${b.x+b.w/2}" y1="${b.y-22}" x2="${b.x+b.w/2+Math.cos(a*Math.PI/180)*20}" y2="${b.y-22+Math.sin(a*Math.PI/180)*20}" stroke="#a06bff" stroke-width="2"/>`).join('')}<rect x="${b.x + 6}" y="${b.y + 6}" width="${b.w - 12}" height="${b.h - 12}" fill="#1f7a4d" opacity="0.7"/><text x="${b.x}" y="${b.y - 40}" class="lbl">${t('dg.cureMask')}</text>`;
  else if (id === 'removeMask') icon = `<rect x="${b.x + 6}" y="${b.y + 6}" width="${b.w - 12}" height="${b.h - 12}" fill="#1f7a4d" opacity="0.5"/>${[0,1,2,3].map(i=>`<circle cx="${b.x+18+i*(b.w-36)/3}" cy="${b.y+b.h/2}" r="4" fill="#c98a3a" stroke="#e0a84e"/>`).join('')}<text x="${b.x}" y="${b.y - 8}" class="lbl">${t('dg.removeMask')}</text>`;
  else if (id === 'finish') icon = `<path d="M${b.x} ${b.y + b.h + 6} l ${b.w} 0" stroke="#9aa7bd" stroke-width="3" stroke-dasharray="6 4"/><text x="${b.x}" y="${b.y - 8}" class="lbl">${t('dg.finish')}</text>`;
  else icon = `<text x="${b.x}" y="${b.y - 8}" class="lbl">${escapeHtml(step.title)}</text>`;
  return svgWrap(base + icon);
}

function firstUndoneIdx() {
  return state.fab.steps.findIndex((s) => !state.fab.done[s.id]);
}
function renderFab() {
  const host = $('#fabSteps');
  if (!host) return;
  if (!state.result) { host.innerHTML = `<p class="muted">${t('fab.loadFirst')}</p>`; return; }
  state.fab.steps = buildFabSteps();
  $('#fabPlaceholder')?.classList.add('hidden');
  const activeIdx = firstUndoneIdx();
  const viewIdx = (state.fab.view != null && state.fab.view < state.fab.steps.length) ? state.fab.view : (activeIdx >= 0 ? activeIdx : 0);
  const doneLbl = t('fab.done');
  host.innerHTML = state.fab.steps.map((s, i) => {
    const done = !!state.fab.done[s.id];
    const active = i === activeIdx;
    const shown = i === viewIdx;
    const cls = `fab-step ${done ? 'done' : ''} ${active ? 'active' : ''} ${shown ? 'shown' : ''} ${s.kind === 'manual' || s.kind === 'dry' ? 'manual' : ''}`;
    const sub = [s.tool ? `${t('step.toolPrefix')}: ${escapeHtml(s.tool)}` : '', s.est ? `≈ ${fmtDur(s.est)}` : '', s.instr ? escapeHtml(s.instr) : ''].filter(Boolean).join(' · ');
    let actions = '';
    if (s.kind === 'mill') {
      actions = `${s.file ? `<button class="btn small" data-fabrun="${s.file}">${t('fab.run')}</button>` : `<span class="muted">${t('fab.noFile')}</span>`}<button class="btn small ghost" data-fabdone="${s.id}">${done ? t('fab.doneMark') : doneLbl}</button>`;
    } else if (s.kind === 'setup') {
      actions = `<button class="btn small" data-fabaction="${s.action}">${t('fab.exec')}</button><button class="btn small ghost" data-fabdone="${s.id}">${done ? t('fab.doneMark') : doneLbl}</button>`;
    } else if (s.kind === 'dry') {
      actions = `<span class="fab-dry"><input type="number" value="${s.dryMin}" data-drymin="${s.id}" /> ${t('fab.min')} <button class="btn small" data-drystart="${s.id}">${t('fab.timer')}</button><span class="fab-timer" data-drytimer="${s.id}"></span></span><button class="btn small ghost" data-fabdone="${s.id}">${done ? t('fab.doneMark') : doneLbl}</button>`;
    } else {
      actions = `<button class="btn small ghost" data-fabdone="${s.id}">${done ? t('fab.doneMark') : doneLbl}</button>`;
    }
    const figure = shown ? `<div class="st-figure">${stepDiagram(s)}</div>` : '';
    return `<div class="${cls}" data-fabsel="${i}"><span class="num">${done ? '✓' : i + 1}</span><div class="st-main"><div class="st-title">${escapeHtml(s.title)}</div><div class="st-sub">${sub}</div></div><div class="st-actions">${actions}</div>${figure}</div>`;
  }).join('');

  $$('[data-fabsel]', host).forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('button, input, .st-actions')) return; // don't hijack controls
    const i = Number(el.dataset.fabsel);
    state.fab.view = (state.fab.view === i) ? null : i;
    renderFab(); drawFab();
  }));
  $$('[data-fabrun]', host).forEach((b) => b.addEventListener('click', () => fabRun(b.dataset.fabrun)));
  $$('[data-fabaction]', host).forEach((b) => b.addEventListener('click', () => {
    if (!state.machine.connected) { switchWf('machine'); return toast(t('machine.connectFirst'), true); }
    machineAction(b.dataset.fabaction);
  }));
  $$('[data-fabdone]', host).forEach((b) => b.addEventListener('click', () => { const id = b.dataset.fabdone; state.fab.done[id] = !state.fab.done[id]; renderFab(); drawFab(); }));
  $$('[data-drystart]', host).forEach((b) => b.addEventListener('click', () => startDryTimer(b.dataset.drystart)));

  const est = state.result.times?.total;
  $('#fabMeta').innerHTML = t('fab.totalTime', { time: fmtDur(est), n: state.fab.steps.length });
  if (activeIdx >= 0) $('#fabStepName').textContent = `${activeIdx + 1}. ${state.fab.steps[activeIdx].title}`;
  else $('#fabStepName').textContent = t('fab.allDone');
  drawFab();
}
async function fabRun(file) {
  const gcode = state.result?.files?.[file];
  if (!gcode) return toast(t('fab.notFound'), true);
  if (!state.machine.connected) { switchWf('machine'); return toast(t('machine.connectFirst'), true); }
  if (!confirm(t('fab.runConfirm', { file }))) return;
  try { const d = await api('/api/machine/run', { name: file, gcode, start: true }); toast(t('fab.started', { path: d.path })); logEvent('log.started', { path: d.path }); } catch (err) { toast(t('machine.uploadErr', { msg: err.message }), true); logEvent('log.genError', { msg: err.message }, 'error'); }
}
function startDryTimer(id) {
  const min = Number($(`[data-drymin="${id}"]`)?.value) || 10;
  const end = Date.now() + min * 60000;
  clearInterval(state.fab.dry[id]);
  const tick = () => {
    const el = $(`[data-drytimer="${id}"]`);
    const left = Math.max(0, end - Date.now());
    if (el) el.textContent = ' ' + fmtDur(left / 1000);
    if (left <= 0) { clearInterval(state.fab.dry[id]); delete state.fab.dry[id]; toast(t('fab.curingDone')); state.fab.done[id] = true; renderFab(); }
  };
  state.fab.dry[id] = setInterval(tick, 1000);
  tick();
}
function computeViewFor(canvas) {
  const wrap = canvas.parentElement;
  const board = state.result.preview.board;
  const dpr = window.devicePixelRatio || 1;
  const margin = 16;
  const cssW = wrap.clientWidth || 700;
  let scale = (cssW - 2 * margin) / board.width;
  let cssH = board.height * scale + 2 * margin;
  const maxH = 380;
  if (cssH > maxH) { scale = (maxH - 2 * margin) / board.height; cssH = maxH; }
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, scale, cssW, cssH, board, X: (x) => margin + x * scale, Y: (y) => cssH - margin - y * scale };
}
function drawFab(marker) {
  const canvas = $('#fabCanvas');
  if (!canvas || !state.result) return;
  const p = state.result.preview;
  const v = computeViewFor(canvas);
  const { ctx, X, Y } = v;
  ctx.strokeStyle = '#31405c'; ctx.lineWidth = 1;
  ctx.strokeRect(X(0), Y(v.board.height), v.board.width * v.scale, v.board.height * v.scale);
  // copper faint
  ctx.beginPath();
  for (const ring of p.copper) { ring.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); }
  ctx.fillStyle = 'rgba(217,130,43,0.4)'; ctx.fill('evenodd');
  const active = state.fab.steps[firstUndoneIdx()];
  const strokeSet = (rings, color, closed, dim) => { ctx.strokeStyle = color; ctx.globalAlpha = dim ? 0.3 : 1; ctx.lineWidth = dim ? 0.8 : 1.4; for (const r of rings) { if (!r || r.length < 2) continue; ctx.beginPath(); r.forEach((pt, i) => { const x = pt.x ?? pt[0]; const y = pt.y ?? pt[1]; i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)); }); if (closed) ctx.closePath(); ctx.stroke(); } ctx.globalAlpha = 1; };
  strokeSet(p.isolation.flat(), '#ff5a5a', true, !active || active.id !== 'isolation');
  strokeSet((p.outline || []).map((l) => l.pts), '#2ecc71', true, !active || active.id !== 'outline');
  if (p.laser?.length) strokeSet(p.laser, '#ff59d8', false, !active || active.id !== 'laser');
  for (const d of p.drills) { ctx.beginPath(); ctx.arc(X(d.x), Y(d.y), Math.max(1.2, (d.d / 2) * v.scale), 0, 7); ctx.fillStyle = active && active.id.startsWith('drill') ? 'rgba(76,141,255,0.9)' : 'rgba(76,141,255,0.4)'; ctx.fill(); }
  // live machine marker (work coords == board coords)
  if (marker) { ctx.beginPath(); ctx.arc(X(marker[0]), Y(marker[1]), 5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = 2; ctx.stroke(); }
}

// ---------- live / simulated toolpath animation on the fab canvas ----------
// Toolpath geometry (polylines + drill points) for one fabrication step.
function fabGeom(step) {
  if (!state.result || !step) return null;
  const p = state.result.preview;
  const toXY = (r) => r.map((pt) => ({ x: pt.x ?? pt[0], y: pt.y ?? pt[1] }));
  if (step.id === 'isolation') return { polys: p.isolation.flat().map(toXY), dots: [] };
  if (step.id === 'outline') return { polys: (p.outline || []).map((l) => toXY(l.pts)), dots: [] };
  if (step.id === 'laser') return { polys: (p.laser || []).map(toXY), dots: [] };
  if (step.id.startsWith('drill')) { const dia = parseFloat(step.id.split(':')[1]); return { polys: [], dots: p.drills.filter((d) => Math.abs(d.d - dia) < 0.06) }; }
  return null;
}
function polyLen(pl) { let L = 0; for (let i = 1; i < pl.length; i++) L += Math.hypot(pl[i].x - pl[i - 1].x, pl[i].y - pl[i - 1].y); return L; }
function fabColor(step) { return step.id === 'outline' ? '#2ecc71' : step.id === 'laser' ? '#ff59d8' : step.id.startsWith('drill') ? '#4c8dff' : '#ff5a5a'; }

// Draw the board faint and reveal one step's toolpath up to `frac` (0..1), with a
// tool head marker — used both for the simulation and the live machine progress.
function drawFabReveal(step, frac) {
  const canvas = $('#fabCanvas');
  if (!canvas || !state.result) return;
  const p = state.result.preview;
  const v = computeViewFor(canvas);
  const { ctx, X, Y } = v;
  ctx.strokeStyle = '#31405c'; ctx.lineWidth = 1;
  ctx.strokeRect(X(0), Y(v.board.height), v.board.width * v.scale, v.board.height * v.scale);
  ctx.beginPath();
  for (const ring of p.copper) { ring.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); }
  ctx.fillStyle = 'rgba(217,130,43,0.4)'; ctx.fill('evenodd');
  const dim = (rings, color, closed) => { ctx.strokeStyle = color; ctx.globalAlpha = 0.25; ctx.lineWidth = 0.8; for (const r of rings) { if (!r || r.length < 2) continue; ctx.beginPath(); r.forEach((pt, i) => { const x = pt.x ?? pt[0]; const y = pt.y ?? pt[1]; i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)); }); if (closed) ctx.closePath(); ctx.stroke(); } ctx.globalAlpha = 1; };
  dim(p.isolation.flat(), '#ff5a5a', true);
  dim((p.outline || []).map((l) => l.pts), '#2ecc71', true);
  if (p.laser?.length) dim(p.laser, '#ff59d8', false);
  for (const d of p.drills) { ctx.beginPath(); ctx.arc(X(d.x), Y(d.y), Math.max(1.2, (d.d / 2) * v.scale), 0, 7); ctx.fillStyle = 'rgba(76,141,255,0.28)'; ctx.fill(); }

  const g = fabGeom(step);
  let head = null;
  if (g) {
    const color = fabColor(step);
    if (g.dots.length) {
      const n = Math.max(0, Math.min(g.dots.length, Math.round(frac * g.dots.length)));
      for (let i = 0; i < n; i++) { const d = g.dots[i]; ctx.beginPath(); ctx.arc(X(d.x), Y(d.y), Math.max(1.5, (d.d / 2) * v.scale), 0, 7); ctx.fillStyle = color; ctx.fill(); }
      const hd = g.dots[Math.min(n, g.dots.length - 1)];
      if (hd) head = { x: hd.x, y: hd.y };
    } else if (g.polys.length) {
      const total = g.polys.reduce((s, pl) => s + polyLen(pl), 0) || 1;
      let remaining = frac * total;
      ctx.strokeStyle = color; ctx.lineWidth = 1.7;
      for (const pl of g.polys) {
        if (pl.length < 2) continue;
        if (remaining <= 0) break;
        ctx.beginPath(); ctx.moveTo(X(pl[0].x), Y(pl[0].y)); head = { x: pl[0].x, y: pl[0].y };
        for (let i = 1; i < pl.length; i++) {
          const seg = Math.hypot(pl[i].x - pl[i - 1].x, pl[i].y - pl[i - 1].y);
          if (seg <= remaining) { ctx.lineTo(X(pl[i].x), Y(pl[i].y)); head = { x: pl[i].x, y: pl[i].y }; remaining -= seg; }
          else { const f = remaining / seg; head = { x: pl[i - 1].x + (pl[i].x - pl[i - 1].x) * f, y: pl[i - 1].y + (pl[i].y - pl[i - 1].y) * f }; ctx.lineTo(X(head.x), Y(head.y)); remaining = 0; break; }
        }
        ctx.stroke();
      }
    }
  }
  if (head) { ctx.beginPath(); ctx.arc(X(head.x), Y(head.y), 5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = 2; ctx.stroke(); }
}

function fabStop() {
  state.fab.anim.playing = false;
  if (state.fab.anim.raf) cancelAnimationFrame(state.fab.anim.raf);
  state.fab.anim.raf = null;
  $('#fabPlay')?.classList.remove('hidden');
  $('#fabStop')?.classList.add('hidden');
  if (state.result && fabTabActive()) drawFab();
}
// Simulate the whole job on the fab canvas at (scaled) real feed rates.
function fabPlay() {
  if (!state.result) return;
  fabStop();
  const mill = (state.fab.steps.length ? state.fab.steps : buildFabSteps()).filter((s) => s.kind === 'mill' && fabGeom(s));
  if (!mill.length) return;
  state.fab.anim.playing = true;
  $('#fabPlay').classList.add('hidden');
  $('#fabStop').classList.remove('hidden');
  logEvent('log.simStart', {});
  let idx = 0, t0 = performance.now();
  const speed = () => Number($('#fabSpeed')?.value) || 45;
  const durMs = () => { const est = state.result.times?.byOp?.[mill[idx].id] || 8; return Math.max(900, Math.min(22000, (est * 1000) / speed())); };
  const frame = (now) => {
    if (!state.fab.anim.playing) return;
    let frac = (now - t0) / durMs();
    if (frac >= 1) { drawFabReveal(mill[idx], 1); idx++; if (idx >= mill.length) { setTimeout(fabStop, 400); return; } t0 = now; frac = 0; }
    else drawFabReveal(mill[idx], frac);
    if ($('#fabStepName')) $('#fabStepName').textContent = mill[idx].title;
    state.fab.anim.raf = requestAnimationFrame(frame);
  };
  state.fab.anim.raf = requestAnimationFrame(frame);
}

// ---------- machine ----------
async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('common.error'));
  return data;
}
async function machineDiscover() {
  const box = $('#mFound');
  box.innerHTML = `<p class="muted">${t('machine.searching')}</p>`;
  try {
    const { machines } = await api('/api/machine/discover', { timeout: 2800 });
    if (!machines.length) { box.innerHTML = `<p class="muted">${t('machine.none')}</p>`; return; }
    box.innerHTML = machines.map((m) => {
      const badge = m.busy ? ` <span class="meta" style="color:var(--warn)">· ${t('machine.busy')}</span>` : ` <span class="meta" style="color:var(--ok)">· ${t('machine.free')}</span>`;
      return `<div class="fitem" data-ip="${m.ip}" data-port="${m.port}">${escapeHtml(m.name)} — ${m.ip}:${m.port}${badge}</div>`;
    }).join('');
    $$('.fitem', box).forEach((el) => el.addEventListener('click', () => { $('#mIp').value = el.dataset.ip; $('#mPort').value = el.dataset.port; }));
  } catch (err) { box.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`; }
}
async function machineConnect() {
  const ip = $('#mIp').value.trim();
  const port = Number($('#mPort').value) || 2222;
  if (!ip) return toast(t('machine.enterIp'), true);
  try {
    await api('/api/machine/connect', { ip, port });
    state.machine.connected = true;
    $('#mDisconnect').disabled = false;
    $('#mStatus').classList.remove('hidden');
    startStatusPoll();
    toast(t('machine.connectedToast'));
    logEvent('log.connected', { ip });
  } catch (err) { toast(t('machine.connectFail', { msg: err.message }), true); }
}
async function machineRetry() {
  const ip = $('#mIp').value.trim();
  const port = Number($('#mPort').value) || 2222;
  if (!ip) return;
  $('#machDiag').innerHTML = `<div>${t('machine.reconnecting')}</div>`;
  try {
    await api('/api/machine/disconnect');
    await new Promise((r) => setTimeout(r, 800));
    await api('/api/machine/connect', { ip, port });
    delete $('#machDiag').dataset.shown;
    $('#machDiag').classList.add('hidden');
    startStatusPoll();
    toast(t('machine.reconnected'));
  } catch (err) { toast(t('machine.reconnectFail', { msg: err.message }), true); }
}
async function machineDisconnect() {
  stopStatusPoll();
  try { await api('/api/machine/disconnect'); } catch {}
  state.machine.connected = false;
  $('#mDisconnect').disabled = true;
  setPill('off', t('machine.disconnected'));
  const diag = $('#machDiag'); diag.classList.add('hidden'); delete diag.dataset.shown;
  logEvent('log.disconnected', {});
}
function startStatusPoll() {
  stopStatusPoll();
  state.machine.timer = setInterval(pollStatus, 1000);
  pollStatus();
}
function stopStatusPoll() { if (state.machine.timer) clearInterval(state.machine.timer); state.machine.timer = null; }
async function pollStatus() {
  try {
    const res = await fetch('/api/machine/status');
    const d = await res.json();
    if (!d.connected) {
      state.machine.connected = false; stopStatusPoll(); $('#mDisconnect').disabled = true; setPill('off', t('machine.disconnected'));
      const diag = $('#machDiag'); diag.classList.add('hidden'); delete diag.dataset.shown;
      return;
    }
    const s = d.status || {};
    const state_ = s.state || '—';
    setPill(state_ === 'Run' ? 'run' : 'on', d.xmitting ? t('machine.upload') : (s.state ? state_ : t('machine.connected')));
    const fmt = (a, dg = 2) => (a ? a.map((v) => v.toFixed(dg)).join(' / ') : '—');
    $('[data-s="state"]').textContent = state_;
    $('[data-s="wpos"]').textContent = fmt(s.wpos, 2);
    $('[data-s="feed"]').textContent = s.feed ? s.feed[0].toFixed(0) : '—';
    $('[data-s="spin"]').textContent = s.spindle ? s.spindle[0].toFixed(0) : '—';
    $('[data-s="tool"]').textContent = s.tool ? `T${s.tool[0]}` : '—';
    $('#mConsole').textContent = (d.log || []).join('\n');
    $('#mConsole').scrollTop = $('#mConsole').scrollHeight;

    // Live progress from the status "P" (play: lines, percent, seconds) field.
    const prog = $('#mProgress');
    const play = s.play;
    if (play && play.length >= 2 && (state_ === 'Run' || play[1] > 0)) {
      const pct = Math.max(0, Math.min(100, play[1]));
      prog.classList.remove('hidden');
      $('#mProgressFill').style.width = pct.toFixed(1) + '%';
      $('#mProgressPct').textContent = pct.toFixed(1) + ' %';
      const secs = play[2] != null ? Math.round(play[2]) : null;
      $('#mProgressTime').textContent = secs != null ? `${Math.floor(secs / 60)}m ${secs % 60}s` : '';
    } else if (state_ !== 'Run') {
      prog.classList.add('hidden');
    }
    updateFabLive(s);
    renderAlarm(state_, d.lastAlarm);
    if (d.lastAlarm && d.lastAlarm.at !== state._lastAlarmAt) { state._lastAlarmAt = d.lastAlarm.at; logEvent('log.alarm', { msg: d.lastAlarm.text }, 'error'); }

    // Diagnostic: connected but the machine truly sends nothing back. Only when
    // we've had a connection for a few seconds AND received zero bytes AND have
    // no parsed state. As soon as ANY data arrives, hide it.
    const diag = $('#machDiag');
    const noData = !s.state && d.connectedFor > 3500 && (d.bytesReceived || 0) === 0;
    if (noData) {
      if (!diag.dataset.shown) {
        diag.dataset.shown = '1';
        diag.classList.remove('hidden');
        diag.innerHTML = t('diag.noData')
          + `<button id="machRetry" class="btn small" style="margin-top:8px">${t('machine.retry')}</button>`;
      }
    } else {
      diag.classList.add('hidden');
      delete diag.dataset.shown;
    }
  } catch { /* transient */ }
}
function setPill(cls, text) { const p = $('#machState'); p.className = 'pill ' + cls; p.textContent = text; }

// Plain-language hint for a raw machine alarm/error message (Makera/Smoothie).
function explainAlarm(text) {
  const s = (text || '').toLowerCase();
  if (/hard ?limit|soft ?limit|limit/.test(s)) return t('alarm.limit');
  if (/probe fail|probe/.test(s)) return t('alarm.probe');
  if (/reset to continue/.test(s)) return t('alarm.resetToContinue');
  if (/tool|atc|collet/.test(s)) return t('alarm.tool');
  if (/too small|out of|range/.test(s)) return t('alarm.range');
  return t('alarm.generic');
}
// Show a prominent banner when the machine is in Alarm/Halt or reported an error.
function renderAlarm(state_, lastAlarm) {
  const el = $('#machAlarm');
  if (!el) return;
  const inAlarm = state_ === 'Alarm' || state_ === 'Halt';
  const recent = lastAlarm && (Date.now() - lastAlarm.at < 20000);
  if (!inAlarm && !recent) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const msg = lastAlarm?.text || (inAlarm ? t('alarm.state', { state: state_ }) : '');
  el.classList.remove('hidden');
  el.innerHTML = `<div><b>⚠ ${escapeHtml(inAlarm ? state_ + ' – ' : '')}${escapeHtml(msg)}</b></div>`
    + `<div class="ma-hint">${escapeHtml(explainAlarm(msg))}</div>`
    + `<div class="ma-actions"><button class="btn small" id="maReset">${t('alarm.reset')}</button>`
    + `<button class="btn small" id="maUnlock">${t('alarm.unlock')}</button>`
    + `<button class="btn small ghost" id="maHelp">${t('alarm.help')}</button></div>`;
  $('#maReset').onclick = () => machineRealtime('reset');
  $('#maUnlock').onclick = () => machineCommand('$X');
  $('#maHelp').onclick = () => { const d = $('#troubleHelp'); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
}
async function machineCommand(line) {
  if (!state.machine.connected) return toast(t('machine.notConnected'), true);
  try { await api('/api/machine/command', { line }); } catch (err) { toast(err.message, true); }
}
async function machineRealtime(code) {
  if (!state.machine.connected) return toast(t('machine.notConnected'), true);
  try { await api('/api/machine/realtime', { code }); } catch (err) { toast(err.message, true); }
}
async function machineJog(axis, sign) {
  if (!state.machine.connected) return toast(t('machine.notConnected'), true);
  const step = Number($('#jogStep').value) || 1;
  const feed = Number($('#jogFeed').value) || 800;
  const dist = (sign < 0 ? '-' : '') + step;
  try { await api('/api/machine/jog', { axis, dist, feed }); } catch (err) { toast(err.message, true); }
}
function machineAction(action) {
  const b = state.result?.board;
  const w = b ? b.width.toFixed(2) : 0;
  const h = b ? b.height.toFixed(2) : 0;
  const need = () => { if (!b) { toast(t('machine.loadFirst'), true); return false; } return true; };
  switch (action) {
    case 'home': return machineCommand('$H');
    case 'unlock': return machineCommand('$X');
    case 'reset': return machineRealtime('reset');
    case 'pause': return machineRealtime('pause');
    case 'resume': return machineRealtime('resume');
    case 'stop': if (confirm(t('confirm.stop'))) machineRealtime('reset'); return;
    case 'setOriginXYZ': if (confirm(t('confirm.setOriginXYZ'))) machineCommand('G10 L20 P0 X0 Y0 Z0'); return;
    case 'setOriginXY': if (confirm(t('confirm.setOriginXY'))) machineCommand('G10 L20 P0 X0 Y0'); return;
    case 'gotoClearance': return machineCommand('M496.1');
    case 'gotoOrigin': return machineCommand('M496.2');
    case 'margin': if (!need()) return; if (confirm(t('confirm.margin'))) machineCommand(`M495 X0Y0C${w}D${h}`); return;
    case 'probe': if (confirm(t('confirm.probe'))) machineCommand('M495 X0Y0O0'); return;
    case 'level': {
      if (!need()) return;
      // Makera PCB default is a 5×5 grid at 2 mm detection height (LED example);
      // add points for larger boards, capped at 9×9.
      const i = Math.min(9, Math.max(5, Math.round(b.width / 15)));
      const j = Math.min(9, Math.max(5, Math.round(b.height / 15)));
      if (confirm(t('confirm.level', { i, j }))) machineCommand(`M495 X0Y0A${w}B${h}I${i}J${j}H2`);
      return;
    }
    case 'autoSetup': {
      if (!need()) return;
      // One combined M495 = Makera "Config and Run": Scan Margin (C/D) +
      // Auto Z Probe (O0) + Auto Leveling (A/B grid, H2) + return to origin (P1).
      const i = Math.min(9, Math.max(5, Math.round(b.width / 15)));
      const j = Math.min(9, Math.max(5, Math.round(b.height / 15)));
      if (confirm(t('confirm.autoSetup', { i, j })))
        machineCommand(`M495 X0Y0C${w}D${h}O0A${w}B${h}I${i}J${j}H2P1`);
      return;
    }
    // --- accessories (Supported Codes) ---
    case 'lightOn': return machineCommand('M821');
    case 'lightOff': return machineCommand('M822');
    case 'vacOn': return machineCommand('M331'); // auto vacuum on
    case 'vacOff': return machineCommand('M332');
    case 'airOn': return machineCommand('M7'); // air assist / airflow
    case 'airOff': return machineCommand('M9');
    case 'fanOn': return machineCommand('M811 S100'); // spindle cooling fan
    case 'fanOff': return machineCommand('M812');
    case 'beepOn': return machineCommand('M861');
    case 'beepOff': return machineCommand('M862');
    case 'readTemp': return machineCommand('M105');
    // --- manual tool change helpers (spindle moves) ---
    case 'colletOpen': if (confirm(t('confirm.colletOpen'))) machineCommand('M490.2'); return;
    case 'colletClose': if (confirm(t('confirm.colletClose'))) machineCommand('M490.1'); return;
    case 'calibrate': if (confirm(t('confirm.calibrate'))) machineCommand('M491'); return;
    // --- leveling map ---
    case 'levelClear': return machineCommand('M370'); // clear bed-leveling data
    case 'levelShow': return machineCommand('M375.1'); // print grid to console
  }
}
function renderRunFiles() {
  const sel = $('#runFile');
  const files = state.result?.files || {};
  const names = Object.keys(files);
  sel.innerHTML = names.map((n) => `<option value="${n}">${n}</option>`).join('');
  if (files['0_full_job.nc']) sel.value = '0_full_job.nc';
}
async function machineUpload(start) {
  if (!state.machine.connected) return toast(t('machine.notConnected'), true);
  const name = $('#runFile').value;
  const gcode = state.result?.files?.[name];
  if (!gcode) return toast(t('machine.noFile'), true);
  if (start && !confirm(t('confirm.runUpload', { name }))) return;
  try {
    const d = await api('/api/machine/run', { name, gcode, start });
    toast(start ? t('machine.started', { path: d.path }) : t('machine.uploaded', { path: d.path }));
    logEvent(start ? 'log.started' : 'log.uploaded', { path: d.path });
  } catch (err) { toast(t('machine.uploadErr', { msg: err.message }), true); logEvent('log.genError', { msg: err.message }, 'error'); }
}

// ---------- connection profiles ----------
function renderConns() {
  const sel = $('#mProfiles');
  sel.innerHTML = `<option value="">${t('conn.profiles')}</option>` +
    state.conns.map((c, i) => `<option value="${i}">${escapeHtml(c.name)} — ${c.ip}:${c.port}</option>`).join('');
}
function saveConn() {
  const ip = $('#mIp').value.trim();
  const port = Number($('#mPort').value) || 2222;
  if (!ip) return toast(t('machine.enterIp'), true);
  const name = prompt(t('conn.namePrompt'), ip) || ip;
  const existing = state.conns.findIndex((c) => c.ip === ip && c.port === port);
  if (existing >= 0) state.conns[existing] = { name, ip, port };
  else state.conns.push({ name, ip, port });
  saveJSON('makera_conns', state.conns);
  renderConns();
  toast(t('conn.saved'));
}
function selectConn() {
  const i = $('#mProfiles').value;
  if (i === '') return;
  const c = state.conns[Number(i)];
  if (c) { $('#mIp').value = c.ip; $('#mPort').value = c.port; }
}
function deleteConn() {
  const i = $('#mProfiles').value;
  if (i === '') return toast(t('conn.selectFirst'), true);
  state.conns.splice(Number(i), 1);
  saveJSON('makera_conns', state.conns);
  renderConns();
  toast(t('conn.deleted'));
}

// ---------- material presets ----------
function renderMaterialPresets() {
  const sel = $('#matPreset');
  if (!sel) return;
  sel.innerHTML = MATERIAL_PRESETS.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join('');
  const saved = loadJSON('makera_material', 'mk-ss-100x150');
  sel.value = MATERIAL_PRESETS.some((m) => m.id === saved) ? saved : 'mk-ss-100x150';
  applyMaterialPreset(sel.value, false);
}
function applyMaterialPreset(id, regen = true) {
  const m = MATERIAL_PRESETS.find((x) => x.id === id) || MATERIAL_PRESETS[0];
  state.matSides = m.sides || 'single';
  saveJSON('makera_material', id);
  if (m.id !== 'custom') {
    if (m.thickness != null) setPath('material.thickness', m.thickness);
    if (m.sizeX != null) setPath('stock.sizeX', m.sizeX);
    if (m.sizeY != null) setPath('stock.sizeY', m.sizeY);
  }
  if (regen) scheduleGenerate();
}
function setPath(path, value) {
  const el = document.querySelector(`[data-path="${path}"]`);
  if (el) el.value = value;
}
function swapStock() {
  const x = $('[data-path="stock.sizeX"]');
  const y = $('[data-path="stock.sizeY"]');
  const t = x.value; x.value = y.value; y.value = t;
  scheduleGenerate();
}

// ---------- standard tools ----------
function loadStandardTools() {
  state.tools = STANDARD_TOOLS.map((t) => ({ ...t }));
  saveJSON('makera_tools', state.tools);
  renderTools();
  renderAssignments();
  scheduleGenerate();
  toast(t('tools.loaded'));
}

// Apply the official Makera PCB-table feeds/speeds to every tool in place.
function applyMakeraPcbFeeds() {
  state.tools = state.tools.map((t) => ({ ...t, ...makeraPcbFeeds(t) }));
  saveJSON('makera_tools', state.tools);
  renderTools();
  scheduleGenerate();
  toast(t('tools.feedsApplied'));
}

// ---------- AI config review ----------
async function loadAiConfig() {
  try {
    const res = await fetch('/api/ai/config');
    const d = await res.json();
    state.aiHasServerKey = !!d.hasKey;
    if (d.model) $('#aiModel').value = d.model; // .env drives the default model
    if (d.hasKey) {
      setAiPill('on', t('ai.serverKey'));
      $('#aiAuto').checked = true; // auto-check on when a server key exists
    }
    updateActionButtons();
  } catch { /* ignore */ }
}
function aiKeyAvailable() { return !!$('#aiKey').value.trim() || state.aiHasServerKey; }
async function aiReview() {
  const apiKey = $('#aiKey').value.trim();
  if (!apiKey && !state.aiHasServerKey) return toast(t('ai.keyRequired'), true);
  if (!state.result) return toast(t('machine.loadFirst'), true);
  if (apiKey) saveJSON('makera_aikey', apiKey);
  const model = $('#aiModel').value.trim() || 'gpt-4o-mini';
  const box = $('#aiResult');
  setAiPill('run', t('ai.pill.checking'));
  box.innerHTML = `<p class="muted">${t('ai.checking')}</p>`;
  try {
    const review = await api('/api/ai/review', {
      apiKey, model,
      config: readConfig(),
      board: state.result.board,
      checks: state.result.checks,
      operations: state.result.operations,
      stats: state.result.stats,
    });
    renderAiReview(review);
    setAiPill('on', t('ai.pill.checked'));
  } catch (err) {
    box.innerHTML = `<div class="ai-summary">${escapeHtml(t('ai.errorLabel', { msg: err.message }))}</div>`;
    setAiPill('off', t('ai.pill.error'));
    toast(t('ai.failed', { msg: err.message }), true);
  }
}
function setAiPill(cls, text) { const p = $('#aiState'); p.className = 'pill ' + cls; p.textContent = text; }
function renderAiReview(review) {
  const box = $('#aiResult');
  const issues = (review.issues || []).map((i) => {
    const ico = i.severity === 'error' ? '⛔' : i.severity === 'warn' ? '⚠' : '✓';
    return `<div class="check ${i.severity || 'ok'}"><span class="ico">${ico}</span><span>${escapeHtml(i.message)}</span></div>`;
  }).join('');
  const patch = review.flatPatch || {};
  const keys = Object.keys(patch);
  let patchHtml = '';
  if (keys.length) {
    const rows = keys.map((k) => {
      const cur = currentConfigValue(k);
      return `<tr><td>${escapeHtml(k)}</td><td class="old">${escapeHtml(String(cur))}</td><td>→</td><td class="new">${escapeHtml(String(patch[k]))}</td></tr>`;
    }).join('');
    patchHtml = `<div class="ai-patch"><b>${t('ai.patchTitle')}</b><table>${rows}</table>
      <button class="btn small" id="aiApply">${t('ai.applyBtn')}</button></div>`;
  } else {
    patchHtml = `<div class="ai-patch">${t('ai.noChanges')}</div>`;
  }
  box.innerHTML = `<div class="ai-summary">${escapeHtml(review.summary || '')}</div>${issues}${patchHtml}`;
  const applyBtn = $('#aiApply', box);
  if (applyBtn) applyBtn.addEventListener('click', () => applyPatch(patch));
}
function currentConfigValue(dotted) {
  const el = document.querySelector(`[data-path="${dotted}"]`);
  return el ? el.value : '(n/a)';
}
function applyPatch(patch) {
  let applied = 0;
  for (const [k, v] of Object.entries(patch)) {
    const el = document.querySelector(`[data-path="${k}"]`);
    if (el) { el.value = v; applied++; }
  }
  if (applied) { toast(t('ai.appliedN', { n: applied })); scheduleGenerate(); }
  else toast(t('ai.noFields'), true);
}

// ---------- demo animation ----------
function buildDemoPlan(preview) {
  const steps = [];
  const isoPaths = [];
  for (const pass of preview.isolation || []) for (const ring of pass) if (ring.length > 1) isoPaths.push(ring.map(([x, y]) => ({ x, y })));
  if (isoPaths.length) steps.push({ name: t('demo.iso'), color: '#ff5a5a', kind: 'mill', paths: isoPaths });
  const byDia = new Map();
  for (const d of preview.drills || []) { const k = d.d.toFixed(2); if (!byDia.has(k)) byDia.set(k, []); byDia.get(k).push(d); }
  for (const [k, pts] of [...byDia.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    steps.push({ name: t('demo.drill', { k }), color: '#4c8dff', kind: 'drill', points: pts });
  }
  const outPaths = (preview.outline || []).map((l) => l.pts.map((p) => ({ x: p.x, y: p.y })));
  if (outPaths.length) steps.push({ name: t('demo.outline'), color: '#2ecc71', kind: 'mill', paths: outPaths });
  if (preview.laser && preview.laser.length) {
    const laserPaths = preview.laser.map((line) => line.map(([x, y]) => ({ x, y })));
    steps.push({ name: t('demo.laser'), color: '#ff59d8', kind: 'mill', paths: laserPaths });
  }
  return steps;
}
function pathLen(path) { let L = 0; for (let i = 1; i < path.length; i++) L += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y); return L; }

function demoStart() {
  if (!state.result) return;
  // demo runs on the 2D canvas
  if (state.view !== '2d') { $$('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === '2d')); state.view = '2d'; show2d(); }
  const plan = buildDemoPlan(state.result.preview);
  if (!plan.length) return;
  state.demo.playing = true;
  $('#demoPlay').classList.add('hidden');
  $('#demoStop').classList.remove('hidden');
  $('#demoBanner').classList.remove('hidden');
  const view = computeView();
  const canvas = $('#preview');
  const ctx = canvas.getContext('2d');

  let stepIdx = 0;
  let millDist = 0;        // distance progressed within current mill step
  let drillIdx = 0;        // hole index within current drill step
  let drillTimer = 0;
  let last = performance.now();

  const frame = (now) => {
    if (!state.demo.playing) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const speedMm = 20 + Number($('#demoSpeed').value) * 6; // mm per second (scaled)
    const step = plan[stepIdx];

    // draw base
    drawDemoBase(ctx, view);
    // completed steps faded
    for (let i = 0; i < stepIdx; i++) drawStepFull(ctx, view, plan[i], 0.5);

    if (step.kind === 'mill') {
      millDist += speedMm * dt;
      const tool = drawMillProgress(ctx, view, step, millDist);
      $('#demoBanner').innerHTML = `<span class="stepname">Schritt ${stepIdx + 1}/${plan.length}: ${step.name}</span>`;
      if (tool.done) { stepIdx++; millDist = 0; }
    } else {
      // drilling: reveal holes over time
      drillTimer += dt;
      const per = 0.12; // seconds per hole
      while (drillTimer > per && drillIdx < step.points.length) { drillTimer -= per; drillIdx++; }
      drawDrillProgress(ctx, view, step, drillIdx);
      $('#demoBanner').innerHTML = `<span class="stepname">Schritt ${stepIdx + 1}/${plan.length}: ${step.name}</span> · ${drillIdx}/${step.points.length}`;
      if (drillIdx >= step.points.length) { stepIdx++; drillIdx = 0; drillTimer = 0; }
    }

    if (stepIdx >= plan.length) { demoStop(true); return; }
    state.demo.raf = requestAnimationFrame(frame);
  };
  state.demo.raf = requestAnimationFrame(frame);
}
function demoStop(finished) {
  state.demo.playing = false;
  if (state.demo.raf) cancelAnimationFrame(state.demo.raf);
  $('#demoPlay').classList.remove('hidden');
  $('#demoPlay').disabled = !state.result;
  $('#demoStop').classList.add('hidden');
  if (finished) { $('#demoBanner').innerHTML = t('demo.done'); setTimeout(() => $('#demoBanner').classList.add('hidden'), 2500); }
  else $('#demoBanner').classList.add('hidden');
  if (state.result) drawPreview();
}
function computeView() {
  const canvas = $('#preview');
  const wrap = canvas.parentElement;
  const board = state.result.preview.board;
  const dpr = window.devicePixelRatio || 1;
  const margin = 16;
  const cssW = wrap.clientWidth || 900;
  let scale = (cssW - 2 * margin) / board.width;
  let cssH = board.height * scale + 2 * margin;
  const maxH = 460;
  if (cssH > maxH) { scale = (maxH - 2 * margin) / board.height; cssH = maxH; }
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { scale, margin, cssW, cssH, board, X: (x) => margin + x * scale, Y: (y) => cssH - margin - y * scale };
}
function drawDemoBase(ctx, v) {
  ctx.clearRect(0, 0, v.cssW, v.cssH);
  ctx.strokeStyle = '#31405c'; ctx.lineWidth = 1;
  ctx.strokeRect(v.X(0), v.Y(v.board.height), v.board.width * v.scale, v.board.height * v.scale);
  const p = state.result.preview;
  ctx.beginPath();
  for (const ring of p.copper) { ring.forEach(([x, y], i) => (i ? ctx.lineTo(v.X(x), v.Y(y)) : ctx.moveTo(v.X(x), v.Y(y)))); ctx.closePath(); }
  ctx.fillStyle = 'rgba(217,130,43,0.35)'; ctx.fill('evenodd');
}
function drawStepFull(ctx, v, step, alpha) {
  ctx.globalAlpha = alpha;
  if (step.kind === 'mill') {
    ctx.strokeStyle = step.color; ctx.lineWidth = 1.3;
    for (const path of step.paths) { ctx.beginPath(); path.forEach((pt, i) => (i ? ctx.lineTo(v.X(pt.x), v.Y(pt.y)) : ctx.moveTo(v.X(pt.x), v.Y(pt.y)))); ctx.stroke(); }
  } else {
    ctx.fillStyle = step.color;
    for (const d of step.points) { ctx.beginPath(); ctx.arc(v.X(d.x), v.Y(d.y), Math.max(1.5, (d.d / 2) * v.scale), 0, 7); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
}
function drawMillProgress(ctx, v, step, dist) {
  ctx.strokeStyle = step.color; ctx.lineWidth = 1.6;
  let remaining = dist;
  let toolPt = null;
  let done = true;
  for (const path of step.paths) {
    const L = pathLen(path);
    if (remaining <= 0) { done = false; break; }
    if (remaining >= L) {
      ctx.beginPath(); path.forEach((pt, i) => (i ? ctx.lineTo(v.X(pt.x), v.Y(pt.y)) : ctx.moveTo(v.X(pt.x), v.Y(pt.y)))); ctx.stroke();
      remaining -= L;
      toolPt = path[path.length - 1];
    } else {
      // partial
      ctx.beginPath(); ctx.moveTo(v.X(path[0].x), v.Y(path[0].y));
      let acc = 0;
      for (let i = 1; i < path.length; i++) {
        const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
        if (acc + seg <= remaining) { ctx.lineTo(v.X(path[i].x), v.Y(path[i].y)); acc += seg; toolPt = path[i]; }
        else { const t = (remaining - acc) / seg; const px = path[i - 1].x + (path[i].x - path[i - 1].x) * t; const py = path[i - 1].y + (path[i].y - path[i - 1].y) * t; ctx.lineTo(v.X(px), v.Y(py)); toolPt = { x: px, y: py }; break; }
      }
      ctx.stroke();
      done = false;
      remaining = 0;
      break;
    }
  }
  if (toolPt) { ctx.beginPath(); ctx.arc(v.X(toolPt.x), v.Y(toolPt.y), 4, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = step.color; ctx.lineWidth = 2; ctx.stroke(); }
  return { done };
}
function drawDrillProgress(ctx, v, step, count) {
  ctx.fillStyle = step.color;
  for (let i = 0; i < count && i < step.points.length; i++) {
    const d = step.points[i];
    ctx.beginPath(); ctx.arc(v.X(d.x), v.Y(d.y), Math.max(1.5, (d.d / 2) * v.scale), 0, 7); ctx.fill();
  }
  const cur = step.points[Math.min(count, step.points.length - 1)];
  if (cur) { ctx.beginPath(); ctx.arc(v.X(cur.x), v.Y(cur.y), 7, 0, 7); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
}

// ---------- downloads ----------
function downloadText(name, content) { triggerDownload(new Blob([content], { type: 'text/plain' }), name); }
async function downloadZip() {
  try {
    const res = await fetch('/api/zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: { ...state.result.files, 'FERTIGUNGSPLAN.md': state.result.report } }) });
    if (!res.ok) throw new Error('ZIP fehlgeschlagen');
    triggerDownload(await res.blob(), 'makera-pcb.zip');
  } catch (err) { toast(err.message, true); }
}
function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- misc ----------
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('err', isErr); t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------- wiring ----------
// ---------- app metadata (version + repo link) ----------
async function loadMeta() {
  try {
    const res = await fetch('/api/meta');
    const d = await res.json();
    const ver = $('#appVersion');
    if (ver && d.version) {
      ver.textContent = 'v' + d.version;
      if (d.repo) ver.href = d.repo; else { ver.removeAttribute('href'); ver.style.cursor = 'default'; }
    }
    const gh = $('#ghLink');
    if (gh && d.repo) { gh.href = d.repo; gh.classList.remove('hidden'); }
  } catch { /* ignore */ }
}

// ---------- language ----------
function reapplyLanguage() {
  applyI18n();
  renderConns();
  renderTools();
  renderAssignments();
  drawMaterialPreview();
  if (state.result) renderAll();
  if (!state.machine.connected) setPill('off', t('machine.disconnected'));
  if (state.aiHasServerKey) setAiPill('on', t('ai.serverKey'));
  else if ($('#aiKey').value.trim()) setAiPill('on', t('ai.ready'));
  renderProjects();
  renderLog();
}

// ---------- projects (save/load full workspace) ----------
const PROJ_KEY = 'makera_projects';
const PROJ_CUR = 'makera_project_current';
function loadProjects() { return loadJSON(PROJ_KEY, {}); }
function saveProjects(p) { saveJSON(PROJ_KEY, p); }
function currentProjectId() { try { return localStorage.getItem(PROJ_CUR) || ''; } catch { return ''; } }
function setCurrentProjectId(id) { try { localStorage.setItem(PROJ_CUR, id || ''); } catch {} }

// Snapshot everything needed to reproduce a job: files, form config, tools,
// step assignment, material and layer visibility.
function projectSnapshot() {
  const form = {};
  for (const el of $$('[data-path]')) form[el.dataset.path] = el.type === 'checkbox' ? el.checked : el.value;
  return {
    v: 1, savedAt: Date.now(),
    files: state.files,
    form,
    matPreset: $('#matPreset')?.value || 'custom',
    matSides: state.matSides || 'single',
    tools: state.tools,
    assignment: state.assignment,
    layers: state.layers,
    aiModel: $('#aiModel')?.value || '',
    log: state.projectLog,
  };
}
function hasWorkspace() {
  return !!(state.files.copper || state.files.edge || state.files.drill || state.files.silk);
}
function applyProject(p) {
  if (!p) return;
  state.files = { copper: null, edge: null, drill: null, silk: null };
  for (const role of ['copper', 'edge', 'drill', 'silk']) {
    const f = p.files?.[role];
    const slot = $(`.slot[data-role="${role}"]`);
    if (f && f.content) { state.files[role] = { name: f.name, content: f.content }; slot.classList.add('filled'); $('[data-name]', slot).textContent = f.name; }
    else if (slot) { slot.classList.remove('filled'); $('[data-name]', slot).textContent = '—'; }
  }
  if (p.form) for (const [path, val] of Object.entries(p.form)) {
    const el = document.querySelector(`[data-path="${path}"]`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
  }
  if (p.matPreset && $('#matPreset')) $('#matPreset').value = p.matPreset;
  state.matSides = p.matSides || 'single';
  if (Array.isArray(p.tools) && p.tools.length) { state.tools = p.tools.map(withToolDefaults); saveJSON('makera_tools', state.tools); }
  if (p.assignment) { state.assignment = p.assignment; saveJSON('makera_assignment', state.assignment); }
  if (p.layers) { state.layers = { ...state.layers, ...p.layers }; $$('[data-layer]').forEach((cb) => { cb.checked = !!state.layers[cb.dataset.layer]; }); }
  if (p.aiModel && $('#aiModel')) $('#aiModel').value = p.aiModel;
  state.projectLog = Array.isArray(p.log) ? p.log.slice() : [];
  renderLog();
  $('#generate').disabled = !state.files.copper;
  state.result = null;
  state.fab.done = {}; state.fab.view = null;
  renderTools();
  renderAssignments();
  drawMaterialPreview();
  if (state.files.copper) generate(); else renderFab();
}
function fmtDate(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(getLang() === 'de' ? 'de-DE' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
function renderProjects() {
  const sel = $('#projSel');
  if (!sel) return;
  const projs = loadProjects();
  const cur = currentProjectId();
  const ids = Object.keys(projs).sort((a, b) => (projs[b].savedAt || 0) - (projs[a].savedAt || 0));
  sel.innerHTML = `<option value="">${t('proj.none')}</option>` +
    ids.map((id) => {
      const d = fmtDate(projs[id].createdAt || projs[id].savedAt);
      return `<option value="${id}" ${id === cur ? 'selected' : ''}>${escapeHtml(projs[id].name || id)}${d ? ' · ' + d : ''}</option>`;
    }).join('');
}
function projSaveAs() {
  const name = prompt(t('proj.namePrompt'), t('proj.defaultName'));
  if (!name) return;
  const projs = loadProjects();
  const id = 'p' + Date.now().toString(36);
  projs[id] = { ...projectSnapshot(), name, createdAt: Date.now() };
  saveProjects(projs); setCurrentProjectId(id); renderProjects();
  toast(t('proj.saved', { name }));
}
function projSave() {
  const cur = currentProjectId();
  const projs = loadProjects();
  if (!cur || !projs[cur]) return projSaveAs();
  const name = projs[cur].name || t('proj.defaultName');
  projs[cur] = { ...projectSnapshot(), name, createdAt: projs[cur].createdAt || Date.now() };
  saveProjects(projs); renderProjects();
  toast(t('proj.saved', { name }));
}
function projLoad(id) {
  if (!id) return;
  const projs = loadProjects();
  const p = projs[id];
  if (!p) return;
  setCurrentProjectId(id); renderProjects();
  applyProject(p);
  logEvent('log.projectLoaded', {});
  toast(t('proj.loaded', { name: p.name || id }));
}
function projNew() {
  if (hasWorkspace() && !confirm(t('proj.newConfirm'))) return;
  setCurrentProjectId('');
  applyProject({ files: {}, form: {}, tools: STANDARD_TOOLS.map((x) => ({ ...x })), assignment: {}, matPreset: 'mk-ss-100x150', matSides: 'single' });
  renderProjects();
}
function projDelete() {
  const cur = currentProjectId();
  const projs = loadProjects();
  if (!cur || !projs[cur]) return;
  if (!confirm(t('proj.deleteConfirm', { name: projs[cur].name || cur }))) return;
  delete projs[cur]; saveProjects(projs); setCurrentProjectId(''); renderProjects();
  toast(t('proj.deleted'));
}
function projExport() {
  const cur = currentProjectId();
  const projs = loadProjects();
  const p = (cur && projs[cur]) ? projs[cur] : { ...projectSnapshot(), name: t('proj.defaultName') };
  if (!hasWorkspace() && !(cur && projs[cur])) return toast(t('proj.nothingToSave'), true);
  const safe = (p.name || 'project').replace(/[^\w.\-]/g, '_');
  downloadText(`${safe}.mkpcb.json`, JSON.stringify(p, null, 2));
}
function projImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const p = JSON.parse(String(reader.result));
      if (!p || (!p.form && !p.files && !p.tools)) throw new Error('invalid');
      const projs = loadProjects();
      const id = 'p' + Date.now().toString(36);
      const name = p.name || t('proj.defaultName');
      projs[id] = { ...p, name, savedAt: Date.now(), createdAt: p.createdAt || Date.now() };
      saveProjects(projs); setCurrentProjectId(id); renderProjects();
      applyProject(projs[id]);
      toast(t('proj.imported', { name }));
    } catch { toast(t('proj.importError'), true); }
  };
  reader.readAsText(file);
}

function init() {
  const dz = $('#dropzone');
  const fi = $('#fileInput');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => handleFiles(fi.files));
  ['dragenter', 'dragover'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (ev) => handleFiles(ev.dataTransfer.files));

  $('#generate').addEventListener('click', generate);
  $$('[data-path]').forEach((el) => el.addEventListener('change', scheduleGenerate));
  $('#loadExample').addEventListener('click', loadExample);

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.tab-body').forEach((b) => b.classList.add('hidden'));
    $(`[data-body="${tab.dataset.tab}"]`).classList.remove('hidden');
  }));

  $$('.wf-tab').forEach((tab) => tab.addEventListener('click', () => switchWf(tab.dataset.wf)));

  $$('.vt').forEach((btn) => btn.addEventListener('click', () => {
    $$('.vt').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.dataset.view;
    if (!state.result) return;
    if (state.view === '3d') show3d(); else show2d();
  }));

  $$('[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
    state.layers[cb.dataset.layer] = cb.checked;
    if (!state.result) return;
    if (state.view === '3d' && state.viewer3d) state.viewer3d.setLayers(state.layers); else drawPreview();
  }));
  window.addEventListener('resize', () => { if (state.result && state.view === '2d') drawPreview(); });

  $('#addTool').addEventListener('click', () => {
    const n = (state.tools.reduce((m, t) => Math.max(m, t.number), 0) || 0) + 1;
    state.tools.push({ number: n, type: 'endmill', diameter: 1.0, collet: 2, label: '' });
    saveJSON('makera_tools', state.tools); renderTools(); renderAssignments();
  });

  // machine
  $('#mDiscover').addEventListener('click', machineDiscover);
  $('#mConnect').addEventListener('click', machineConnect);
  $('#mDisconnect').addEventListener('click', machineDisconnect);
  $('#mdiSend').addEventListener('click', () => { const v = $('#mdiInput').value.trim(); if (v) { machineCommand(v); $('#mdiInput').value = ''; } });
  $('#mdiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#mdiSend').click(); });
  $$('[data-action]').forEach((b) => b.addEventListener('click', () => machineAction(b.dataset.action)));
  $$('[data-jog]').forEach((b) => b.addEventListener('click', () => machineJog(b.dataset.jog, Number(b.dataset.sign))));
  $('#mUpload').addEventListener('click', () => machineUpload(false));
  $('#mRun').addEventListener('click', () => machineUpload(true));
  $('#machDiag').addEventListener('click', (e) => { if (e.target && e.target.id === 'machRetry') machineRetry(); });

  // material presets
  $('#matPreset').addEventListener('change', () => applyMaterialPreset($('#matPreset').value));
  $('#swapStock').addEventListener('click', swapStock);
  // manual edits of stock/thickness switch the preset to "custom"
  ['stock.sizeX', 'stock.sizeY', 'material.thickness'].forEach((path) => {
    const el = document.querySelector(`[data-path="${path}"]`);
    if (el) el.addEventListener('input', () => { $('#matPreset').value = 'custom'; state.matSides = 'single'; saveJSON('makera_material', 'custom'); });
  });

  // tools
  $('#loadStdTools').addEventListener('click', loadStandardTools);
  $('#makeraFeeds').addEventListener('click', applyMakeraPcbFeeds);

  // connection profiles
  $('#mProfiles').addEventListener('change', selectConn);
  $('#mSaveConn').addEventListener('click', saveConn);
  $('#mDelConn').addEventListener('click', deleteConn);

  // AI
  const savedKey = loadJSON('makera_aikey', '');
  if (savedKey) { $('#aiKey').value = savedKey; setAiPill('on', t('ai.ready')); }
  $('#aiKey').addEventListener('input', () => { updateActionButtons(); });
  $('#aiReview').addEventListener('click', aiReview);

  // Demo
  $('#demoPlay').addEventListener('click', demoStart);
  $('#demoStop').addEventListener('click', () => demoStop(false));

  // Fabrication live/simulation
  $('#fabPlay').addEventListener('click', fabPlay);
  $('#fabStop').addEventListener('click', fabStop);
  $('#logClear').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); state.projectLog = []; const cur = currentProjectId(); const projs = loadProjects(); if (cur && projs[cur]) { projs[cur].log = []; saveProjects(projs); } renderLog(); });

  // language switcher
  const langSel = $('#langSel');
  if (langSel) {
    langSel.value = getLang();
    langSel.addEventListener('change', () => { setLang(langSel.value); reapplyLanguage(); });
  }

  // projects
  $('#projSel').addEventListener('change', () => projLoad($('#projSel').value));
  $('#projNew').addEventListener('click', projNew);
  $('#projSave').addEventListener('click', projSave);
  $('#projSaveAs').addEventListener('click', projSaveAs);
  $('#projDelete').addEventListener('click', projDelete);
  $('#projExport').addEventListener('click', projExport);
  $('#projImport').addEventListener('click', () => $('#projImportFile').click());
  $('#projImportFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) projImport(f); e.target.value = ''; });

  renderMaterialPresets();
  renderConns();
  loadAiConfig();
  loadMeta();
  saveJSON('makera_tools', state.tools); // persist backfilled feeds/speeds
  renderTools();
  renderAssignments();
  updateActionButtons();
  renderProjects();
  applyI18n(); // translate all static markup for the active language
  switchWf(loadJSON('makera_wf', 'material'));

  // resume the last open project (full workspace) if there is one
  const cur = currentProjectId();
  const projs = loadProjects();
  if (cur && projs[cur]) applyProject(projs[cur]);
}

async function loadExample() {
  try {
    const res = await fetch('/api/example');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('example.error'));
    setFile('copper', data.names.copper, data.copper);
    setFile('edge', data.names.edge, data.edge);
    setFile('drill', data.names.drill, data.drill);
    if (data.silk) setFile('silk', data.names.silk, data.silk);
    toast(t('example.loaded'));
  } catch (err) { toast(err.message, true); }
}

init();
