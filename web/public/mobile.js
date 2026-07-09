// makera-pcb · mobile remote control.
//
// Standalone touch UI for driving the Carvera Air from a phone on the same LAN.
// It talks ONLY to the makera-pcb server (same HTTP endpoints as the desktop
// Machine tab) — the server holds the single TCP connection the machine allows,
// so desktop and phone share one machine link. Own tiny DE/EN dictionary on
// purpose: web/public/i18n.js belongs to the desktop app and stays untouched.

'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------------------------------------------------------------- i18n ------
const I18N = {
  de: {
    'title.sub': 'Fernbedienung',
    'conn.title': 'Verbindung',
    'conn.off': 'getrennt',
    'conn.on': 'verbunden',
    'conn.discover': 'Maschine suchen',
    'conn.searching': 'Suche läuft…',
    'conn.none': 'Keine Maschine gefunden. IP unten manuell eingeben.',
    'conn.connect': 'Verbinden',
    'conn.disconnect': 'Trennen',
    'conn.free': 'frei',
    'conn.busy': 'belegt',
    'conn.enterIp': 'Bitte IP-Adresse eingeben.',
    'conn.connected': 'Verbunden mit {ip}.',
    'conn.connectErr': 'Verbinden fehlgeschlagen: {msg}',
    'conn.disconnected': 'Verbindung getrennt.',
    'conn.hint': 'Die Verbindung zur Maschine hält der Rechner, auf dem makera-pcb läuft — Desktop und Handy teilen sie sich.',
    'conn.thisUrl': 'Diese Fernbedienung: {url}',
    'net.lost': 'Keine Verbindung zum makera-pcb-Server. WLAN prüfen — es wird automatisch neu versucht.',
    'status.title': 'Status',
    'status.wpos': 'Werkstück (WPos · G54)',
    'status.mpos': 'Maschine (MPos)',
    'status.feed': 'Vorschub',
    'status.spindle': 'Spindel',
    'status.tool': 'Werkzeug',
    'status.upload': 'Upload…',
    'jog.title': 'Jog',
    'jog.step': 'Schritt',
    'act.title': 'Aktionen',
    'act.home': 'Home (Referenz oben rechts)',
    'act.unlock': 'Entsperren ($X)',
    'act.gotoOrigin': '→ Werkstück-Nullpunkt',
    'act.setXYZ': 'Origin hier setzen (XYZ)',
    'act.setXY': 'Origin hier setzen (XY)',
    'job.title': 'Job',
    'job.progress': 'Fortschritt',
    'job.pause': '⏸ Pause',
    'job.resume': '▶ Fortsetzen',
    'job.stop': '■ Stop',
    'acc.title': 'Zubehör',
    'acc.light': 'Licht',
    'acc.vac': 'Absaugung (extern)',
    'acc.fan': 'Spindel-Lüfter',
    'acc.beep': 'Piep',
    'acc.on': 'An',
    'acc.off': 'Aus',
    'acc.vacOn': 'AN',
    'acc.vacOff': 'aus',
    'foot.desktop': 'Desktop-Ansicht öffnen',
    'confirm.yes': 'Ja',
    'confirm.no': 'Abbrechen',
    'confirm.stop': 'Job/Bewegung wirklich stoppen (Reset)?',
    'confirm.homeRun': 'Es läuft gerade ein Job! Trotzdem Referenzfahrt starten? Die Maschine fährt nach oben rechts.',
    'confirm.setXYZ': 'Aktuelle Position als Werkstück-Nullpunkt (X/Y/Z, G54) setzen?',
    'confirm.setXY': 'Aktuelle Position als Werkstück-Nullpunkt (X/Y, G54) setzen? Z bleibt unverändert.',
    'confirm.gotoOrigin': 'Zum Werkstück-Nullpunkt fahren? Z fährt zuerst nach oben, dann X/Y zu deinem Nullpunkt.',
    'msg.sent': 'Befehl gesendet.',
    'msg.originSet': 'Werkstück-Nullpunkt gesetzt.',
    'msg.notConnected': 'Nicht mit der Maschine verbunden.',
    'msg.homeFirst': 'Maschine ist im Alarm-/Home-Zustand — erst Referenzfahrt (Home) bzw. Entsperren.',
    'alarm.state': 'Maschine im Zustand {state}',
    'alarm.reset': 'Reset',
    'alarm.unlock': 'Entsperren ($X)',
    'alarm.limit': 'Endschalter/Verfahrgrenze erreicht. Position prüfen, ggf. Nullpunkt korrigieren.',
    'alarm.probe': 'Antasten fehlgeschlagen. Taster (T0) eingesetzt, angeschlossen und geladen?',
    'alarm.resetToContinue': 'Maschine im Alarm. Mit „Reset“ quittieren, dann „Entsperren ($X)“.',
    'alarm.tool': 'Werkzeug-/Spannzangen-Problem. Werkzeug korrekt einsetzen, ggf. am Desktop kalibrieren.',
    'alarm.range': 'Wert/Fläche außerhalb des Arbeitsbereichs. Nullpunkt und Maße prüfen.',
    'alarm.generic': 'Mit „Reset“ + „Entsperren ($X)“ quittieren. Details im Desktop-Maschinen-Tab.',
    'tc.title': 'Maschine wartet: Werkzeug wechseln',
    'tc.tool': 'Werkzeug einsetzen:',
    'tc.body': 'Die Maschine ist an die Wechselposition gefahren, hat gepiept und wartet. Werkzeug bis zum Anschlag einsetzen, dann bestätigen – danach misst die Maschine die Werkzeuglänge automatisch und fräst weiter.',
    'tc.already': 'Schon eingesetzt? → direkt bestätigen.',
    'tc.confirm': 'Werkzeug eingesetzt – weiter ▶',
    'tc.orButton': '… oder den Knopf an der Maschine drücken.',
    'tc.resuming': 'Fortsetzen gesendet – Maschine misst die Werkzeuglänge …',
    'tc.cancel': 'Job abbrechen',
    'tc.cancelConfirm': 'Job wirklich abbrechen? Die Datei wird gestoppt und der Wartezustand beendet.',
    'tc.cancelled': 'Job abgebrochen.',
  },
  en: {
    'title.sub': 'Remote control',
    'conn.title': 'Connection',
    'conn.off': 'disconnected',
    'conn.on': 'connected',
    'conn.discover': 'Find machine',
    'conn.searching': 'Searching…',
    'conn.none': 'No machine found. Enter the IP below.',
    'conn.connect': 'Connect',
    'conn.disconnect': 'Disconnect',
    'conn.free': 'free',
    'conn.busy': 'busy',
    'conn.enterIp': 'Please enter an IP address.',
    'conn.connected': 'Connected to {ip}.',
    'conn.connectErr': 'Connect failed: {msg}',
    'conn.disconnected': 'Disconnected.',
    'conn.hint': 'The computer running makera-pcb holds the machine link — desktop and phone share it.',
    'conn.thisUrl': 'This remote: {url}',
    'net.lost': 'No connection to the makera-pcb server. Check Wi-Fi — retrying automatically.',
    'status.title': 'Status',
    'status.wpos': 'Workpiece (WPos · G54)',
    'status.mpos': 'Machine (MPos)',
    'status.feed': 'Feed',
    'status.spindle': 'Spindle',
    'status.tool': 'Tool',
    'status.upload': 'Upload…',
    'jog.title': 'Jog',
    'jog.step': 'Step',
    'act.title': 'Actions',
    'act.home': 'Home (reference, top right)',
    'act.unlock': 'Unlock ($X)',
    'act.gotoOrigin': '→ Work origin',
    'act.setXYZ': 'Set origin here (XYZ)',
    'act.setXY': 'Set origin here (XY)',
    'job.title': 'Job',
    'job.progress': 'Progress',
    'job.pause': '⏸ Pause',
    'job.resume': '▶ Resume',
    'job.stop': '■ Stop',
    'acc.title': 'Accessories',
    'acc.light': 'Light',
    'acc.vac': 'Vacuum (external)',
    'acc.fan': 'Spindle fan',
    'acc.beep': 'Beep',
    'acc.on': 'On',
    'acc.off': 'Off',
    'acc.vacOn': 'ON',
    'acc.vacOff': 'off',
    'foot.desktop': 'Open desktop view',
    'confirm.yes': 'Yes',
    'confirm.no': 'Cancel',
    'confirm.stop': 'Really stop job/motion (reset)?',
    'confirm.homeRun': 'A job is running! Home anyway? The machine will travel to the top right.',
    'confirm.setXYZ': 'Set the current position as work origin (X/Y/Z, G54)?',
    'confirm.setXY': 'Set the current position as work origin (X/Y, G54)? Z stays unchanged.',
    'confirm.gotoOrigin': 'Move to the work origin? Z raises first, then X/Y rapid to your zero.',
    'msg.sent': 'Command sent.',
    'msg.originSet': 'Work origin set.',
    'msg.notConnected': 'Not connected to the machine.',
    'msg.homeFirst': 'Machine is in Alarm/Home state — home or unlock first.',
    'alarm.state': 'Machine in state {state}',
    'alarm.reset': 'Reset',
    'alarm.unlock': 'Unlock ($X)',
    'alarm.limit': 'Limit switch/travel limit reached. Check position, correct the origin if needed.',
    'alarm.probe': 'Probing failed. Probe (T0) inserted, connected and charged?',
    'alarm.resetToContinue': 'Machine in alarm. Acknowledge with “Reset”, then “Unlock ($X)”.',
    'alarm.tool': 'Tool/collet problem. Insert the tool correctly; calibrate from the desktop if needed.',
    'alarm.range': 'Value/area outside the work range. Check origin and dimensions.',
    'alarm.generic': 'Acknowledge with “Reset” + “Unlock ($X)”. Details in the desktop Machine tab.',
    'tc.title': 'Machine waiting: change the tool',
    'tc.tool': 'Insert tool:',
    'tc.body': 'The machine has moved to the change position, beeped and is waiting. Insert the tool all the way, then confirm – the machine then measures the tool length automatically and continues.',
    'tc.already': 'Already inserted? → just confirm.',
    'tc.confirm': 'Tool inserted – continue ▶',
    'tc.orButton': '… or press the button on the machine.',
    'tc.resuming': 'Resume sent – the machine measures the tool length …',
    'tc.cancel': 'Abort job',
    'tc.cancelConfirm': 'Really abort the job? The file is stopped and the wait state ends.',
    'tc.cancelled': 'Job aborted.',
  },
};

