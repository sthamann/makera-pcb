// makera-pcb browser UI (module). The 3D viewer (three.js) is loaded lazily so
// the core 2D workflow never depends on it.

import { t, applyI18n, getLang, setLang } from './i18n.js';
import {
  ANCHOR1_OFFSET,
  gotoWorkXYCommands,
  gotoWorkOriginCommands,
  gotoAnchor1Command,
  setOriginAtAnchorOffsetCommands,
  anchor1Readiness,
  originIsSet,
  notHomedFromStatus,
  levelingGrid,
  zProbeCommand,
  scanMarginCommand,
  autoLevelCommand,
  configAndRunCommand,
  insertProbeCommand,
  VACUUM_ON_COMMAND,
  VACUUM_OFF_COMMAND,
  VACUUM_LINGER_DEFAULT_S,
} from './machine-commands.js';
import {
  LEVELING_MAX_DEV_WARN_MM,
  parseLevelingFromLog,
  assessHeightMap,
  drawHeightMap2D,
} from './height-map.js';
import { SETUP_PLACED_KEY, resetProjectScopedState } from './project-reset.js';
import {
  boardFitsStock,
  smallestFittingStock,
  snapPlacement,
  clampPlacementOffset,
  BOARD_INSET_ON_STOCK,
  BRACKET_ARM_MM,
  BRACKET_ARM_LENGTH_MM,
} from './stock-fit.js';
import {
  JobMonitor,
  JOB_STATE,
  RESUME_TOOL_CHANGE_COMMAND,
  ABORT_JOB_COMMANDS,
  isToolChangeWait,
  toolChangeTarget,
  planVacuumForTransition,
} from './job-monitor.js';

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

// Makera PCB Fabrication Pack toolkit (bits that ship with the PCB kit).
// Feeds/speeds are the official Makera PCB-table recommendations.
const STANDARD_TOOLS = [
  { number: 1, type: 'vbit', diameter: 0.2, collet: 2, label: 'V-Bit 30° 0.2mm (Isolation)', feedXY: 500, plungeFeed: 200, rpm: 12000 },
  { number: 2, type: 'vbit', diameter: 0.3, collet: 2, label: 'Engraving 30° 0.3mm (Lötstopplack)', feedXY: 400, plungeFeed: 200, rpm: 6000 },
  { number: 3, type: 'vbit', diameter: 0.5, collet: 2, label: 'Engraving 30° 0.5mm (Lötstopplack)', feedXY: 400, plungeFeed: 200, rpm: 6000 },
  { number: 4, type: 'endmill', diameter: 2.0, collet: 2, label: 'Corn-Bit 2mm (Kupfer-Clearing)', feedXY: 500, plungeFeed: 300, rpm: 12000 },
  { number: 5, type: 'endmill', diameter: 2.0, collet: 2, label: 'Spiral-O 2mm (Außenkontur)', feedXY: 500, plungeFeed: 300, rpm: 12000 },
  { number: 6, type: 'drill', diameter: 2.0, collet: 2, label: 'TiN Bohrer 2mm', feedXY: 1000, plungeFeed: 200, rpm: 10000, peck: 1.0 },
  { number: 7, type: 'laser', diameter: 0.1, collet: 2, label: 'Laser 5W (Silkscreen-Gravur)', feedXY: 100, plungeFeed: 0, rpm: 0 },
];

// Default step → tool mapping for the PCB pack (both endmills are 2 mm — pick by role).
const DEFAULT_PCB_ASSIGNMENT = {
  isolation: 1,
  clearing: 4,
  outline: 5,
  maskRemove: 2,
  laser: 7,
};

// Prefer a tool whose label matches the operation when several share the same Ø.
const OP_TOOL_PREFER = {
  isolation: (t) => /isol|v-bit|vbit|0\.2/i.test(t.label || ''),
  clearing: (t) => /corn|clearing|kupfer|fläche|flache/i.test(t.label || ''),
  outline: (t) => /spiral|kontur|outline|profil|außen/i.test(t.label || ''),
  maskRemove: (t) => /löt|mask|engrav|stopplack|0\.3/i.test(t.label || ''),
};