let LANG = (() => {
  try {
    const saved = localStorage.getItem('makera_mobile_lang');
    if (saved === 'de' || saved === 'en') return saved;
  } catch {}
  return (navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'en';
})();

function t(key, vars) {
  let s = (I18N[LANG] && I18N[LANG][key]) || I18N.en[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

function applyLang() {
  document.documentElement.lang = LANG;
  $$('[data-i]').forEach((el) => { el.textContent = t(el.dataset.i); });
  $('#langBtn').textContent = LANG === 'de' ? 'EN' : 'DE';
  try { localStorage.setItem('makera_mobile_lang', LANG); } catch {}
}

// ------------------------------------------------------------- helpers ------
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

// Promise-based confirm dialog (the native confirm() is easy to mis-tap and
// looks broken inside some mobile browsers' standalone mode).
let modalResolve = null;
function confirmModal(msg) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $('#modalMsg').textContent = msg;
    $('#modal').classList.remove('hidden');
  });
}
function closeModal(answer) {
  $('#modal').classList.add('hidden');
  if (modalResolve) { modalResolve(answer); modalResolve = null; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// --------------------------------------------------------------- state ------
const state = {
  serverOk: true,     // reached the makera-pcb server on the last poll
  connected: false,   // server <-> machine TCP link is up
  machineState: null, // Idle / Run / Alarm / Home / ...
  lastAlarmAt: 0,
};

function setControlsEnabled(on) {
  $$('[data-need-conn]').forEach((b) => { b.disabled = !on; });
  $('#disconnectBtn').disabled = !on;
}

function setPill(cls, text) {
  const p = $('#connPill');
  p.className = 'pill ' + cls;
  p.textContent = text;
}

// ------------------------------------------------------------- polling ------
async function poll() {
  let d;
  try {
    const res = await fetch('/api/machine/status');
    d = await res.json();
    if (!state.serverOk) { state.serverOk = true; $('#netBanner').classList.add('hidden'); }
  } catch {
    // server unreachable (Wi-Fi drop, server stopped) — show banner, lock UI
    state.serverOk = false;
    state.connected = false;
    $('#netBanner').textContent = t('net.lost');
    $('#netBanner').classList.remove('hidden');
    setPill('off', t('conn.off'));
    setControlsEnabled(false);
    renderStatus(null);
    return;
  }

  state.connected = !!d.connected;
  setControlsEnabled(state.connected);

  if (!state.connected) {
    setPill('off', t('conn.off'));
    state.machineState = null;
    renderStatus(null);
    renderAlarm(null, null);
    renderProgress(null);
    renderToolOverlay(null);
    renderVacuumState(null);
    return;
  }

  const s = d.status || {};
  const st = s.state || '—';
  state.machineState = st;
  if (d.ip && !$('#ipInput').value) $('#ipInput').value = d.ip;

  const pillCls = (st === 'Alarm' || st === 'Halt') ? 'alarm' : st === 'Run' ? 'run' : 'on';
  setPill(pillCls, d.xmitting ? t('status.upload') : (s.state ? st : t('conn.on')));

  renderStatus(s);
  renderProgress(s);
  renderAlarm(st, d.lastAlarm);
  renderToolOverlay(s);
  renderVacuumState(d.vacuumOn);
}

// External vacuum port (M851/M852): the server tracks the last commanded
// state (shared with the desktop UI) and mirrors it here as a small badge.
function renderVacuumState(on) {
  const el = $('#vacState');
  if (!el) return;
  el.className = 'vac-state' + (on === true ? ' on' : '');
  el.textContent = on == null ? '—' : on === true ? t('acc.vacOn') : t('acc.vacOff');
}

// ---------------------------------------------- M6 tool-change overlay ------
// The Carvera Air M6 (manual tool change) drives to the change position,
// beeps and waits in the firmware "Tool" state until confirmed. Resume =
// M490.2 (exits the tool wait; same as the official controller's popup /
// the machine's physical button). The overlay closes by itself as soon as
// the machine leaves the Tool state — however it was confirmed.
let tcSig = null;
let tcResuming = false;

function renderToolOverlay(s) {
  const el = $('#toolOverlay');
  if (!el) return;
  const waiting = s && s.state === 'Tool';
  if (!waiting) {
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); el.innerHTML = ''; }
    tcSig = null;
    tcResuming = false;
    return;
  }
  // manual-tool-change status carries the TARGET tool as T[2]
  const target = (s.tool && s.tool.length > 2 && Number.isFinite(s.tool[2])) ? s.tool[2] : null;
  const sig = LANG + '|' + target + '|' + (tcResuming ? 1 : 0);
  if (sig === tcSig && !el.classList.contains('hidden')) return; // keep buttons alive
  tcSig = sig;
  const toolTxt = target != null ? 'T' + target : '—';
  el.classList.remove('hidden');
  el.innerHTML = `<div class="tc-box" role="dialog" aria-modal="true">
      <div class="tc-title">⚙ ${esc(t('tc.title'))}</div>
      <div class="tc-tool">${esc(t('tc.tool'))} <b>${esc(toolTxt)}</b></div>
      <p class="tc-body">${esc(t('tc.body'))}</p>
      <p class="tc-body muted">${esc(t('tc.already'))}</p>
      ${tcResuming
        ? `<div class="tc-resuming">${esc(t('tc.resuming'))}</div>`
        : `<button id="tcConfirm" class="btn primary tc-confirm">${esc(t('tc.confirm'))}</button>`}
      <p class="tc-body muted">${esc(t('tc.orButton'))}</p>
      <button id="tcCancel" class="btn ghost danger tc-cancel" ${tcResuming ? 'disabled' : ''}>${esc(t('tc.cancel'))}</button>
    </div>`;
  const confirmBtn = $('#tcConfirm');
  if (confirmBtn) confirmBtn.addEventListener('click', async () => {
    tcResuming = true;
    tcSig = null;
    await sendCommand('M490.2'); // exit the firmware tool-change wait
    renderToolOverlay(s);
  });
  const cancelBtn = $('#tcCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    if (!(await confirmModal(t('tc.cancelConfirm')))) return;
    await sendCommand('abort'); // stop the file playback first …
    await sendCommand('M490.2'); // … then leave the tool wait
    toast(t('tc.cancelled'));
  });
}

function renderStatus(s) {
  const fmt1 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
  const w = s && s.wpos;
  $('#wposX').textContent = fmt1(w && w[0]);
  $('#wposY').textContent = fmt1(w && w[1]);
  $('#wposZ').textContent = fmt1(w && w[2]);
  const m = s && s.mpos;
  $('#mposLine').textContent = m
    ? `X ${fmt1(m[0])} · Y ${fmt1(m[1])} · Z ${fmt1(m[2])}` : '—';
  $('#statFeed').textContent = s && s.feed ? s.feed[0].toFixed(0) : '—';
  $('#statSpin').textContent = s && s.spindle ? s.spindle[0].toFixed(0) : '—';
  $('#statTool').textContent = s && s.tool ? `T${s.tool[0]}` : '—';

  const big = $('#bigState');
  const st = s && s.state;
  big.textContent = st || '—';
  big.className = 'big-state ' + (
    !st ? 'off'
      : (st === 'Alarm' || st === 'Halt') ? 'alarm'
        : st === 'Run' ? 'run'
          : st === 'Idle' ? 'idle' : ''
  );
}

// Live job progress from the status "P" (play: lines, percent, seconds) field.
function renderProgress(s) {
  const card = $('#progCard');
  const play = s && s.play;
  const running = s && s.state === 'Run';
  if (play && play.length >= 2 && (running || play[1] > 0)) {
    const pct = Math.max(0, Math.min(100, play[1]));
    card.classList.remove('hidden');
    $('#progFill').style.width = pct.toFixed(1) + '%';
    $('#progPct').textContent = pct.toFixed(1) + ' %';
    const secs = play[2] != null ? Math.round(play[2]) : null;
    $('#progTime').textContent = secs != null ? `${Math.floor(secs / 60)}m ${secs % 60}s` : '—';
  } else if (!running) {
    card.classList.add('hidden');
  }
}