function pickToolForOp(op) {
  const candidates = state.tools.filter((t) => t.type === op.toolType);
  if (!candidates.length) return null;
  const prefer = OP_TOOL_PREFER[op.id];
  const pool = prefer && candidates.some(prefer) ? candidates.filter(prefer) : candidates;
  let best = pool[0];
  let bestD = Infinity;
  for (const t of pool) {
    const d = Math.abs(t.diameter - op.diameter);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

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
  layers: { copper: true, silk: true, isolation: true, clearing: true, drills: true, outline: true, laser: true, stock: true },
  tools: loadTools(),
  assignment: loadJSON('makera_assignment', {}),
  conns: loadJSON('makera_conns', []),
  machine: { connected: false, timer: null },
  demo: { playing: false, raf: null },
  aiHasServerKey: false,
  aiLastHash: null,
  fab: { steps: [], done: {}, active: null, dry: {}, view: null, anim: { raf: null, playing: false }, job: null },
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
  const place = activePlacement();
  if (place.x || place.y) out.push(t('fab.placementNote', { x: place.x, y: place.y }));
  const vs = vacuumSettings();
  if (vs.enable) out.push(t('fab.vacuumNote', { linger: vs.lingerSec }));
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
  if (op.id === 'clearing') return t('op.clearing');
  if (op.id === 'maskRemove') return t('op.maskRemove');
  if (op.id === 'laser') return t('op.laser');
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
    const best = pickToolForOp(op);
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
      // Steps that run OUTSIDE the combined spindle job get a visible badge
      // (laser = own program, mask removal = guided manual step).
      const sep = op.separate
        ? ` <span class="assign-sep" title="${t(op.id === 'laser' ? 'tools.sepLaserTitle' : 'tools.sepManualTitle')}">${t(op.id === 'laser' ? 'tools.sepLaser' : 'tools.sepManual')}</span>`
        : '';
      return `<div class="assign-row${un}"><span>${escapeHtml(opTitle(op))} <span class="meta">(${op.toolType} ${op.diameter.toFixed(2)}mm)</span>${sep}</span>
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
    const best = pickToolForOp(op);
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

// ---------- board placement on the blank (drag & drop) ----------
// The offset lives in the two data-path inputs (placement.offsetX/Y): they
// feed readConfig() → the pipeline (the ONE insertion point is the shifted
// G-code work origin in src/pipeline.js), the project snapshot persists them
// and every change re-generates automatically.
function placementOffset() {
  return {
    x: Math.max(0, Number($('#placeOffX')?.value) || 0),
    y: Math.max(0, Number($('#placeOffY')?.value) || 0),
  };
}
// The placement the CURRENT result was generated with — machine commands
// (scan margin / leveling / Z-probe) must match the generated G-code, not a
// possibly newer input value that hasn't been re-generated yet.
function activePlacement() {
  const p = state.result?.placement;
  return { x: Math.max(0, Number(p?.x) || 0), y: Math.max(0, Number(p?.y) || 0) };
}
function setPlacementOffset(x, y) {
  const ox = $('#placeOffX');
  const oy = $('#placeOffY');
  if (ox) ox.value = String(x);
  if (oy) oy.value = String(y);
}
// Snap to the 0.5 mm grid and keep the board (incl. clamp margin) on the blank.
function normalizePlacement(x, y) {
  let nx = snapPlacement(x);
  let ny = snapPlacement(y);
  const b = state.result?.board;
  const stock = stockDims();
  if (b && stock) ({ x: nx, y: ny } = clampPlacementOffset(b.width, b.height, stock.sizeX, stock.sizeY, nx, ny));
  return { x: nx, y: ny };
}
// Fit an arbitrary extent {minX,minY,maxX,maxY} (mm) into a canvas; returns a
// transform. Y is flipped so +Y points up.
function fitScene(canvas, ext, maxH = 460, view = null) {
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
  // Optional user zoom/pan (2D preview only). eff = fit scale × zoom; pan in px.
  const z = view && view.zoom ? view.zoom : 1;
  const px = view ? (view.panX || 0) : 0;
  const py = view ? (view.panY || 0) : 0;
  const eff = scale * z;
  const X = (x) => margin + (x - ext.minX) * eff + px;
  const Y = (y) => cssH - margin - (y - ext.minY) * eff + py;
  return {
    ctx, scale: eff, baseScale: scale, cssW, cssH, margin, ext,
    X, Y,
    // inverse: screen (css px) → world (mm)
    invX: (sx) => (sx - margin - px) / eff + ext.minX,
    invY: (sy) => ext.minY + (cssH - margin - (sy - py)) / eff,
  };
}

// Board placement offset on the stock + scene extent (union). The work origin
// sits AT anchor 1 = the blank's corner, so the board's DEFAULT bottom-left
// corner lands right there (BOARD_INSET_ON_STOCK = 0/0, see stock-fit.js). The
// user's drag & drop placement offset shifts the board from there; the fit
// check uses the same numbers.
function boardOnStock(board, stock) {
  const place = placementOffset();
  const offX = BOARD_INSET_ON_STOCK.x + place.x;
  const offY = BOARD_INSET_ON_STOCK.y + place.y;
  if (!stock) return { offX, offY, ext: { minX: 0, minY: 0, maxX: offX + board.width, maxY: offY + board.height } };
  return {
    offX, offY,
    ext: {
      minX: 0, minY: 0,
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
  if (!stock && !board) {
    const c = canvas.getContext('2d'); c.clearRect(0, 0, canvas.width, canvas.height);
    if (info) info.textContent = '';
    const w0 = $('#matWarn'); if (w0) { w0.classList.add('hidden'); w0.innerHTML = ''; }
    return;
  }
  const ext = stock ? boardOnStock(board || { width: 0, height: 0 }, stock).ext : { minX: 0, minY: 0, maxX: board.width, maxY: board.height };
  if (stock) {
    // show the L-bracket arms the blank rests against (anchor 1 sits at the
    // arms' outer corner, BRACKET_ARM_MM outside the blank's corner)
    ext.minX = -BRACKET_ARM_MM.x;
    ext.minY = -BRACKET_ARM_MM.y;
  }
  const v = fitScene(canvas, ext, 300);
  const { ctx, X, Y } = v;
  if (stock) {
    const armLen = Math.min(BRACKET_ARM_LENGTH_MM, Math.min(stock.sizeX, stock.sizeY));
    // Makera anchor / L-bracket the blank rests against. Dimmed + outlined so
    // it reads as a corner clamp (not a solid block) and labelled, so it is
    // clear this is the reference hardware, not part of the board.
    const armX = X(-BRACKET_ARM_MM.x);
    ctx.fillStyle = 'rgba(138,148,166,0.28)';
    ctx.strokeStyle = 'rgba(138,148,166,0.8)';
    ctx.lineWidth = 1;
    // vertical arm (blank rests against its right edge at x = 0)
    ctx.fillRect(armX, Y(armLen - BRACKET_ARM_MM.y), BRACKET_ARM_MM.x * v.scale, armLen * v.scale);
    ctx.strokeRect(armX, Y(armLen - BRACKET_ARM_MM.y), BRACKET_ARM_MM.x * v.scale, armLen * v.scale);
    // horizontal arm (blank rests on its top edge at y = 0)
    ctx.fillRect(armX, Y(0), (armLen + BRACKET_ARM_MM.x) * v.scale, BRACKET_ARM_MM.y * v.scale);
    ctx.strokeRect(armX, Y(0), (armLen + BRACKET_ARM_MM.x) * v.scale, BRACKET_ARM_MM.y * v.scale);
    // "Anker" label along the vertical arm
    ctx.save();
    ctx.translate(X(-BRACKET_ARM_MM.x / 2), Y(armLen / 2));
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = 'rgba(214,220,232,0.95)';
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('mat.lblAnchor'), 0, 0);
    ctx.restore();
    // the blank
    ctx.fillStyle = 'rgba(189,160,106,0.9)';
    ctx.fillRect(X(0), Y(stock.sizeY), stock.sizeX * v.scale, stock.sizeY * v.scale);
    ctx.strokeStyle = '#7a6a45'; ctx.lineWidth = 1; ctx.strokeRect(X(0), Y(stock.sizeY), stock.sizeX * v.scale, stock.sizeY * v.scale);
  }
  const warn = $('#matWarn');
  if (board) {
    const { offX, offY } = boardOnStock(board, stock);
    const place = placementOffset();
    const p = state.result.preview;
    const BX = (x) => X(x + offX), BY = (y) => Y(y + offY);
    // Fit via the SHARED stock-fit logic (anchor offset + clamp margin +
    // placement offset) — the same function the feasibility check uses.
    const fit = stock
      ? boardFitsStock(board.width, board.height, stock.sizeX, stock.sizeY, { offset: place })
      : { fits: true };
    // remember the transform + board rect for the drag & drop hit test
    state._vMat = { v, offX, offY, board };
    // copper faint
    ctx.beginPath();
    for (const ring of p.copper) { ring.forEach(([x, y], i) => (i ? ctx.lineTo(BX(x), BY(y)) : ctx.moveTo(BX(x), BY(y)))); ctx.closePath(); }
    ctx.fillStyle = 'rgba(120,72,24,0.55)'; ctx.fill('evenodd');
    // board outline (red when it leaves the blank / clamp margin)
    ctx.strokeStyle = fit.fits ? '#2ecc71' : '#ff5a5a'; ctx.lineWidth = 1.5;
    ctx.strokeRect(BX(0), BY(board.height), board.width * v.scale, board.height * v.scale);
    const offStr = (place.x || place.y)
      ? ` · ${t('mat.infoOffset')} <b>X ${place.x} / Y ${place.y} mm</b>`
      : '';
    if (info) info.innerHTML = `${t('mat.infoStock')} <b>${stock ? stock.sizeX + ' × ' + stock.sizeY : '—'} mm</b> · ${t('mat.infoBoard')} <b>${board.width.toFixed(1)} × ${board.height.toFixed(1)} mm</b>${offStr} · ${fit.fits ? `<span style="color:var(--ok)">${t('mat.fits')}</span>` : `<span style="color:var(--err)">${t('mat.notFits')}</span>`}`;
    if (warn) {
      if (stock && !fit.fits) {
        const alt = smallestFittingStock(board.width, board.height, MATERIAL_PRESETS, { offset: place });
        const hint = alt
          ? t('mat.fitHintStock', { label: alt.label })
          : t('mat.fitHintNone');
        warn.classList.remove('hidden');
        warn.innerHTML = `<b>⛔ ${t('mat.fitWarnTitle')}</b> ${t('mat.fitWarnBody', {
          need: `${fit.requiredX.toFixed(1)} × ${fit.requiredY.toFixed(1)}`,
          stock: `${stock.sizeX} × ${stock.sizeY}`,
          margin: fit.margin,
        })} ${(place.x || place.y) ? t('mat.fitWarnOffset', { x: place.x, y: place.y }) : ''} ${hint}`;
      } else {
        warn.classList.add('hidden');
        warn.innerHTML = '';
      }
    }
  } else {
    state._vMat = null;
    if (info) info.innerHTML = `${t('mat.infoStock')} <b>${stock.sizeX} × ${stock.sizeY} mm</b> ${t('mat.noBoard')}`;
    if (warn) { warn.classList.add('hidden'); warn.innerHTML = ''; }
  }
  // Work origin (0/0) marker at the blank corner — drawn last so it stays on
  // top of the board/copper. When the board is placed away from the corner
  // (placement offset ≠ 0) the marker turns RED and spells out the exact shift
  // in mm, plus a dashed line to the board corner, so it is obvious the job
  // will NOT start at the board's corner and the copper must be placed there.
  if (stock) {
    const place = placementOffset();
    const shifted = place.x > 0 || place.y > 0;
    const col = shifted ? '#ff5a5a' : '#4c8dff';
    if (shifted && board) {
      const { offX, offY } = boardOnStock(board, stock);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,90,90,0.9)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(offX), Y(offY)); ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(X(0), Y(0), 4, 0, 7); ctx.stroke();
    ctx.fillStyle = col;
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const label = shifted ? t('mat.originShift', { x: place.x, y: place.y }) : t('mat.lblOrigin');
    ctx.fillText(label, X(0) + 7, Y(0) - 3);
  }
}

// ---------- material preview: board drag & drop ----------
// Grab the board in the blank preview and drag it (mouse + touch, pointer
// events). Snaps to the 0.5 mm grid, clamps to the blank incl. clamp margin,
// re-runs the fit check live on every move and regenerates on release.
function bindMaterialDrag() {
  const cv = $('#matCanvas');
  if (!cv) return;
  let dragging = false;
  let grab = { x: 0, y: 0 }; // grab point inside the board, in mm
  const worldPos = (e) => {
    const m = state._vMat;
    if (!m) return null;
    const rect = cv.getBoundingClientRect();
    return { x: m.v.invX(e.clientX - rect.left), y: m.v.invY(e.clientY - rect.top) };
  };
  const overBoard = (p) => {
    const m = state._vMat;
    return !!(m && p
      && p.x >= m.offX && p.x <= m.offX + m.board.width
      && p.y >= m.offY && p.y <= m.offY + m.board.height);
  };
  cv.addEventListener('pointerdown', (e) => {
    const m = state._vMat;
    const p = worldPos(e);
    if (!m || !p || !overBoard(p)) return;
    dragging = true;
    grab = { x: p.x - m.offX, y: p.y - m.offY };
    cv.classList.add('board-drag');
    try { cv.setPointerCapture?.(e.pointerId); } catch { /* synthetic events have no active pointer */ }
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => {
    const m = state._vMat;
    if (!m) return;
    const p = worldPos(e);
    if (!dragging) {
      cv.classList.toggle('board-grab', overBoard(p));
      return;
    }
    if (!p) return;
    // new bottom-left corner = pointer − grab point − fixed inset
    const next = normalizePlacement(
      p.x - grab.x - BOARD_INSET_ON_STOCK.x,
      p.y - grab.y - BOARD_INSET_ON_STOCK.y,
    );
    const cur = placementOffset();
    if (next.x === cur.x && next.y === cur.y) return;
    setPlacementOffset(next.x, next.y);
    drawMaterialPreview(); // live feedback: position, fit colour, warning
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    cv.classList.remove('board-drag');
    scheduleGenerate(); // offset is final — regenerate G-code/checks/report
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
}

function drawPreview() {
  const canvas = $('#preview');
  const p = state.result.preview;
  const board = p.board;
  const stock = state.layers.stock ? stockDims() : null;
  const { offX, offY, ext } = boardOnStock(board, stock);
  state.view2d = state.view2d || { zoom: 1, panX: 0, panY: 0, measure: false, mpts: [] };
  const v = fitScene(canvas, ext, 460, state.view2d);
  state._v2d = v;
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
  if (state.layers.clearing && p.clearing && p.clearing.length) {
    ctx.strokeStyle = 'rgba(240,180,41,0.7)'; ctx.lineWidth = 1;
    for (const ring of p.clearing) { ctx.beginPath(); ring.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); ctx.stroke(); }
  }
  ctx.strokeStyle = '#8b98a9'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(0) + 16, Y(0)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(0), Y(0) - 16); ctx.stroke();
  ctx.fillStyle = '#8b98a9'; ctx.font = '10px sans-serif'; ctx.fillText('0,0', X(0) + 3, Y(0) - 4);
  // measurement overlay (F): points/line in stock-space world coords
  const mp = state.view2d.mpts || [];
  if (mp.length) {
    ctx.fillStyle = '#4c8dff'; ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = 1.4;
    for (const pt of mp) { ctx.beginPath(); ctx.arc(SX(pt.x), SY(pt.y), 3, 0, 7); ctx.fill(); }
    if (mp.length >= 2) {
      const a = mp[0]; const b = mp[1];
      ctx.beginPath(); ctx.moveTo(SX(a.x), SY(a.y)); ctx.lineTo(SX(b.x), SY(b.y)); ctx.stroke();
      const dx = b.x - a.x; const dy = b.y - a.y; const dist = Math.hypot(dx, dy);
      const label = `${dist.toFixed(2)} mm  (Δx ${dx.toFixed(2)}, Δy ${dy.toFixed(2)})`;
      const mx = (SX(a.x) + SX(b.x)) / 2; const my = (SY(a.y) + SY(b.y)) / 2;
      ctx.font = '11px ui-monospace, Menlo, monospace';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(11,17,28,0.9)'; ctx.fillRect(mx - tw / 2 - 5, my - 20, tw + 10, 16);
      ctx.fillStyle = '#e6edf3'; ctx.fillText(label, mx - tw / 2, my - 8);
    }
  }
}
// ---------- 2D preview interaction (F): zoom / pan / measure ----------
function fitPreview() {
  state.view2d = { zoom: 1, panX: 0, panY: 0, measure: state.view2d?.measure || false, mpts: state.view2d?.mpts || [] };
  if (state.result && state.view === '2d') drawPreview();
}
function toggleMeasure() {
  state.view2d = state.view2d || { zoom: 1, panX: 0, panY: 0, measure: false, mpts: [] };
  state.view2d.measure = !state.view2d.measure;
  state.view2d.mpts = [];
  const b = $('#pvMeasure'); if (b) b.classList.toggle('active', state.view2d.measure);
  const cv = $('#preview'); if (cv) cv.style.cursor = state.view2d.measure ? 'crosshair' : '';
  if (state.result && state.view === '2d') drawPreview();
}
function bindPreviewInteraction() {
  const cv = $('#preview');
  if (!cv) return;
  cv.addEventListener('wheel', (e) => {
    if (!state.result || state.view !== '2d') return;
    e.preventDefault();
    state.view2d = state.view2d || { zoom: 1, panX: 0, panY: 0, measure: false, mpts: [] };
    const rect = cv.getBoundingClientRect();
    const cx = e.clientX - rect.left; const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nz = Math.max(1, Math.min(40, state.view2d.zoom * factor));
    const ratio = nz / state.view2d.zoom;
    // keep the point under the cursor stationary
    state.view2d.panX = cx - (cx - state.view2d.panX) * ratio;
    state.view2d.panY = cy - (cy - state.view2d.panY) * ratio;
    state.view2d.zoom = nz;
    if (nz === 1) { state.view2d.panX = 0; state.view2d.panY = 0; }
    drawPreview();
  }, { passive: false });
  let dragging = false; let lastX = 0; let lastY = 0; let moved = false;
  cv.addEventListener('pointerdown', (e) => {
    if (!state.result || state.view !== '2d') return;
    dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
    cv.setPointerCapture?.(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX; const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    lastX = e.clientX; lastY = e.clientY;
    state.view2d = state.view2d || { zoom: 1, panX: 0, panY: 0 };
    state.view2d.panX += dx; state.view2d.panY += dy;
    drawPreview();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    // a click (no drag) while measuring records a point
    if (!moved && state.view2d?.measure && state._v2d) {
      const rect = cv.getBoundingClientRect();
      const wx = state._v2d.invX(e.clientX - rect.left);
      const wy = state._v2d.invY(e.clientY - rect.top);
      const mp = state.view2d.mpts || [];
      if (mp.length >= 2) state.view2d.mpts = [{ x: wx, y: wy }];
      else state.view2d.mpts = [...mp, { x: wx, y: wy }];
      drawPreview();
    }
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', () => { dragging = false; });
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
  const active = state.fab.steps[currentStepIdx()];
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
  // Primary action = one-click anchor-1 origin (M496.3 + G10 L20 at anchor 1,
  // no offset), matching the diagram; freely-placed boards use jog + "set
  // origin (XYZ)".
  steps.push({ id: 'setOrigin', kind: 'setup', action: 'setOriginAnchor1', title: t('step.setOrigin.t'), instr: t('step.setOrigin.i') });
  steps.push({ id: 'insertProbe', kind: 'setup', action: 'probeIn', title: t('step.insertProbe.t'), instr: t('step.insertProbe.i') });
  steps.push({ id: 'autoSetup', kind: 'setup', action: 'autoSetup', title: t('step.autoSetup.t'), instr: t('step.autoSetup.i') });
  steps.push({ id: 'insertTool', kind: 'manual', title: t('step.insertTool.t'), tool: isoTool, instr: t('step.insertTool.i') });

  steps.push({ id: 'isolation', kind: 'mill', title: t('step.isolation.t'), tool: isoTool, file: files['1_isolation.nc'] ? Object.keys(files).find((f) => f.startsWith('1_')) : null, est: times.isolation });

  // Optional copper clearing directly after isolation (same order as the
  // generated files and the report: 1_isolation.nc → 1b_clearing.nc).
  const clearingFile = Object.keys(files).find((f) => f.includes('clearing'));
  if (clearingFile) {
    steps.push({ id: 'clearing', kind: 'mill', title: t('step.clearing.t'), tool: toolLabelFor('clearing'), file: clearingFile, est: times.clearing });
  }

  if (cfg.solderMask?.enable) {
    steps.push({ id: 'clean', kind: 'manual', title: t('step.clean.t'), instr: t('step.clean.i') });
    steps.push({ id: 'applyMask', kind: 'manual', title: t('step.applyMask.t'), instr: t('step.applyMask.i') });
    steps.push({ id: 'cureMask', kind: 'dry', title: t('step.cureMask.t'), instr: t('step.cureMask.i'), dryMin: 10 });
    steps.push({ id: 'removeMask', kind: 'manual', title: t('step.removeMask.t'), tool: toolLabelFor('maskRemove') || t('step.removeMask.tool'), instr: t('step.removeMask.i') });
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
    steps.push({ id: 'laser', kind: 'mill', title: t('step.laser.t'), tool: toolLabelFor('laser') || t('step.laser.tool'), file: laserFile, est: times.laser });
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
// Visual inset of the board on the bed diagram: it rests flush against the
// L-bracket arms (BRACKET_ARM_MM). The work origin now sits AT the board corner
// (anchor 1, ANCHOR1_OFFSET = 0/0), so origin = board corner = this inset —
// there is NO separate work offset to draw anymore.
const WOFF = BRACKET_ARM_MM;

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
  // L-bracket at anchor 1 (front-left) with REAL arm widths (firmware
  // coordinate.anchor_width): 15 mm in X / 10 mm in Y, ~100 mm long — the board
  // rests flush against these arms, and its corner (= work origin) sits at
  // their inner edge. Mounting pattern: 2 dowel pins (filled) + 3 M5 screws.
  const armX = BRACKET_ARM_MM.x, armY = BRACKET_ARM_MM.y, armLen = BRACKET_ARM_LENGTH_MM;
  const lbracket =
    `<rect x="${asx(0)}" y="${asy(armLen)}" width="${armX}" height="${armLen}" fill="#8a94a6"/>` +
    `<rect x="${asx(0)}" y="${asy(armY)}" width="${armLen}" height="${armY}" fill="#8a94a6"/>` +
    `<circle cx="${asx(armX / 2)}" cy="${asy(62)}" r="2" fill="#222a37"/>` +
    `<circle cx="${asx(armX / 2)}" cy="${asy(38)}" r="2.6" fill="none" stroke="#222a37" stroke-width="1.3"/>` +
    `<circle cx="${asx(armX / 2)}" cy="${asy(14)}" r="2.6" fill="none" stroke="#222a37" stroke-width="1.3"/>` +
    `<circle cx="${asx(40)}" cy="${asy(armY / 2)}" r="2" fill="#222a37"/>` +
    `<circle cx="${asx(70)}" cy="${asy(armY / 2)}" r="2.6" fill="none" stroke="#222a37" stroke-width="1.3"/>`;
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
// Placement offset for the diagrams, clamped so the board stays drawable on
// the 300×200 bed even for extreme values (display only — the real clamp is
// the stock-fit rule).
function figPlacement(w, h) {
  const place = placementOffset();
  return {
    x: Math.max(0, Math.min(place.x, AIRW - WOFF.x - w)),
    y: Math.max(0, Math.min(place.y, AIRH - WOFF.y - h)),
  };
}
function boardRect(highlight) {
  const { w, h } = figBoard();
  const place = figPlacement(w, h);
  const x = asx(WOFF.x + place.x), y = asy(WOFF.y + place.y + h);
  return { w, h, x, y,
    svg: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="#c98a3a" stroke="${highlight || '#e0a84e'}" stroke-width="1.5"/>` };
}
function wasteRect() {
  const { w, h } = figBoard();
  const place = figPlacement(w, h);
  const m = 12; // ~waste board margin around the PCB (shapes only; labelled via legend)
  return `<rect x="${asx(WOFF.x + place.x - m)}" y="${asy(WOFF.y + place.y + h + m)}" width="${w + 2 * m}" height="${h + 2 * m}" rx="3" fill="#8f6a3f" stroke="#a97f4c" stroke-dasharray="4 3"/>`;
}
// Two top clamps pressing the PCB down on the edges away from the L-bracket.
function clamps() {
  const b = boardRect();
  const clamp = (cx) => `<rect x="${cx - 9}" y="${b.y - 7}" width="18" height="15" rx="3" fill="#48566e" stroke="#5b6b88"/>`;
  return clamp(b.x + b.w * 0.34) + clamp(b.x + b.w * 0.7);
}
function originDot() {
  const cx = asx(WOFF.x), cy = asy(WOFF.y);
  return `<circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="#4c8dff" stroke-width="2"/>` +
    `<circle cx="${cx}" cy="${cy}" r="1.6" fill="#4c8dff"/>`;
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
    const inner = bedBase() + boardRect().svg + originDot() +
      `<text x="${asx(WOFF.x) + 8}" y="${asy(WOFF.y) + 20}" class="lbl blue">${t('dg.origin')}</text>`;
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
    } else if (id === 'clearing') {
      for (let i = 0; i < 6; i++)
        feat += `<path d="M${b.x + 8} ${b.y + 8 + i * (b.h - 16) / 5} h ${b.w - 16}" stroke="#f0b429" stroke-width="2" opacity="0.7" fill="none"/>`;
      feat += `<text x="${b.x}" y="${b.y - 8}" class="lbl yel">${t('dg.clearing')}</text>`;
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
// The step the LIVE view (header, wizard, canvas, list highlight) should centre
// on. While a job is actually running the machine is physically ON that step,
// so it wins — even if that step was already ticked off (which is exactly why
// the header used to jump one ahead to the "next undone" step during a run).
// When nothing is running, fall back to the first not-yet-done step.
function currentStepIdx() {
  const job = state.fab.job;
  if (job && job.stepId && job.monitor?.active) {
    const i = state.fab.steps.findIndex((s) => s.id === job.stepId);
    if (i >= 0) return i;
  }
  return firstUndoneIdx();
}

// ---------- external vacuum automation (app side) ----------
// Settings live in the accessory panel (data-path inputs → readConfig feeds
// the G-code path) and are mirrored to localStorage like the other settings.
// The pure transition plan is in job-monitor.js (planVacuumForTransition);
// this block only executes it: send now or schedule the run-on off.
const VACUUM_SETTINGS_KEY = 'makera_vacuum';
function vacuumSettings() {
  const linger = Number($('#vacLinger')?.value);
  return {
    enable: $('#vacAuto')?.checked ?? true,
    lingerSec: Number.isFinite(linger) && linger >= 0 ? linger : VACUUM_LINGER_DEFAULT_S,
    pauseToolChange: $('#vacPauseTc')?.checked ?? false,
    laser: $('#vacLaser')?.checked ?? true,
  };
}
function saveVacuumSettings() { saveJSON(VACUUM_SETTINGS_KEY, vacuumSettings()); }
function loadVacuumSettings() {
  const s = loadJSON(VACUUM_SETTINGS_KEY, null);
  if (!s) return;
  if ($('#vacAuto')) $('#vacAuto').checked = s.enable !== false;
  if ($('#vacLinger') && s.lingerSec != null) $('#vacLinger').value = s.lingerSec;
  if ($('#vacPauseTc')) $('#vacPauseTc').checked = !!s.pauseToolChange;
  if ($('#vacLaser')) $('#vacLaser').checked = s.laser !== false;
}
// 'command' jobs (M495 & co) never touch the vacuum; the laser program has
// its own settings switch.
function vacuumJobKind(name, mode) {
  if (mode === 'command') return 'command';
  return /laser/i.test(String(name || '')) ? 'laser' : 'mill';
}
let vacuumOffTimer = null;
function cancelVacuumOffTimer() {
  if (vacuumOffTimer) { clearTimeout(vacuumOffTimer); vacuumOffTimer = null; }
}
// Execute the plan for a batch of monitor events. The scheduled off (run-on)
// is cancelled whenever the port is switched on again or a new job starts —
// a stale timer must never kill the vacuum mid-job.
function applyVacuumEvents(events, jobKind) {
  for (const ev of events || []) {
    if (ev.type !== 'state') continue;
    const plan = planVacuumForTransition(ev, vacuumSettings(), jobKind);
    if (!plan) continue;
    if (plan.delayS > 0) {
      cancelVacuumOffTimer();
      vacuumOffTimer = setTimeout(() => {
        vacuumOffTimer = null;
        if (!state.machine.connected) return;
        machineCommands(plan.commands);
        logEvent('log.vacAutoOff', { s: plan.delayS });
      }, plan.delayS * 1000);
    } else {
      if (plan.commands.includes(VACUUM_ON_COMMAND)) cancelVacuumOffTimer();
      machineCommands(plan.commands);
    }
  }
}

// ---------- live job monitoring (state machine in job-monitor.js) ----------
// One monitored job at a time: { monitor, stepId, name, failure }. The poll
// loop feeds it status+log; DONE auto-completes the step and unlocks the
// next one, FAILED shows the reason on the step and does NOT advance.
function jobActive() {
  return !!(state.fab.job && state.fab.job.monitor.active);
}
function startJobMonitor(stepId, name, mode) {
  if (!state.machine.connected) return; // nothing to monitor without a link
  const vacuumKind = vacuumJobKind(name, mode);
  state.fab.job = { monitor: new JobMonitor({ mode }), stepId, name, vacuumKind };
  const events = state.fab.job.monitor.start(name);
  applyVacuumEvents(events, vacuumKind); // start → vacuum on (if automated)
  renderFab();
}
// Steps are gated: running a step while earlier ones are still open needs an
// explicit confirmation (deliberate skipping stays possible — nothing is
// locked hard); a second start while a job runs is refused.
function stepGateOk(idx) {
  if (jobActive()) { toast(t('job.alreadyRunning'), true); return false; }
  const activeIdx = firstUndoneIdx();
  if (activeIdx >= 0 && idx != null && idx > activeIdx) return confirm(t('job.skipConfirm'));
  return true;
}
function jobStateBadge(job) {
  const st = job.monitor.state;
  if (st === JOB_STATE.STARTING || st === JOB_STATE.RUNNING) {
    return `<span class="job-badge run"><span class="spinner"></span>${t('job.running')}</span>`;
  }
  if (st === JOB_STATE.WAITING_TOOL) {
    const n = job.monitor.targetTool;
    return `<span class="job-badge wait"><span class="spinner"></span>${t('job.waitTool', { n: n != null ? n : '?' })}</span>`;
  }
  if (st === JOB_STATE.PAUSED) return `<span class="job-badge wait">${t('job.paused')}</span>`;
  if (st === JOB_STATE.FAILED) {
    const f = job.monitor.failure || {};
    const detail = f.reason === 'alarm' ? t('job.failedAlarm', { msg: f.message || '' })
      : f.reason === 'disconnected' ? t('job.failedDisconnected')
      : f.reason === 'not-started' ? t('job.failedNotStarted')
      : f.reason === 'cancelled' ? t('job.failedCancelled')
      : '';
    return `<span class="job-badge fail">✗ ${t('job.failed')}${detail ? ' – ' + escapeHtml(detail) : ''}</span>`;
  }
  return '';
}
// Title for toasts/logs: fabrication step title when the id matches a step,
// otherwise the job name (device-control jobs like 'probeZ' have no step).
function stepTitleById(id, fallback = null) {
  const s = state.fab.steps.find((x) => x.id === id);
  return s ? s.title : (fallback || id);
}
// Feed the monitor from the regular status poll and act on its transitions.
function updateJobMonitorFromPoll(d, s) {
  const job = state.fab.job;
  if (!job) return;
  if (!job.monitor.active) return;
  const events = job.monitor.update({ connected: !!d.connected, status: s, log: d.log || [] });
  // vacuum automation follows the job states (tool wait / done / failed)
  applyVacuumEvents(events, job.vacuumKind || vacuumJobKind(job.name, job.monitor.mode));
  for (const ev of events) {
    if (ev.type !== 'state') continue;
    if (ev.state === JOB_STATE.DONE) {
      if (job.stepId) state.fab.done[job.stepId] = true;
      const title = job.stepId ? stepTitleById(job.stepId, job.name) : (job.name || '');
      toast(t('job.stepDone', { title }));
      logEvent('log.stepDone', { title });
      // Config & Run / auto-leveling finished → pull the height map from the
      // machine log (the G32 output is already there — no extra command).
      if (job.stepId === 'autoSetup' || job.stepId === 'levelMap') fetchHeightMap();
    } else if (ev.state === JOB_STATE.FAILED) {
      const title = job.stepId ? stepTitleById(job.stepId, job.name) : (job.name || '');
      toast(t('job.stepFailed', { title }), true);
      logEvent('log.stepFailed', { title, msg: job.monitor.failure?.message || job.monitor.failure?.reason || '' }, 'error');
    } else if (ev.state === JOB_STATE.WAITING_TOOL) {
      logEvent('log.toolWait', { n: ev.targetTool != null ? ev.targetTool : '?' });
    }
    renderFab();
  }
}
function renderFab() {
  const host = $('#fabSteps');
  if (!host) return;
  if (!state.result) { host.innerHTML = `<p class="muted">${t('fab.loadFirst')}</p>`; return; }
  state.fab.steps = buildFabSteps();
  $('#fabPlaceholder')?.classList.add('hidden');
  const activeIdx = currentStepIdx();
  const viewIdx = (state.fab.view != null && state.fab.view < state.fab.steps.length) ? state.fab.view : (activeIdx >= 0 ? activeIdx : 0);
  const doneLbl = t('fab.done');
  const job = state.fab.job;
  const busy = jobActive();
  host.innerHTML = state.fab.steps.map((s, i) => {
    const done = !!state.fab.done[s.id];
    const active = i === activeIdx;
    const shown = i === viewIdx;
    const isJobStep = job && job.stepId === s.id;
    const badge = isJobStep ? jobStateBadge(job) : '';
    const cls = `fab-step ${done ? 'done' : ''} ${active ? 'active' : ''} ${shown ? 'shown' : ''} ${s.kind === 'manual' || s.kind === 'dry' ? 'manual' : ''} ${isJobStep && job.monitor.active ? 'job-running' : ''}`;
    const sub = [s.tool ? `${t('step.toolPrefix')}: ${escapeHtml(s.tool)}` : '', s.est ? `≈ ${fmtDur(s.est)}` : '', s.instr ? escapeHtml(s.instr) : ''].filter(Boolean).join(' · ');
    const dis = busy ? 'disabled' : '';
    let actions = '';
    if (s.kind === 'mill') {
      actions = `${badge}${s.file ? `<button class="btn small" data-fabrun="${i}" ${dis}>${t('fab.run')}</button>` : `<span class="muted">${t('fab.noFile')}</span>`}<button class="btn small ghost" data-fabdone="${s.id}">${done ? t('fab.doneMark') : doneLbl}</button>`;
    } else if (s.kind === 'setup') {
      // Config & Run: show the parsed height-map verdict right on the step.
      const hm = s.id === 'autoSetup' ? hmChipHtml() : '';
      actions = `${badge}${hm}<button class="btn small" data-fabaction="${s.action}" data-fabidx="${i}" ${dis}>${t('fab.exec')}</button><button class="btn small ghost" data-fabdone="${s.id}">${done ? t('fab.doneMark') : doneLbl}</button>`;
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
  $$('[data-fabrun]', host).forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.fabrun);
    const step = state.fab.steps[i];
    if (!step || !stepGateOk(i)) return;
    fabRun(step);
  }));
  $$('[data-fabaction]', host).forEach((b) => b.addEventListener('click', () => {
    if (!state.machine.connected) { switchWf('machine'); return toast(t('machine.connectFirst'), true); }
    if (!stepGateOk(Number(b.dataset.fabidx))) return;
    machineAction(b.dataset.fabaction);
  }));
  $$('[data-fabdone]', host).forEach((b) => b.addEventListener('click', () => { const id = b.dataset.fabdone; state.fab.done[id] = !state.fab.done[id]; renderFab(); drawFab(); }));
  $$('[data-drystart]', host).forEach((b) => b.addEventListener('click', () => startDryTimer(b.dataset.drystart)));

  const est = state.result.times?.total;
  $('#fabMeta').innerHTML = t('fab.totalTime', { time: fmtDur(est), n: state.fab.steps.length });
  if (activeIdx >= 0) $('#fabStepName').textContent = `${activeIdx + 1}. ${state.fab.steps[activeIdx].title}`;
  else $('#fabStepName').textContent = t('fab.allDone');
  renderWizard(activeIdx);
  drawFab();
}
// Guided Run wizard (A): a prominent banner for the current step with its one
// primary action + "Next", walking origin → probe → config&run → mill → … in order.
function renderWizard(activeIdx) {
  const el = $('#fabWizard');
  if (!el) return;
  const steps = state.fab.steps || [];
  const n = steps.length;
  if (!n) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (activeIdx < 0) { el.innerHTML = `<div class="fw-done">✓ ${escapeHtml(t('fab.allDone'))}</div>`; return; }
  const s = steps[activeIdx];
  const doneCount = steps.filter((x) => state.fab.done[x.id]).length;
  const pct = Math.round((doneCount / n) * 100);
  const busy = jobActive();
  const wizBadge = (state.fab.job && state.fab.job.stepId === s.id) ? jobStateBadge(state.fab.job) : '';
  let primary = '';
  if (s.kind === 'mill' && s.file) primary = `<button class="btn small primary" id="fwPrimary" ${busy ? 'disabled' : ''}>${t('fab.run')}</button>`;
  else if (s.kind === 'setup') primary = `<button class="btn small primary" id="fwPrimary" ${busy ? 'disabled' : ''}>${t('fab.exec')}</button>`;
  const sub = [s.tool ? `${t('step.toolPrefix')}: ${escapeHtml(s.tool)}` : '', s.instr ? escapeHtml(s.instr) : ''].filter(Boolean).join(' · ');
  el.innerHTML = `
    <div class="fw-head"><span class="fw-badge">${escapeHtml(t('fab.wizStep', { i: activeIdx + 1, n }))}</span>
      <div class="fw-bar"><div class="fw-fill" style="width:${pct}%"></div></div></div>
    <div class="fw-title">${escapeHtml(s.title)} ${wizBadge}</div>
    ${sub ? `<div class="fw-instr">${sub}</div>` : ''}
    <div class="fw-actions">${primary}<button class="btn small" id="fwNext" ${busy ? 'disabled' : ''}>${escapeHtml(t('fab.wizNext'))}</button></div>`;
  const prim = $('#fwPrimary', el);
  if (prim) prim.addEventListener('click', () => {
    if (!stepGateOk(activeIdx)) return;
    if (s.kind === 'mill') return fabRun(s);
    if (s.kind === 'setup') {
      if (!state.machine.connected) { switchWf('machine'); return toast(t('machine.connectFirst'), true); }
      return machineAction(s.action);
    }
  });
  $('#fwNext', el)?.addEventListener('click', () => { state.fab.done[s.id] = true; state.fab.view = null; renderFab(); drawFab(); });
}
// ---------- job-start safety gate (Z / leveling plausibility) ----------
// Cheap, high-signal checks BEFORE a cutting job starts. They exist because a
// single wrong parameter (a Z origin ~23 mm below the surface) once milled
// straight through a board — every warning is a real observation, no guess.
function jobSafetyWarnings() {
  const warnings = [];
  const s = state.machine.status;
  const m = s?.mpos; const wp = s?.wpos;
  // 0) Machine not homed (MPos above the -1 mm soft-endstop maximum =
  //    reset/power-cycle without $H): every coordinate — including the
  //    "origin set" badge — is meaningless. This is the post-incident
  //    screenshot state (MPos 0/116/63, absurd WPos).
  if (notHomedFromStatus(s) === true) warnings.push(t('gate.notHomed'));
  // 1) No Z work offset at all: WCO-Z ≈ 0 means Z was never probed/set since
  //    homing — the job would cut relative to the HOMING height.
  if (m && wp && m.length > 2 && wp.length > 2) {
    const wcoZ = m[2] - wp[2];
    if (Math.abs(wcoZ) <= SETUP_Z_SET_EPSILON_MM) warnings.push(t('gate.noZ'));
  }
  // 2) Leveling deviation: prefer the freshly parsed height map; the live
  //    status "O:" field (max delta while compensation is active,
  //    Kernel.cpp:469-474) is the fallback.
  const assess = state.machine.heightMapAssess;
  const liveDev = s?.leveling && s.leveling.length ? Math.abs(s.leveling[0]) : null;
  const dev = assess ? assess.maxDeviation : liveDev;
  if (dev != null && dev > LEVELING_MAX_DEV_WARN_MM) {
    warnings.push(t('gate.leveling', { dev: dev.toFixed(2), max: LEVELING_MAX_DEV_WARN_MM }));
  }
  if (assess) {
    for (const w of assess.warnings) {
      if (w.code === 'tilt') warnings.push(t('hm.warn.tilt', { tilt: w.params.tilt.toFixed(2) }));
      else if (w.code === 'outlier') warnings.push(t('hm.warn.outlier', { n: w.params.n, x: w.params.x.toFixed(1), y: w.params.y.toFixed(1) }));
    }
  }
  return warnings;
}
function jobSafetyGateOk() {
  const warnings = jobSafetyWarnings();
  if (!warnings.length) return true;
  return confirm(t('gate.confirm') + '\n\n• ' + warnings.join('\n• '));
}

// Upload & start one fabrication step and put it under live monitoring: the
// start button is disabled immediately (startJobMonitor re-renders), the poll
// loop then drives running → waitingToolChange → done/failed.
async function fabRun(step) {
  const file = step.file;
  const gcode = state.result?.files?.[file];
  if (!gcode) return toast(t('fab.notFound'), true);
  if (!state.machine.connected) { switchWf('machine'); return toast(t('machine.connectFirst'), true); }
  // Same guard as "Upload & start": no workpiece origin → the job would run
  // relative to the machine's reference corner (top right).
  if (originIsSet(state.machine.status) === false && !confirm(t('confirm.noOrigin'))) return;
  if (!jobSafetyGateOk()) return;
  if (!confirm(t('fab.runConfirm', { file }))) return;
  startJobMonitor(step.id, file, 'play'); // disables all start buttons at once
  try {
    const d = await api('/api/machine/run', { name: file, gcode, start: true });
    toast(t('fab.started', { path: d.path }));
    logEvent('log.started', { path: d.path });
  } catch (err) {
    state.fab.job = null; // upload failed — free the buttons again
    // the start already switched the vacuum on → schedule the run-on off
    applyVacuumEvents([{ type: 'state', state: JOB_STATE.FAILED, prev: JOB_STATE.STARTING }], vacuumJobKind(file, 'play'));
    renderFab();
    toast(t('machine.uploadErr', { msg: err.message }), true);
    logEvent('log.genError', { msg: err.message }, 'error');
  }
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
  const active = state.fab.steps[currentStepIdx()];
  const strokeSet = (rings, color, closed, dim) => { ctx.strokeStyle = color; ctx.globalAlpha = dim ? 0.3 : 1; ctx.lineWidth = dim ? 0.8 : 1.4; for (const r of rings) { if (!r || r.length < 2) continue; ctx.beginPath(); r.forEach((pt, i) => { const x = pt.x ?? pt[0]; const y = pt.y ?? pt[1]; i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)); }); if (closed) ctx.closePath(); ctx.stroke(); } ctx.globalAlpha = 1; };
  strokeSet(p.isolation.flat(), '#ff5a5a', true, !active || active.id !== 'isolation');
  if (p.clearing?.length) strokeSet(p.clearing, '#f0b429', true, !active || active.id !== 'clearing');
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
  if (step.id === 'clearing') return { polys: (p.clearing || []).map(toXY), dots: [] };
  if (step.id === 'outline') return { polys: (p.outline || []).map((l) => toXY(l.pts)), dots: [] };
  if (step.id === 'laser') return { polys: (p.laser || []).map(toXY), dots: [] };
  if (step.id.startsWith('drill')) { const dia = parseFloat(step.id.split(':')[1]); return { polys: [], dots: p.drills.filter((d) => Math.abs(d.d - dia) < 0.06) }; }
  return null;
}
function polyLen(pl) { let L = 0; for (let i = 1; i < pl.length; i++) L += Math.hypot(pl[i].x - pl[i - 1].x, pl[i].y - pl[i - 1].y); return L; }
function fabColor(step) { return step.id === 'outline' ? '#2ecc71' : step.id === 'laser' ? '#ff59d8' : step.id === 'clearing' ? '#f0b429' : step.id.startsWith('drill') ? '#4c8dff' : '#ff5a5a'; }

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
  if (p.clearing?.length) dim(p.clearing, '#f0b429', true);
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
    state.machine.wantConnected = true;
    saveJSON('makera_lastconn', { ip, port });
    $('#mDisconnect').disabled = false;
    $('#mStatus').classList.remove('hidden');
    startStatusPoll();
    setPill('on', t('machine.connectedToast'));
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
  state.machine.wantConnected = false; // explicit disconnect: stop auto-reconnect
  if (state.machine.reconnectTimer) { clearTimeout(state.machine.reconnectTimer); state.machine.reconnectTimer = null; }
  saveJSON('makera_lastconn', null);
  stopStatusPoll();
  try { await api('/api/machine/disconnect'); } catch {}
  state.machine.connected = false;
  state.machine.state = null;
  state.machine.status = null;
  $('#mDisconnect').disabled = true;
  setPill('off', t('machine.disconnected'));
  renderSetupAssistant();
  const diag = $('#machDiag'); diag.classList.add('hidden'); delete diag.dataset.shown;
  logEvent('log.disconnected', {});
}
// Auto-reconnect: after a dropped connection (or a page reload) get back to the
// last machine on its own, with a capped backoff. Explicit disconnect cancels it.
async function tryReconnect() {
  const lc = loadJSON('makera_lastconn', null);
  if (!lc || !lc.ip || !state.machine.wantConnected || state.machine.connected) return;
  state.machine.reconnectTries = (state.machine.reconnectTries || 0) + 1;
  setPill('off', t('machine.reconnecting'));
  try {
    await api('/api/machine/connect', { ip: lc.ip, port: lc.port || 2222 });
    state.machine.connected = true;
    state.machine.reconnectTries = 0;
    $('#mDisconnect').disabled = false;
    $('#mStatus').classList.remove('hidden');
    startStatusPoll();
    toast(t('machine.reconnected'));
  } catch {
    const delay = Math.min(15000, 1500 * state.machine.reconnectTries);
    state.machine.reconnectTimer = setTimeout(tryReconnect, delay);
  }
}
// On page load the server may still be connected to the machine (server state
// survives a browser reload); restore the UI, else auto-reconnect to the last one.
async function restoreMachineConnection() {
  try {
    const res = await fetch('/api/machine/status');
    const d = await res.json();
    const lc = loadJSON('makera_lastconn', null);
    if (lc && lc.ip) { const ipEl = $('#mIp'); if (ipEl && !ipEl.value) ipEl.value = lc.ip; const pEl = $('#mPort'); if (pEl) pEl.value = lc.port || 2222; }
    if (d.connected) {
      state.machine.connected = true;
      state.machine.wantConnected = true;
      $('#mDisconnect').disabled = false;
      $('#mStatus').classList.remove('hidden');
      startStatusPoll();
    } else if (lc && lc.ip) {
      state.machine.wantConnected = true;
      state.machine.reconnectTries = 0;
      tryReconnect();
    }
  } catch { /* server not reachable yet */ }
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
      state.machine.connected = false; stopStatusPoll(); $('#mDisconnect').disabled = true;
      state.machine.state = null;
      state.machine.status = null;
      updateJobMonitorFromPoll(d, null); // a monitored job fails on disconnect
      renderToolChangeOverlay(null);
      renderVacuumState(null); // port state unknown without the link
      renderSetupAssistant();
      const diag = $('#machDiag'); diag.classList.add('hidden'); delete diag.dataset.shown;
      if (state.machine.wantConnected) { state.machine.reconnectTries = 0; tryReconnect(); } // heartbeat lost → reconnect
      else setPill('off', t('machine.disconnected'));
      return;
    }
    const s = d.status || {};
    const state_ = s.state || '—';
    setPill(state_ === 'Run' ? 'run' : 'on', d.xmitting ? t('machine.upload') : (s.state ? state_ : t('machine.connected')));
    const fmt = (a, dg = 2) => (a ? a.map((v) => v.toFixed(dg)).join(' / ') : '—');
    const setStat = (k, v) => $$(`[data-s="${k}"]`).forEach((el) => { el.textContent = v; });
    setStat('state', state_);
    setStat('wpos', fmt(s.wpos, 2));
    setStat('mpos', fmt(s.mpos, 2)); // machine coordinates (built-in zero = home corner)
    // Origin badge: tell the user whether a workpiece origin exists (WCO != 0)
    // — the single most common source of "the machine drives somewhere else".
    // On an UNHOMED machine (positive MPos after a reset) the stored offsets
    // are meaningless, so the badge must not claim "set".
    const unhomed = notHomedFromStatus(s) === true;
    const oset = originIsSet(s);
    setStat('origin', oset == null ? '—' : unhomed ? t('machine.originInvalid') : (oset ? t('machine.originOk') : t('machine.originUnset')));
    $$('[data-s="origin"]').forEach((el) => {
      el.style.color = oset == null ? '' : (oset && !unhomed ? 'var(--ok, #2ecc71)' : 'var(--warn, #ffb14e)');
    });
    setStat('feed', s.feed ? s.feed[0].toFixed(0) : '—');
    setStat('spin', s.spindle ? s.spindle[0].toFixed(0) : '—');
    setStat('tool', s.tool ? `T${s.tool[0]}` : '—');
    // Auto-leveling: the "O:" field only exists while a height map is active
    // (Kernel.cpp:469-474) and carries its max deviation.
    const lev = s.leveling && s.leveling.length ? Math.abs(s.leveling[0]) : null;
    setStat('leveling', lev == null ? t('machine.levelOff') : t('machine.levelActive', { dev: lev.toFixed(2) }));
    $$('[data-s="leveling"]').forEach((el) => {
      el.style.color = lev == null ? '' : (lev > LEVELING_MAX_DEV_WARN_MM ? 'var(--warn, #ffb14e)' : 'var(--ok, #2ecc71)');
    });
    state.machine.tool = s.tool ? s.tool[0] : null;
    state.machine.state = state_; // Idle / Run / Alarm / Home … (used to guard motion)
    state.machine.status = s; // full parsed status (used by the origin guard)
    const logText = (d.log || []).join('\n');
    $$('.mach-console').forEach((el) => { el.textContent = logText; el.scrollTop = el.scrollHeight; });
    surfaceMachineMessages(d.log || []);

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
    updateJobMonitorFromPoll(d, s);
    renderToolChangeOverlay(s);
    renderVacuumState(d.vacuumOn);
    renderAlarm(state_, d.lastAlarm);
    renderSetupAssistant();
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
// Live badge for the external vacuum port. The firmware status does not
// report the switch, so the server remembers the last commanded M851/M852
// (shared by desktop + mobile); while an automated job runs, the badge adds
// "auto" because the G-code file switches the port itself.
function renderVacuumState(on) {
  const el = $('#vacState');
  if (!el) return;
  el.className = 'vac-state ' + (on === true ? 'on' : 'off');
  let txt = on == null ? '—' : on === true ? t('vac.stateOn') : t('vac.stateOff');
  if (jobActive() && state.fab.job?.vacuumKind !== 'command' && vacuumSettings().enable) {
    txt += ' · ' + t('vac.stateAuto');
  }
  el.textContent = txt;
}
function setPill(cls, text) {
  const p = $('#machState');
  if (p) { p.className = 'pill ' + cls; p.textContent = text; }
  const off = cls === 'off';
  const connCls = off ? 'off' : (cls === 'run' ? 'run' : 'on');
  const h = $('#machHeaderState');
  if (h) { h.className = 'pill hdr-pill ' + connCls; h.textContent = t(off ? 'machine.hdrDisconnected' : 'machine.hdrConnected'); }
  const dk = $('#dockConn');
  if (dk) { dk.className = 'pill dock-conn ' + connCls; dk.textContent = t(off ? 'machine.hdrDisconnected' : 'machine.hdrConnected'); }
}
// Surface important machine replies (buried in the log) as visible toasts, so
// warnings like "Change to probe tool first!" or "ATC already begun" aren't missed.
function surfaceMachineMessages(log) {
  if (!log || !log.length) return;
  const joined = log.join('\n');
  const prev = state._lastLogSeen || '';
  if (joined === prev) return;
  state._lastLogSeen = joined;
  let newLines = log;
  if (prev) {
    const prevLines = prev.split('\n');
    const lastPrev = prevLines[prevLines.length - 1];
    const idx = log.lastIndexOf(lastPrev);
    if (idx >= 0) newLines = log.slice(idx + 1);
  }
  const rx = /(change to probe tool first|ATC already begun|alarm|error|fail|out of range|halt)/i;
  for (const line of newLines) {
    const ln = String(line).trim();
    if (ln && rx.test(ln)) { toast('⚠ ' + ln, true); break; }
  }
}
// Keep the page content clear of the fixed bottom dock: mirror the dock's
// actual height (it wraps/expands depending on content and viewport) into the
// content container's padding so the last card is always scrollable into view.
// (The padding must live on .wf-main — body has height:100%, so body padding
// would not extend the scrollable area.)
const DOCK_CLEARANCE_PX = 12;
function syncDockPadding() {
  const d = $('#machDock');
  const main = document.querySelector('.wf-main');
  if (!d || !main) return;
  main.style.paddingBottom = `${d.offsetHeight + DOCK_CLEARANCE_PX}px`;
}
function initDockPadding() {
  const d = $('#machDock');
  if (!d) return;
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncDockPadding).observe(d);
  window.addEventListener('resize', syncDockPadding);
  syncDockPadding();
}
function toggleDock(force) {
  const d = $('#machDock');
  if (!d) return;
  const open = force != null ? force : d.classList.contains('collapsed');
  d.classList.toggle('collapsed', !open);
  const tgl = $('#dockToggle');
  if (tgl) tgl.textContent = open ? '▼' : '▲';
  saveJSON('makera_dock', open);
  syncDockPadding();
}
async function copyMachineLog() {
  const el = document.querySelector('.mach-console');
  const txt = (el && el.textContent || '').trim();
  if (!txt) return toast(t('dock.empty'), true);
  try { await navigator.clipboard.writeText(txt); toast(t('dock.copied')); }
  catch (e) {
    // clipboard API can be blocked (non-secure context) — fall back to a manual copy
    try { el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); const ok = document.execCommand('copy'); s.removeAllRanges(); toast(ok ? t('dock.copied') : t('dock.copyFail'), !ok); }
    catch { toast(t('dock.copyFail'), true); }
  }
}

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
// ---------- M6 tool-change overlay (full-page modal) ----------
// The Carvera Air has no ATC: M6 T<n> drives to the change position, beeps
// and WAITS in the firmware "Tool" state (ATCHandler.cpp manual branch,
// M490.1 → set_tool_waiting). The overlay appears whenever the live status
// says state == "Tool" — also for every M6 inside 0_full_job.nc — and closes
// by itself once the machine moves on (confirm here OR the machine button).
// Resume = M490.2 (exits the tool wait; same command the community
// controller's tool-change popup sends). The '~' realtime byte only clears a
// feed hold and does NOT work here (WifiProvider.cpp:263).
let tcOverlaySig = null;
let tcResuming = false;