// Plain-language hint for a raw alarm/error line (same heuristics as desktop).
function explainAlarm(text) {
  const s = (text || '').toLowerCase();
  if (/hard ?limit|soft ?limit|limit/.test(s)) return t('alarm.limit');
  if (/probe fail|probe/.test(s)) return t('alarm.probe');
  if (/reset to continue/.test(s)) return t('alarm.resetToContinue');
  if (/tool|atc|collet/.test(s)) return t('alarm.tool');
  if (/too small|out of|range/.test(s)) return t('alarm.range');
  return t('alarm.generic');
}

function renderAlarm(st, lastAlarm) {
  const el = $('#alarmBanner');
  const inAlarm = st === 'Alarm' || st === 'Halt';
  const recent = lastAlarm && (Date.now() - lastAlarm.at < 20000);
  if (!inAlarm && !recent) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const msg = (lastAlarm && lastAlarm.text) || (inAlarm ? t('alarm.state', { state: st }) : '');
  el.classList.remove('hidden');
  el.innerHTML = `<b>⚠ ${esc(inAlarm ? st + ' – ' : '')}${esc(msg)}</b>`
    + `<span class="hint">${esc(explainAlarm(msg))}</span>`
    + `<span class="acts"><button id="alarmReset" class="btn">${esc(t('alarm.reset'))}</button>`
    + `<button id="alarmUnlock" class="btn ghost">${esc(t('alarm.unlock'))}</button></span>`;
  $('#alarmReset').addEventListener('click', () => sendRealtime('reset'));
  $('#alarmUnlock').addEventListener('click', () => sendCommand('$X'));
}