function toolChangeSvg() {
  // spindle at the change position with an empty collet + hand-held tool
  return `<svg viewBox="0 0 200 130" class="tc-svg" role="img" aria-hidden="true">
    <rect x="66" y="6" width="68" height="46" rx="8" fill="#2b3446" stroke="#3d4a63"/>
    <text x="100" y="33" text-anchor="middle" fill="#8b98a9" font-size="11">${escapeHtml(t('dg.spindle'))}</text>
    <rect x="88" y="52" width="24" height="14" rx="2" fill="#8a94a6"/>
    <path d="M96 66 h8 l-1.5 10 h-5 Z" fill="#5b6b88"/>
    <rect x="97.4" y="84" width="5.2" height="26" rx="1" fill="#c7cede"/>
    <path d="M96 110 L104 110 L100 120 Z" fill="#c7cede"/>
    <path d="M92 96 q-16 4 -22 16" fill="none" stroke="#ffd23f" stroke-width="2.4" stroke-dasharray="4 3"/>
    <path d="M70 106 l-4 8 8 -2 Z" fill="#ffd23f"/>
  </svg>`;
}

function renderToolChangeOverlay(s) {
  const el = $('#toolOverlay');
  if (!el) return;
  const waiting = state.machine.connected && isToolChangeWait(s);
  if (!waiting) {
    if (!el.classList.contains('hidden')) {
      el.classList.add('hidden');
      el.innerHTML = '';
      if (tcResuming) logEvent('log.toolResumed', {});
    }
    tcOverlaySig = null;
    tcResuming = false;
    return;
  }
  const target = toolChangeTarget(s) ?? state.fab.job?.monitor?.targetTool ?? null;
  const tool = target != null ? state.tools.find((x) => x.number === target) : null;
  const label = tool ? (tool.label || `${tool.type} ${tool.diameter} mm`) : '';
  const sig = [getLang(), target, label, tcResuming ? 1 : 0].join('|');
  if (sig === tcOverlaySig && !el.classList.contains('hidden')) return; // keep buttons clickable
  tcOverlaySig = sig;
  const toolTxt = target != null && target >= 0
    ? `T${target}${label ? ' · ' + escapeHtml(label) : ''}`
    : target === 0 ? 'T0 · ' + escapeHtml(t('dg.probe')) : escapeHtml(t('tc.unknownTool'));
  el.classList.remove('hidden');
  el.innerHTML = `<div class="tc-box" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('tc.title'))}">
      ${toolChangeSvg()}
      <div class="tc-title">${escapeHtml(t('tc.title'))}</div>
      <div class="tc-tool">${toolTxt}</div>
      <div class="tc-desc">${escapeHtml(t('tc.machineState'))}</div>
      <div class="tc-desc muted">${escapeHtml(t('tc.alreadyIn'))}</div>
      ${tcResuming
        ? `<div class="tc-resuming"><span class="spinner"></span>${escapeHtml(t('tc.resuming'))}</div>`
        : `<button class="btn primary tc-confirm" id="tcConfirm">${escapeHtml(t('tc.confirm'))}</button>`}
      <div class="tc-desc muted">${escapeHtml(t('tc.orButton'))}</div>
      <div class="tc-cancel-row"><button class="btn small ghost danger" id="tcCancel" ${tcResuming ? 'disabled' : ''}>${escapeHtml(t('tc.cancel'))}</button></div>
    </div>`;
  $('#tcConfirm', el)?.addEventListener('click', async () => {
    tcResuming = true;
    tcOverlaySig = null; // force re-render into the "resuming" view
    logEvent('log.toolResume', { n: target != null ? target : '?' });
    await machineCommand(RESUME_TOOL_CHANGE_COMMAND);
    renderToolChangeOverlay(state.machine.status);
  });
  $('#tcCancel', el)?.addEventListener('click', async () => {
    if (!confirm(t('tc.cancelConfirm'))) return;
    if (state.fab.job && state.fab.job.monitor.active) {
      // a deliberate abort must not count as "done" — and it schedules the
      // vacuum run-on off (the aborted file never reaches its own M852)
      applyVacuumEvents(state.fab.job.monitor.cancel(), state.fab.job.vacuumKind);
      renderFab();
    }
    await machineCommands(ABORT_JOB_COMMANDS);
    logEvent('log.jobAborted', {});
    toast(t('tc.cancelled'));
  });
}