// ------------------------------------------------------------ commands ------
async function sendCommand(line, okMsg) {
  if (!state.connected) return toast(t('msg.notConnected'), true);
  try {
    await api('/api/machine/command', { line });
    if (okMsg) toast(okMsg);
  } catch (err) { toast(err.message, true); }
}
async function sendRealtime(code) {
  if (!state.connected) return toast(t('msg.notConnected'), true);
  try { await api('/api/machine/realtime', { code }); } catch (err) { toast(err.message, true); }
}

// In Alarm/Home the work coordinate system is invalid — block absolute moves
// and origin sets (mirrors the desktop guard).
function needReady() {
  if (state.machineState === 'Alarm' || state.machineState === 'Home') {
    toast(t('msg.homeFirst'), true);
    return false;
  }
  return true;
}

// ----------------------------------------------------------------- jog ------
const JOG_FEED = 800;      // mm/min, same default as the desktop jog pad
const JOG_COOLDOWN = 300;  // ms between taps per button — no accidental doubles
let jogStep = 1;

function bindJog() {
  $$('[data-jog]').forEach((b) => {
    let lastTap = 0;
    b.addEventListener('click', async () => {
      const now = Date.now();
      if (now - lastTap < JOG_COOLDOWN) return;
      lastTap = now;
      if (!state.connected) return toast(t('msg.notConnected'), true);
      const dist = (Number(b.dataset.sign) < 0 ? '-' : '') + jogStep;
      try { await api('/api/machine/jog', { axis: b.dataset.jog, dist, feed: JOG_FEED }); }
      catch (err) { toast(err.message, true); }
    });
  });
  $$('#stepSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      jogStep = Number(b.dataset.step);
      $$('#stepSeg button').forEach((x) => x.classList.toggle('active', x === b));
      $('#stepLabel').innerHTML = `${jogStep}<small>mm</small>`;
    });
  });
}

// ------------------------------------------------------------ actions -------
function bindActions() {
  $('#homeBtn').addEventListener('click', async () => {
    if (!state.connected) return toast(t('msg.notConnected'), true);
    if (state.machineState === 'Run' && !(await confirmModal(t('confirm.homeRun')))) return;
    sendCommand('$H', t('msg.sent'));
  });
  $('#unlockBtn').addEventListener('click', () => sendCommand('$X', t('msg.sent')));
  $('#gotoOriginBtn').addEventListener('click', async () => {
    if (!state.connected) return toast(t('msg.notConnected'), true);
    if (!needReady()) return;
    if (!(await confirmModal(t('confirm.gotoOrigin')))) return;
    // Raise Z in machine coords first (no corner dart), then rapid to work X0/Y0.
    await sendCommand('G53 G0 Z-3');
    await sendCommand('G90 G0 X0 Y0', t('msg.sent'));
  });
  $('#setXYZBtn').addEventListener('click', async () => {
    if (!state.connected) return toast(t('msg.notConnected'), true);
    if (!needReady()) return;
    if (!(await confirmModal(t('confirm.setXYZ')))) return;
    sendCommand('G10 L20 P0 X0 Y0 Z0', t('msg.originSet'));
  });
  $('#setXYBtn').addEventListener('click', async () => {
    if (!state.connected) return toast(t('msg.notConnected'), true);
    if (!needReady()) return;
    if (!(await confirmModal(t('confirm.setXY')))) return;
    sendCommand('G10 L20 P0 X0 Y0', t('msg.originSet'));
  });
  $('#pauseBtn').addEventListener('click', () => sendRealtime('pause'));
  $('#resumeBtn').addEventListener('click', () => sendRealtime('resume'));
  $('#stopBtn').addEventListener('click', async () => {
    if (!state.connected) return toast(t('msg.notConnected'), true);
    if (!(await confirmModal(t('confirm.stop')))) return;
    sendRealtime('reset');
  });
  // accessories: plain commands straight from the button
  $$('[data-cmd]').forEach((b) => {
    b.addEventListener('click', () => sendCommand(b.dataset.cmd, t('msg.sent')));
  });
}