// ---------- auto-leveling height map (fetch → assess → visualise) ----------
// The G32 grid probe prints every point + the grid + "Max deviation from
// zero" into the console (CartGridStrategy.cpp doProbe) — the server mirrors
// that log, so the map is parsed from /api/machine/log without sending any
// extra command to the machine.
let hmViewer3d = null;

async function fetchHeightMap() {
  try {
    const res = await fetch('/api/machine/log');
    const d = await res.json();
    const map = parseLevelingFromLog(d.log || []);
    if (!map) return;
    state.machine.heightMap = map;
    state.machine.heightMapAssess = assessHeightMap(map);
    const a = state.machine.heightMapAssess;
    logEvent('log.heightMap', { dev: a.maxDeviation.toFixed(3), i: map.cols, j: map.rows }, a.ok ? 'info' : 'warn');
    if (!a.ok) toast(t('hm.toastWarn', { dev: a.maxDeviation.toFixed(2) }), true);
    renderHeightMapPanel();
    renderFab(); // compact chip on the Config & Run step
  } catch { /* log not reachable — panel simply stays empty */ }
}

function hmWarningTexts(assess) {
  const out = [];
  for (const w of assess.warnings) {
    if (w.code === 'total-dev') out.push(t('hm.warn.totalDev', { dev: w.params.dev.toFixed(2), max: w.params.max }));
    else if (w.code === 'tilt') out.push(t('hm.warn.tilt', { tilt: w.params.tilt.toFixed(2) }));
    else if (w.code === 'outlier') out.push(t('hm.warn.outlier', { n: w.params.n, x: w.params.x.toFixed(1), y: w.params.y.toFixed(1) }));
  }
  return out;
}

// Compact summary chip: max deviation + warn icon + "3D" button. Used in the
// Machine tab panel and (via renderFab) on the fabrication Config & Run step.
function hmChipHtml() {
  const map = state.machine.heightMap;
  const a = state.machine.heightMapAssess;
  if (!map || !a) return '';
  const warn = !a.ok;
  return `<span class="hm-chip ${warn ? 'warn' : 'ok'}">${warn ? '⚠' : '✓'} ${t('hm.maxDev', { dev: a.maxDeviation.toFixed(2) })}</span>`
    + `<button class="btn small ghost" data-hmopen>${t('hm.open3d')}</button>`;
}

function renderHeightMapPanel() {
  const host = $('#hmPanel');
  if (!host) return;
  const map = state.machine.heightMap;
  const a = state.machine.heightMapAssess;
  if (!map || !a) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  const warnings = hmWarningTexts(a);
  host.classList.remove('hidden');
  host.innerHTML = `<div class="hm-head"><b>${t('hm.title')}</b>`
    + `<span class="muted">${t('hm.meta', { i: map.cols, j: map.rows, w: map.xSize.toFixed(1), h: map.ySize.toFixed(1) })}</span>`
    + `<span class="hm-actions">${hmChipHtml()}</span></div>`
    + (warnings.length
      ? warnings.map((w) => `<div class="check warn"><span class="ico">⚠</span><span>${escapeHtml(w)}</span></div>`).join('')
      : `<div class="check ok"><span class="ico">✓</span><span>${escapeHtml(t('hm.flatOk'))}</span></div>`);
}

// Full-screen modal with the interactive 3D surface (three.js bundle) or the
// 2D heatmap fallback when the bundle is unavailable.
function openHeightMapModal() {
  const map = state.machine.heightMap;
  const a = state.machine.heightMapAssess;
  if (!map) return;
  const el = $('#hmModal');
  if (!el) return;
  const warnings = a ? hmWarningTexts(a) : [];
  el.classList.remove('hidden');
  el.innerHTML = `<div class="hm-box" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('hm.title'))}">
      <div class="hm-box-head">
        <b>${t('hm.title')}</b>
        <span class="muted">${t('hm.meta', { i: map.cols, j: map.rows, w: map.xSize.toFixed(1), h: map.ySize.toFixed(1) })}</span>
        <span class="hm-legend"><i style="background:hsl(120,85%,50%)"></i>${t('hm.legendFlat')} <i style="background:hsl(60,85%,50%)"></i> <i style="background:hsl(0,85%,50%)"></i>${t('hm.legendDev')}</span>
        <button class="btn small ghost" id="hmClose">${t('hm.close')}</button>
      </div>
      ${a ? `<div class="hm-box-meta">${t('hm.range', { min: a.min.toFixed(3), max: a.max.toFixed(3) })} · ${t('hm.maxDev', { dev: a.maxDeviation.toFixed(2) })} · ${t('hm.tilt', { tilt: a.tiltMm.toFixed(2) })}</div>` : ''}
      ${warnings.map((w) => `<div class="check warn"><span class="ico">⚠</span><span>${escapeHtml(w)}</span></div>`).join('')}
      <div class="hm-canvas-host" id="hmCanvasHost"><div class="hm-tip hidden" id="hmTip"></div></div>
      <div class="muted hm-hint">${t('hm.hint')}</div>
    </div>`;
  $('#hmClose', el).addEventListener('click', closeHeightMapModal);
  el.addEventListener('click', (e) => { if (e.target === el) closeHeightMapModal(); });
  const host = $('#hmCanvasHost', el);
  const Viewer = window.MakeraHeightMap3D;
  if (Viewer) {
    try {
      hmViewer3d = new Viewer(host, { tooltipEl: $('#hmTip', el), warnMm: LEVELING_MAX_DEV_WARN_MM });
      hmViewer3d.setData(map);
      return;
    } catch { /* fall through to 2D */ }
  }
  const cv = document.createElement('canvas');
  cv.className = 'hm-canvas2d';
  host.appendChild(cv);
  drawHeightMap2D(cv, map);
}
function closeHeightMapModal() {
  const el = $('#hmModal');
  if (!el) return;
  if (hmViewer3d) { try { hmViewer3d.dispose(); } catch {} hmViewer3d = null; }
  el.classList.add('hidden');
  el.innerHTML = '';
}

// Support hook: reproduce a height map from pasted machine-log lines in the
// browser console — window.__makeraHeightMap.show([...lines]). Runs the exact
// same parse → assess → panel → 3D path as the automatic fetch.
window.__makeraHeightMap = {
  parse: parseLevelingFromLog,
  show(lines) {
    const map = parseLevelingFromLog(lines);
    if (!map) return null;
    state.machine.heightMap = map;
    state.machine.heightMapAssess = assessHeightMap(map);
    renderHeightMapPanel();
    renderFab();
    openHeightMapModal();
    return state.machine.heightMapAssess;
  },
};

// ---------- setup assistant (Machine tab) ----------
// Walks a new project through connect → home/alarm → place board → origin →
// probe/leveling → start job. Step states are DETECTED from the live status
// (connection, Alarm/Home, origin badge, Z offset) — manual steps are ticked
// by the user. Renders only when something changed so buttons stay clickable.
// (SETUP_PLACED_KEY lives in project-reset.js — it must be cleared on every
// project switch.)
const SETUP_Z_SET_EPSILON_MM = 0.01; // WCO-Z beyond this = Z was probed/set

function setupSteps() {
  const connected = state.machine.connected;
  const st = state.machine.state;
  const s = state.machine.status;
  const inAlarm = st === 'Alarm' || st === 'Halt';
  // A homed Carvera never reports MPos above the -1 mm soft-endstop maximum
  // (Robot.cpp:345-347). Positive MPos = reset/power-cycle without homing:
  // WCO (and therefore the origin/Z "done" detection) is meaningless then.
  const unhomed = notHomedFromStatus(s) === true;
  const oset = originIsSet(s);
  const m = s?.mpos; const w = s?.wpos;
  const wcoZ = (m && w && m.length > 2 && w.length > 2) ? m[2] - w[2] : 0;
  const placed = !!loadJSON(SETUP_PLACED_KEY, false);
  const steps = [];
  steps.push({
    id: 'connect',
    status: connected ? 'done' : 'todo',
    desc: t('setup.connect.i'),
    btn: connected ? null : { action: 'connect', label: t('setup.connect.btn') },
  });
  steps.push({
    id: 'ready',
    status: !connected ? 'blocked' : inAlarm ? 'error' : st === 'Home' ? 'wait' : unhomed ? 'todo' : 'done',
    desc: inAlarm ? t('setup.ready.iAlarm') : st === 'Home' ? t('setup.ready.iHoming') : unhomed ? t('setup.ready.iUnhomed') : t('setup.ready.i'),
    btn: inAlarm
      ? { action: 'ack', label: t('setup.ready.ackBtn') }
      : { action: 'home', label: t('setup.ready.homeBtn') },
  });
  steps.push({
    id: 'place',
    status: placed ? 'done' : 'todo',
    desc: t('setup.place.i'),
    btn: { action: 'place', label: placed ? t('setup.place.undoBtn') : t('setup.place.btn') },
  });
  steps.push({
    id: 'origin',
    status: !connected ? 'blocked' : (oset === true && !unhomed) ? 'done' : 'todo',
    desc: unhomed && oset === true ? t('setup.origin.iUnhomed') : t('setup.origin.i'),
    btn: { action: 'origin', label: t('setup.origin.btn') },
  });
  steps.push({
    id: 'probe',
    status: !connected ? 'blocked' : (Math.abs(wcoZ) > SETUP_Z_SET_EPSILON_MM && !unhomed) ? 'done' : 'todo',
    desc: t('setup.probe.i'),
    btn: { action: 'probe', label: t('setup.probe.btn') },
  });
  steps.push({
    id: 'job',
    status: st === 'Run' ? 'done' : !connected ? 'blocked' : 'todo',
    desc: t('setup.job.i'),
    btn: { action: 'job', label: t('setup.job.btn') },
  });
  return steps;
}

function renderSetupAssistant() {
  const host = $('#setupAssist');
  if (!host) return;
  const steps = setupSteps();
  const sig = getLang() + JSON.stringify(steps.map((s) => [s.status, s.desc, s.btn?.label]));
  if (host.dataset.sig === sig) return; // nothing changed — keep the DOM stable
  host.dataset.sig = sig;
  const active = steps.find((x) => x.status === 'todo' || x.status === 'error' || x.status === 'wait');
  host.innerHTML = `<div class="sa-head"><b>${t('setup.title')}</b> <span class="muted">${t('setup.subtitle')}</span></div>`
    + steps.map((s, i) => {
      const ico = s.status === 'done' ? '✓' : s.status === 'error' ? '⚠' : s.status === 'wait' ? '⋯' : String(i + 1);
      const isActive = active && active.id === s.id;
      const btn = s.btn
        ? `<button class="btn small ${isActive ? 'primary' : 'ghost'}" data-assist="${s.btn.action}">${escapeHtml(s.btn.label)}</button>`
        : '';
      return `<div class="sa-step ${s.status}${isActive ? ' active' : ''}">`
        + `<span class="sa-num">${ico}</span>`
        + `<div class="sa-main"><div class="sa-title">${escapeHtml(t('setup.' + s.id + '.t'))}</div><div class="sa-desc">${escapeHtml(s.desc)}</div></div>`
        + `<div class="sa-act">${btn}</div></div>`;
    }).join('');
}

async function setupProbeFlow() {
  if (!state.machine.connected) return toast(t('machine.connectFirst'), true);
  // Config & Run: DON'T pre-set the tool number (M493.2 T0) — the firmware's
  // M495 changes to the probe ITSELF when needed ("Change to probe tool
  // first!", ATCHandler.cpp:2466-2488) including the TLO calibration of the
  // probe. A bare M493.2 T0 would make it SKIP that calibration and corrupt
  // the next tool's length offset.
  machineAction('autoSetup');
}

async function setupAction(action) {
  switch (action) {
    case 'connect':
      switchWf('machine');
      if ($('#mIp').value.trim()) machineConnect(); else machineDiscover();
      return;
    case 'ack':
      // Acknowledge an alarm the official way: soft reset, then unlock ($X).
      await machineRealtime('reset');
      setTimeout(() => machineCommand('$X'), 800);
      toast(t('setup.ready.acked'));
      return;
    case 'home': return machineAction('home');
    case 'place': {
      const cur = !!loadJSON(SETUP_PLACED_KEY, false);
      saveJSON(SETUP_PLACED_KEY, !cur);
      renderSetupAssistant();
      return;
    }
    case 'origin':
      if (jobActive()) return toast(t('job.alreadyRunning'), true);
      return setOriginAnchor1Flow();
    case 'probe':
      if (jobActive()) return toast(t('job.alreadyRunning'), true);
      return setupProbeFlow();
    case 'job': switchWf('fab'); return;
  }
}

async function machineCommand(line) {
  if (!state.machine.connected) return toast(t('machine.notConnected'), true);
  try { await api('/api/machine/command', { line }); } catch (err) { toast(err.message, true); }
}
// Send a SEQUENCE of commands strictly in order (each request is awaited, so
// e.g. the safe Z raise is guaranteed to reach the machine before the XY move).
// Resolves true when every command was accepted.
async function machineCommands(lines) {
  if (!state.machine.connected) { toast(t('machine.notConnected'), true); return false; }
  try {
    for (const line of lines) await api('/api/machine/command', { line });
    return true;
  } catch (err) { toast(err.message, true); return false; }
}
async function machineRealtime(code) {
  if (!state.machine.connected) return toast(t('machine.notConnected'), true);
  try { await api('/api/machine/realtime', { code }); } catch (err) { toast(err.message, true); }
}

// ---------- one-click "origin = anchor 1" (sequenced, fault-tolerant) ----------
// M496.x moves execute DEFERRED on the firmware main loop (see
// machine-commands.js), so after "goto anchor 1" we must wait until the
// machine is Idle again before touching the coordinate system. Sending the
// next command immediately is what used to trip "Soft Endstop X was exceeded".
const ANCHOR_MOVE_TIMEOUT_MS = 60000; // anchor rapid across the whole bed < 1 min
const ANCHOR_POLL_INTERVAL_MS = 400; // faster than the regular 1 s status poll
const ANCHOR_MOVE_MIN_WAIT_MS = 1500; // let the deferred move actually start
const ANCHOR_IDLE_STREAK = 2; // consecutive Idle samples = move finished