// ---------------------------------------------------------- connection ------
async function discover() {
  const box = $('#foundList');
  box.innerHTML = `<span class="note">${esc(t('conn.searching'))}</span>`;
  try {
    const { machines } = await api('/api/machine/discover', { timeout: 2800 });
    if (!machines.length) { box.innerHTML = `<span class="note">${esc(t('conn.none'))}</span>`; return; }
    box.innerHTML = '';
    machines.forEach((m) => {
      const btn = document.createElement('button');
      btn.className = 'machine';
      btn.innerHTML = `<span><b>${esc(m.name)}</b> <span class="meta">${esc(m.ip)}:${m.port}</span></span>`
        + `<span class="meta ${m.busy ? 'busy' : 'free'}">${esc(t(m.busy ? 'conn.busy' : 'conn.free'))}</span>`;
      btn.addEventListener('click', () => {
        $('#ipInput').value = m.ip;
        $('#portInput').value = m.port;
        connect();
      });
      box.appendChild(btn);
    });
  } catch (err) {
    box.innerHTML = `<span class="note">${esc(err.message)}</span>`;
  }
}

async function connect() {
  const ip = $('#ipInput').value.trim();
  const port = Number($('#portInput').value) || 2222;
  if (!ip) return toast(t('conn.enterIp'), true);
  const btn = $('#connectBtn');
  btn.disabled = true;
  try {
    await api('/api/machine/connect', { ip, port });
    try { localStorage.setItem('makera_mobile_lastconn', JSON.stringify({ ip, port })); } catch {}
    toast(t('conn.connected', { ip }));
    poll();
  } catch (err) {
    toast(t('conn.connectErr', { msg: err.message }), true);
  } finally {
    btn.disabled = false;
  }
}

async function disconnect() {
  try { await api('/api/machine/disconnect', {}); } catch {}
  toast(t('conn.disconnected'));
  poll();
}

// Show this page's LAN URL (useful when opened on the desktop to copy over).
let lanUrl = null;
function renderLanUrl() {
  if (!lanUrl) return;
  const el = $('#lanHint');
  el.textContent = t('conn.thisUrl', { url: lanUrl });
  el.classList.remove('hidden');
}
async function showLanUrl() {
  try {
    const d = await api('/api/lan');
    if (d.urls && d.urls.length) { lanUrl = d.urls[0] + '/mobile'; renderLanUrl(); }
  } catch { /* optional */ }
}

// ----------------------------------------------------------------- init -----
function init() {
  applyLang();
  $('#langBtn').addEventListener('click', () => {
    LANG = LANG === 'de' ? 'en' : 'de';
    applyLang();
    renderLanUrl();
    poll();
  });
  $('#modalNo').addEventListener('click', () => closeModal(false));
  $('#modalYes').addEventListener('click', () => closeModal(true));
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(false); });

  $('#discoverBtn').addEventListener('click', discover);
  $('#connectBtn').addEventListener('click', connect);
  $('#disconnectBtn').addEventListener('click', disconnect);

  try {
    const lc = JSON.parse(localStorage.getItem('makera_mobile_lastconn') || 'null');
    if (lc && lc.ip) { $('#ipInput').value = lc.ip; $('#portInput').value = lc.port || 2222; }
  } catch {}

  bindJog();
  bindActions();
  setControlsEnabled(false);
  showLanUrl();
  poll();
  setInterval(poll, 1000);
}

init();