async function waitForIdleAfterMove(timeoutMs = ANCHOR_MOVE_TIMEOUT_MS) {
  const t0 = Date.now();
  let idleStreak = 0;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, ANCHOR_POLL_INTERVAL_MS));
    let d;
    try { const res = await fetch('/api/machine/status'); d = await res.json(); } catch { continue; }
    if (!d.connected) return { ok: false, reason: 'disconnected' };
    if (d.status) state.machine.status = d.status;
    const st = d.status?.state;
    if (st === 'Alarm' || st === 'Halt') return { ok: false, reason: 'alarm' };
    if (st === 'Idle' && Date.now() - t0 >= ANCHOR_MOVE_MIN_WAIT_MS) {
      if (++idleStreak >= ANCHOR_IDLE_STREAK) return { ok: true };
    } else if (st !== 'Idle') {
      idleStreak = 0;
    }
  }
  return { ok: false, reason: 'timeout' };
}

let anchorFlowRunning = false;
async function setOriginAnchor1Flow() {
  if (anchorFlowRunning) return;
  // Preconditions with actionable messages instead of firing blindly: an
  // alarmed/homing/busy machine must not start the sequence at all.
  const ready = anchor1Readiness(state.machine.status, state.machine.connected);
  if (!ready.ok) {
    const key = {
      'not-connected': 'machine.notConnected',
      'no-status': 'anchor.noStatus',
      alarm: 'anchor.alarmFirst',
      homing: 'anchor.homingWait',
      busy: 'anchor.busy',
    }[ready.reason] || 'anchor.noStatus';
    toast(t(key), true);
    if (ready.reason === 'not-connected') switchWf('machine');
    return;
  }
  if (!confirm(t('confirm.setOriginAnchor1', { x: ANCHOR1_OFFSET.x, y: ANCHOR1_OFFSET.y }))) return;
  anchorFlowRunning = true;
  try {
    toast(t('anchor.driving'));
    if (!(await machineCommands([gotoAnchor1Command()]))) return;
    const wait = await waitForIdleAfterMove();
    if (!wait.ok) {
      const key = wait.reason === 'alarm' ? 'anchor.moveAlarm'
        : wait.reason === 'disconnected' ? 'machine.notConnected'
        : 'anchor.moveTimeout';
      toast(t(key), true);
      logEvent('log.alarm', { msg: t(key) }, 'error');
      return;
    }
    // Pure WCS bookkeeping (no motion): current position (= anchor 1) becomes
    // work 0/0 → the work origin sits exactly ON anchor 1 = the board corner.
    if (!(await machineCommands(setOriginAtAnchorOffsetCommands()))) return;
    toast(t('machine.originAnchorSet', { x: ANCHOR1_OFFSET.x, y: ANCHOR1_OFFSET.y }));
    logEvent('log.originAnchorSet', {});
  } finally {
    anchorFlowRunning = false;
  }
}
async function machineJog(axis, sign) {
  if (!state.machine.connected) return toast(t('machine.notConnected'), true);
  const step = Number($('#jogStep').value) || 1;
  const feed = Number($('#jogFeed').value) || 800;
  const dist = (sign < 0 ? '-' : '') + step;
  try { await api('/api/machine/jog', { axis, dist, feed }); } catch (err) { toast(err.message, true); }
}
// Hold-to-jog: a quick tap moves one step; holding a button jogs continuously
// (a single large jog) until release, when a realtime jog-cancel (0x19) stops it.
// Hold-to-jog: STREAM small incremental jogs while the button is held, instead of one
// huge jog. A single big jog (e.g. 340 mm) overshoots the machine's soft limits from
// almost anywhere and trips "Soft Endstop exceeded". Small steps far from the limit are
// always safe; a realtime jog-cancel (0x19) on release stops/flushes smoothly. If a step
// does hit the edge, the request errors and we stop streaming (no alarm spam).
let jogStreaming = false;
const JOG_STEP = { X: 2, Y: 2, Z: 1, A: 4 };
async function machineJogContinuous(axis, sign) {
  if (!state.machine.connected) return toast(t('machine.notConnected'), true);
  const feed = Number($('#jogFeed').value) || 800;
  const step = JOG_STEP[axis] || 2;
  jogStreaming = true;
  const loop = async () => {
    if (!jogStreaming) return;
    const dist = (sign < 0 ? '-' : '') + step;
    try { await api('/api/machine/jog', { axis, dist, feed }); }
    catch { jogStreaming = false; return; } // reached a soft limit at the edge → stop cleanly
    if (jogStreaming) setTimeout(loop, 60);
  };
  loop();
}
async function machineJogStop() {
  jogStreaming = false;
  if (!state.machine.connected) return;
  try { await api('/api/machine/realtime', { code: 'jogstop' }); } catch { /* ignore */ }
}
function bindJog() {
  $$('[data-jog]').forEach((b) => {
    const axis = b.dataset.jog;
    const sign = Number(b.dataset.sign);
    let holdTimer = null;
    let continuous = false;
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      continuous = false;
      holdTimer = setTimeout(() => { continuous = true; machineJogContinuous(axis, sign); }, 300);
    });
    b.addEventListener('pointerup', () => {
      clearHold();
      if (continuous) { machineJogStop(); continuous = false; }
      else { machineJog(axis, sign); } // quick tap = one step
    });
    const abort = () => { clearHold(); if (continuous) { machineJogStop(); continuous = false; } };
    b.addEventListener('pointerleave', abort);
    b.addEventListener('pointercancel', abort);
  });
}
// ---------- help tooltips (the "?" badges) ----------
let helpTipEl = null;
function showHelpTip(badge) {
  const text = badge.getAttribute('data-tip');
  if (!text) return;
  if (!helpTipEl) { helpTipEl = document.createElement('div'); helpTipEl.id = 'helpTip'; document.body.appendChild(helpTipEl); }
  helpTipEl.textContent = text;
  helpTipEl.style.display = 'block';
  const r = badge.getBoundingClientRect();
  const tw = helpTipEl.offsetWidth;
  const th = helpTipEl.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = r.top - th - 8;
  helpTipEl.classList.toggle('below', top < 8);
  if (top < 8) top = r.bottom + 8;
  helpTipEl.style.left = `${left}px`;
  helpTipEl.style.top = `${top}px`;
}
function hideHelpTip() { if (helpTipEl) helpTipEl.style.display = 'none'; }
function initHelpTips() {
  const findBadge = (e) => (e.target instanceof Element ? e.target.closest('.help[data-tip]') : null);
  document.addEventListener('pointerover', (e) => { const b = findBadge(e); if (b) showHelpTip(b); });
  document.addEventListener('pointerout', (e) => { if (e.target instanceof Element && e.target.closest('.help')) hideHelpTip(); });
  document.addEventListener('focusin', (e) => { const b = findBadge(e); if (b) showHelpTip(b); });
  document.addEventListener('focusout', (e) => { if (e.target instanceof Element && e.target.closest('.help')) hideHelpTip(); });
  // a click on the "?" must never trigger the control it sits next to / inside
  document.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('.help')) { e.preventDefault(); e.stopPropagation(); } }, true);
  window.addEventListener('scroll', hideHelpTip, true);
}
function machineAction(action) {
  const b = state.result?.board;
  const w = b ? b.width.toFixed(2) : 0;
  const h = b ? b.height.toFixed(2) : 0;
  const need = () => { if (!b) { toast(t('machine.loadFirst'), true); return false; } return true; };
  // NOTE: probing / leveling / Config & Run no longer require T0 up front —
  // the firmware's M495 changes to the probe itself when needed (tool-wait
  // overlay + TLO calibration, ATCHandler.cpp:2466-2488). Pre-setting the
  // number with M493.2 T0 would skip that calibration (stale cur_tool_mz)
  // and corrupt the next tool's length offset.
  // In Alarm/Homing the work coordinate system is invalid, so any absolute move or
  // origin set would go to the wrong place ("forgot its coordinate system"). Block it.
  const needReady = () => {
    const st = state.machine.state;
    if (st === 'Alarm' || st === 'Home') { toast(t('machine.homeFirst'), true); return false; }
    return true;
  };
  // Work-coordinate moves are meaningless before a workpiece origin was set:
  // with WCO = 0 every "work" position is really measured from the machine's
  // reference corner (top right). Warn loudly and let the user opt in.
  const needOrigin = () => {
    if (originIsSet(state.machine.status) !== false) return true;
    return confirm(t('confirm.noOrigin'));
  };
  switch (action) {
    case 'home': return machineCommand('$H');
    case 'unlock': return machineCommand('$X');
    case 'reset': return machineRealtime('reset');
    case 'pause': return machineRealtime('pause');
    case 'resume': return machineRealtime('resume');
    case 'stop': if (confirm(t('confirm.stop'))) machineRealtime('reset'); return;
    case 'setOriginXYZ': if (!needReady()) return; if (confirm(t('confirm.setOriginXYZ'))) { machineCommand('G10 L20 P0 X0 Y0 Z0'); toast(t('machine.originSet')); } return;
    case 'setOriginXY': if (!needReady()) return; if (confirm(t('confirm.setOriginXY'))) { machineCommand('G10 L20 P0 X0 Y0'); toast(t('machine.originSet')); } return;
    // One-click anchor-1 origin: goto anchor 1 (M496.3), WAIT until the
    // deferred firmware move finished, then set the origin via G10 L20 at the
    // Makera offset — no relative move, no soft-endstop risk (see the flow).
    case 'setOriginAnchor1': setOriginAnchor1Flow(); return;
    case 'gotoClearance': machineCommand('M496.1'); toast(t('machine.cmdSent')); return;
    case 'gotoOrigin':
      // Return to the work origin you set (G54 zero). Raise Z straight up in machine
      // coords first (G53 = near the top, no XY dart to the corner), then rapid to
      // work X0/Y0 in YOUR coordinate system.
      if (!needReady() || !needOrigin()) return;
      machineCommands(gotoWorkOriginCommands());
      toast(t('machine.cmdSent'));
      return;
    case 'gotoXY': {
      if (!needReady()) return;
      const gx = parseFloat($('#gotoX').value);
      const gy = parseFloat($('#gotoY').value);
      // "Go to X/Y" moves in YOUR work coordinate system (relative to the origin you set),
      // which is what one intuitively expects: X0 Y15 = 15 mm from your zero. Raise Z
      // straight up first (G53, no corner dart), then move XY absolute in the WCS.
      const cmds = gotoWorkXYCommands(gx, gy);
      if (!cmds.length) return toast(t('machine.gotoNeedXY'), true);
      if (!needOrigin()) return;
      if (!confirm(t('confirm.gotoXY', { x: Number.isFinite(gx) ? gx : '–', y: Number.isFinite(gy) ? gy : '–' }))) return;
      machineCommands(cmds);
      toast(t('machine.cmdSent'));
      return;
    }
    // Scan margin / Z-probe / leveling run ON THE BOARD AREA: the placement
    // offset (drag & drop) shifts their start via the M495 X/Y letters — the
    // same offset the generated G-code was shifted by (activePlacement()).
    case 'margin': if (!need() || !needReady()) return; if (confirm(t('confirm.margin'))) { machineCommand(scanMarginCommand(b.width, b.height, activePlacement())); toast(t('machine.cmdSent')); } return;
    // Workpiece Auto-Z-Probe at the board's bottom-left corner (O0 F0 →
    // fill_zprobe_scripts: probe on the board, surface becomes Z0). O WITHOUT
    // F would select the firmware's 4TH-AXIS absolute probe, which places Z0
    // ~23 mm BELOW the touched surface (rotation_offset_z) — that exact
    // parameter bug once milled straight through a board. See machine-commands.js.
    case 'probe': if (!needReady()) return; if (confirm(t('confirm.probe'))) { machineCommand(zProbeCommand(activePlacement())); startJobMonitor('probeZ', 'M495 Z-Probe', 'command'); toast(t('machine.cmdSent')); } return;
    case 'level': {
      if (!need() || !needReady()) return;
      // Makera PCB default is a 5×5 grid at 2 mm detection height; add points
      // for larger boards, capped at 9×9 (levelingGrid).
      const { i, j } = levelingGrid(b.width, b.height);
      if (confirm(t('confirm.level', { i, j }))) {
        machineCommand(autoLevelCommand(b.width, b.height, { i, j }, activePlacement()));
        startJobMonitor('levelMap', 'M495 Auto-Leveling', 'command');
        toast(t('machine.cmdSent'));
      }
      return;
    }
    // "Insert the wired probe (T0)": a REAL M6 T0 — drives to the change
    // position, waits (tool-change overlay), then measures the probe on the
    // TLO sensor. That calibration is what keeps the next tool's length
    // offset correct (ref_tool_mz chain). If the machine already reports T0,
    // recalibrate with M491 instead (M6 T0 would be a no-op then).
    case 'probeIn': {
      if (!needReady()) return;
      const cmd = insertProbeCommand(state.machine.tool);
      if (confirm(t(cmd === 'M491' ? 'confirm.probeCali' : 'confirm.probeIn'))) {
        machineCommand(cmd);
        startJobMonitor('insertProbe', cmd, 'command');
        toast(t('machine.probeStarted'));
      }
      return;
    }
    // Recovery only: correct the stored tool number WITHOUT calibration
    // (M493.2). Warning: this skips the TLO measurement — the next Z probe /
    // tool change works with a stale reference. Prefer "probeIn" (M6 T0).
    case 'probeChange': if (confirm(t('confirm.probeChange'))) { machineCommand('M493.2 T0'); toast(t('machine.probeStarted')); } return;
    case 'autoSetup': {
      if (!need() || !needReady()) return;
      // One combined M495 = Makera "Config and Run": Scan Margin (C/D) +
      // Auto Z Probe at the work origin (O0 F0!) + Auto Leveling (A/B grid,
      // H2) + park (P1). If the probe is not the active tool the firmware
      // inserts the tool change itself (overlay pops, then it calibrates).
      const { i, j } = levelingGrid(b.width, b.height);
      if (confirm(t('confirm.autoSetup', { i, j }))) {
        machineCommand(configAndRunCommand(b.width, b.height, { i, j }, activePlacement()));
        startJobMonitor('autoSetup', 'M495 Config & Run', 'command');
        toast(t('machine.cmdSent'));
      }
      return;
    }
    // --- accessories (Supported Codes) ---
    case 'lightOn': return machineCommand('M821');
    case 'lightOff': return machineCommand('M822');
    // External vacuum / air cleaner on the Air's external control port
    // (M851/M852 — switch.extendout; on the Air M331/M332 would only arm the
    // UNCONNECTED internal-vacuum switch, see machine-commands.js). A manual
    // switch cancels a pending automatic run-on so it can't override the user.
    case 'vacOn': cancelVacuumOffTimer(); return machineCommand(VACUUM_ON_COMMAND);
    case 'vacOff': cancelVacuumOffTimer(); return machineCommand(VACUUM_OFF_COMMAND);
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
  // Starting a job without a workpiece origin would mill relative to the
  // machine's reference corner (top right) — warn explicitly before running.
  if (start && originIsSet(state.machine.status) === false && !confirm(t('confirm.noOrigin'))) return;
  if (start && !jobSafetyGateOk()) return;
  if (start && !confirm(t('confirm.runUpload', { name }))) return;
  // Manual "Upload & Start" gets the same live monitoring as a fabrication
  // step (blocks parallel starts, drives the vacuum automation incl. the
  // off-after-failure safety net). No stepId — it is not a guided step.
  if (start) startJobMonitor(null, name, 'play');
  try {
    const d = await api('/api/machine/run', { name, gcode, start });
    toast(start ? t('machine.started', { path: d.path }) : t('machine.uploaded', { path: d.path }));
    logEvent(start ? 'log.started' : 'log.uploaded', { path: d.path });
  } catch (err) {
    if (start) {
      state.fab.job = null; // upload failed — free the monitor
      // the start already switched the vacuum on → schedule the run-on off
      applyVacuumEvents([{ type: 'state', state: JOB_STATE.FAILED, prev: JOB_STATE.STARTING }], vacuumJobKind(name, 'play'));
      renderFab();
    }
    toast(t('machine.uploadErr', { msg: err.message }), true);
    logEvent('log.genError', { msg: err.message }, 'error');
  }
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

function applyPcbPackDefaults() {
  setPath('isolation.tipWidth', 0.2);
  setPath('outline.cutterDiameter', 2.0);
  setPath('clearing.toolDiameter', 2.0);
}

// ---------- standard tools ----------
function loadStandardTools() {
  state.tools = STANDARD_TOOLS.map((t) => ({ ...t }));
  state.assignment = { ...DEFAULT_PCB_ASSIGNMENT };
  saveJSON('makera_tools', state.tools);
  saveJSON('makera_assignment', state.assignment);
  applyPcbPackDefaults();
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
// Ask the AI to diagnose the machine log (leverages the OpenAI key from the AI tab / .env).
async function aiDiagnose() {
  const apiKey = $('#aiKey')?.value.trim() || '';
  if (!apiKey && !state.aiHasServerKey) { switchWf('ai'); return toast(t('ai.keyRequired'), true); }
  const model = $('#aiModel')?.value.trim() || 'gpt-5.5';
  const log = (document.querySelector('.mach-console')?.textContent || '').trim();
  if (!log) return toast(t('ai.noLog'), true);
  const box = $('#mConsoleAi');
  if (box) { box.classList.remove('hidden'); box.innerHTML = `<p class="muted">${t('ai.diagnosing')}</p>`; }
  toast(t('ai.diagnosing'));
  try {
    const r = await api('/api/ai/diagnose', {
      apiKey, model,
      log: log.split('\n'),
      config: state.result ? readConfig() : null,
      board: state.result?.board || null,
      stats: { tool: state.machine.tool, isolationRings: state.result?.stats?.isolationRings },
    });
    renderDiagnose(r);
  } catch (err) {
    if (box) box.innerHTML = `<div class="ai-summary">${escapeHtml(t('ai.errorLabel', { msg: err.message }))}</div>`;
    toast(t('ai.failed', { msg: err.message }), true);
  }
}
function renderDiagnose(r) {
  const box = $('#mConsoleAi');
  if (!box) return;
  box.classList.remove('hidden');
  const steps = (r.fixSteps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  const cmds = (r.commands || []).map((c) =>
    `<div class="ai-cmd"><code>${escapeHtml(c)}</code><button class="btn small ghost" data-sendcmd="${escapeHtml(c)}">${t('ai.send')}</button></div>`).join('');
  box.innerHTML = `<div class="ai-summary">${escapeHtml(r.summary || '')}</div>`
    + (r.cause ? `<div class="check warn"><span class="ico">⚠</span><span>${escapeHtml(r.cause)}</span></div>` : '')
    + (steps ? `<ol class="ai-steps">${steps}</ol>` : '')
    + (cmds ? `<div class="ai-cmds"><b>${t('ai.cmds')}</b>${cmds}</div>` : '');
  box.querySelectorAll('[data-sendcmd]').forEach((b) => b.addEventListener('click', () => {
    if (!state.machine.connected) return toast(t('machine.notConnected'), true);
    machineCommand(b.dataset.sendcmd); toast(t('machine.cmdSent'));
  }));
}
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
  renderSetupAssistant();
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
  // vacuum.* stays OUT of the project: it is a machine-/user-level setting
  // persisted in localStorage (makera_vacuum), not part of the board job.
  for (const el of $$('[data-path]')) {
    if (el.dataset.path.startsWith('vacuum.')) continue;
    form[el.dataset.path] = el.type === 'checkbox' ? el.checked : el.value;
  }
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
    conn: { ip: $('#mIp')?.value.trim() || '', port: Number($('#mPort')?.value) || 2222 },
  };
}
function hasWorkspace() {
  return !!(state.files.copper || state.files.edge || state.files.drill || state.files.silk);
}
// opts.freshProject: true for new/load/import (reset manual ticks + monitors),
// false when restoring the SAME project after a page reload (keep the ticks).
function applyProject(p, { freshProject = true } = {}) {
  if (!p) return;
  state.files = { copper: null, edge: null, drill: null, silk: null };
  for (const role of ['copper', 'edge', 'drill', 'silk']) {
    const f = p.files?.[role];
    const slot = $(`.slot[data-role="${role}"]`);
    if (f && f.content) { state.files[role] = { name: f.name, content: f.content }; slot.classList.add('filled'); $('[data-name]', slot).textContent = f.name; }
    else if (slot) { slot.classList.remove('filled'); $('[data-name]', slot).textContent = '—'; }
  }
  // The placement offset is part of the project; a project without one (older
  // snapshot / new project) falls back to the default corner position.
  setPlacementOffset(0, 0);
  if (p.form) for (const [path, val] of Object.entries(p.form)) {
    if (path.startsWith('vacuum.')) continue; // machine-level, localStorage-owned
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
  if (p.conn && p.conn.ip && $('#mIp')) {
    $('#mIp').value = p.conn.ip;
    if ($('#mPort')) $('#mPort').value = p.conn.port || 2222;
    const idx = state.conns.findIndex((c) => c.ip === p.conn.ip && String(c.port) === String(p.conn.port || 2222));
    if (idx >= 0 && $('#mProfiles')) $('#mProfiles').value = String(idx);
  }
  state.projectLog = Array.isArray(p.log) ? p.log.slice() : [];
  renderLog();
  $('#generate').disabled = !state.files.copper;
  state.result = null;
  if (freshProject) {
    // New board = new physical setup: manual assistant/fabrication ticks and
    // a monitored job belong to the OLD project (project-reset.js). The
    // machine-side states (connect/home/origin/Z) stay live-detected.
    resetProjectScopedState(state, localStorage);
    renderHeightMapPanel();
    renderToolChangeOverlay(state.machine.status); // overlay follows live status only
    if (state.machine.connected) pollStatus(); // refresh the live status once
  } else {
    state.fab.done = {}; state.fab.view = null;
  }
  renderSetupAssistant();
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
  try { saveProjects(projs); } catch { return toast(t('proj.saveFail'), true); }
  setCurrentProjectId(id); renderProjects();
  toast(t('proj.saved', { name }));
}
function projSave() {
  const cur = currentProjectId();
  const projs = loadProjects();
  if (!cur || !projs[cur]) return projSaveAs();
  const name = projs[cur].name || t('proj.defaultName');
  projs[cur] = { ...projectSnapshot(), name, createdAt: projs[cur].createdAt || Date.now() };
  try { saveProjects(projs); } catch { return toast(t('proj.saveFail'), true); }
  renderProjects();
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
  applyProject({ files: {}, form: {}, tools: STANDARD_TOOLS.map((x) => ({ ...x })), assignment: { ...DEFAULT_PCB_ASSIGNMENT }, matPreset: 'mk-ss-100x150', matSides: 'single' });
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
  $('#pvFit')?.addEventListener('click', fitPreview);
  $('#pvMeasure')?.addEventListener('click', toggleMeasure);
  bindPreviewInteraction();

  $('#addTool').addEventListener('click', () => {
    const n = (state.tools.reduce((m, t) => Math.max(m, t.number), 0) || 0) + 1;
    state.tools.push({ number: n, type: 'endmill', diameter: 1.0, collet: 2, label: '' });
    saveJSON('makera_tools', state.tools); renderTools(); renderAssignments();
  });

  // machine
  $('#machHeaderState').addEventListener('click', () => switchWf('machine'));
  $('#setupAssist')?.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-assist]') : null;
    if (b) setupAction(b.dataset.assist);
  });
  $('#dockToggle').addEventListener('click', () => toggleDock());
  $('#dockGoMachine').addEventListener('click', () => switchWf('machine'));
  $('#dockCopyLog').addEventListener('click', copyMachineLog);
  $('#mConsoleCopy')?.addEventListener('click', copyMachineLog);
  $('#mConsoleAiBtn')?.addEventListener('click', aiDiagnose);
  $('#dockAiBtn')?.addEventListener('click', aiDiagnose);
  if (loadJSON('makera_dock', false)) toggleDock(true);
  $('#mDiscover').addEventListener('click', machineDiscover);
  $('#mConnect').addEventListener('click', machineConnect);
  $('#mDisconnect').addEventListener('click', machineDisconnect);
  $('#mdiSend').addEventListener('click', () => { const v = $('#mdiInput').value.trim(); if (v) { machineCommand(v); $('#mdiInput').value = ''; } });
  $('#mdiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#mdiSend').click(); });
  $$('[data-action]').forEach((b) => b.addEventListener('click', () => machineAction(b.dataset.action)));
  // height-map chips are re-rendered in several places → delegated handler
  document.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-hmopen]')) openHeightMapModal();
  });
  bindJog();
  initHelpTips();
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

  // board placement (drag & drop + numeric fields, kept snapped/clamped)
  bindMaterialDrag();
  ['#placeOffX', '#placeOffY'].forEach((sel) => $(sel)?.addEventListener('change', () => {
    const p = placementOffset();
    const n = normalizePlacement(p.x, p.y);
    setPlacementOffset(n.x, n.y);
    drawMaterialPreview(); // regen runs via the generic data-path handler
  }));
  $('#placeReset')?.addEventListener('click', () => {
    setPlacementOffset(0, 0);
    scheduleGenerate();
  });

  // external vacuum automation settings (localStorage, machine-level)
  loadVacuumSettings();
  ['#vacAuto', '#vacLinger', '#vacPauseTc', '#vacLaser'].forEach((sel) => {
    $(sel)?.addEventListener('change', saveVacuumSettings);
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
  initDockPadding();
  renderSetupAssistant();
  loadAiConfig();
  loadMeta();
  restoreMachineConnection(); // reconnect to the machine after a reload / drop
  saveJSON('makera_tools', state.tools); // persist backfilled feeds/speeds
  renderTools();
  renderAssignments();
  updateActionButtons();
  renderProjects();
  applyI18n(); // translate all static markup for the active language
  switchWf(loadJSON('makera_wf', 'material'));

  // resume the last open project (full workspace) if there is one — a reload
  // of the SAME project keeps the manual ticks (freshProject: false)
  const cur = currentProjectId();
  const projs = loadProjects();
  if (cur && projs[cur]) applyProject(projs[cur], { freshProject: false });
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
