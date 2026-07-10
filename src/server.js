// Web server: static UI + JSON API around the pipeline.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { makeZip } from './zip.js';
import { discover, CarveraConnection, DEFAULT_PORT } from './machine.js';
import { reviewConfig, diagnoseLog } from './ai.js';
import { lanUrls } from './lan.js';
import qrcode from 'qrcode-terminal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'web', 'public');
const PORT = process.env.PORT || 4321;

// Auto-load .env (project root) so the OpenAI key is available without any UI.
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile(envPath);
    else loadEnvFallback(envPath);
  }
} catch (err) {
  console.warn('Could not load .env:', err.message);
}
function loadEnvFallback(p) {
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(PUBLIC));

// App metadata (version + repo) for the UI header.
let META = { version: '', repo: '' };
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const repo = (pkg.homepage) || (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
  META = { version: pkg.version || '', repo: String(repo).replace(/^git\+/, '').replace(/\.git$/, '') };
} catch {}
app.get('/api/meta', (req, res) => res.json(META));

// Mobile remote control (touch UI for the phone next to the machine).
app.get('/mobile', (req, res) => res.sendFile(path.join(PUBLIC, 'mobile.html')));

// LAN base URLs of this host — lets the UI display the mobile URL.
app.get('/api/lan', (req, res) => res.json({ urls: lanUrls(PORT), port: Number(PORT) }));

// Load the bundled example board if it is available next to the project.
app.get('/api/example', (req, res) => {
  const candidates = [
    path.join(__dirname, '..', 'gerbers'),
    path.join(__dirname, '..', '..', 'platine', 'gerbers'),
  ];
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'i2c_bus_board-F_Cu.gbr')));
  try {
    if (!dir) throw new Error('example dir not found');
    const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
    res.json({
      copper: read('i2c_bus_board-F_Cu.gbr'),
      edge: read('i2c_bus_board-Edge_Cuts.gbr'),
      drill: read('i2c_bus_board.drl'),
      silk: read('i2c_bus_board-F_Silkscreen.gbr'),
      names: {
        copper: 'i2c_bus_board-F_Cu.gbr',
        edge: 'i2c_bus_board-Edge_Cuts.gbr',
        drill: 'i2c_bus_board.drl',
        silk: 'i2c_bus_board-F_Silkscreen.gbr',
      },
    });
  } catch (err) {
    res.status(404).json({ error: 'Example board not found next to the app.' });
  }
});

app.post('/api/generate', (req, res) => {
  try {
    const { copper, edge, drill, silk, config } = req.body || {};
    const result = runPipeline({ copper, edge, drill, silk, config });
    res.json({
      board: result.board,
      origin: result.origin,
      placement: result.placement,
      report: result.report,
      checks: result.checks,
      stats: result.stats,
      times: result.times,
      warnings: result.warnings,
      operations: result.operations,
      preview: result.preview,
      files: result.files,
      fileNames: result.fileNames,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/zip', (req, res) => {
  try {
    const { files } = req.body || {};
    if (!files || !Object.keys(files).length) {
      res.status(400).json({ error: 'No files to zip.' });
      return;
    }
    const buf = makeZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="makera-pcb.zip"');
    res.send(buf);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- Machine (Carvera Air) ----------------
let conn = null;

// Last commanded state of the external vacuum port (M851/M852). The firmware
// status report does not carry the switch state, so the server — which owns
// the single machine link desktop AND mobile share — remembers what was sent
// (via MDI, accessory toggles or the app-side job automation). G-code files
// switch the port too; the UIs surface that as "automatic" while a job runs.
let vacuumOn = null; // null = unknown (nothing sent yet)
const VACUUM_ON_RE = /^M851\b/i;
const VACUUM_OFF_RE = /^M852\b/i;
function trackVacuum(line) {
  if (VACUUM_ON_RE.test(line)) vacuumOn = true;
  else if (VACUUM_OFF_RE.test(line)) vacuumOn = false;
}

app.post('/api/machine/discover', async (req, res) => {
  try {
    const machines = await discover(Number(req.body?.timeout) || 2500);
    res.json({ machines });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/machine/connect', async (req, res) => {
  try {
    const { ip, port } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip required' });
    if (conn) { conn.disconnect(); conn = null; }
    conn = new CarveraConnection(ip, Number(port) || DEFAULT_PORT);
    await conn.connect();
    res.json({ ok: true, ip, port: conn.port, status: conn.status });
  } catch (err) {
    conn = null;
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/machine/disconnect', (req, res) => {
  if (conn) { conn.disconnect(); conn = null; }
  vacuumOn = null; // state unknown once the link is gone
  res.json({ ok: true });
});

app.get('/api/machine/status', (req, res) => {
  res.json({
    connected: !!conn?.connected,
    xmitting: !!conn?.xmitting,
    ip: conn?.ip || null,
    status: conn?.status || null,
    bytesReceived: conn?.bytesReceived || 0,
    connectedFor: conn?.connectedAt ? Date.now() - conn.connectedAt : 0,
    log: conn ? conn.log.slice(-40) : [],
    mode: conn?.mode || null,
    lastAlarm: conn?.lastAlarm || null,
    vacuumOn, // last commanded external-port state (see trackVacuum)
  });
});

// Full rolling machine log (up to 400 lines). The regular status endpoint
// only mirrors the last 40 lines; the auto-leveling output (G32: one DEBUG
// line per probe point + grid rows + max deviation) is longer than that, so
// the height-map parser reads the full window here.
app.get('/api/machine/log', (req, res) => {
  res.json({ connected: !!conn?.connected, log: conn ? conn.log.slice() : [] });
});

app.post('/api/machine/command', (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const line = String(req.body?.line || '').trim();
    if (!line) return res.status(400).json({ error: 'empty command' });
    conn.send(line);
    trackVacuum(line);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/machine/realtime', (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    conn.sendRealtime(String(req.body?.code || ''));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/machine/jog', (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const { axis, dist, feed } = req.body || {};
    if (!axis || dist == null) return res.status(400).json({ error: 'axis and dist required' });
    conn.send(`$J ${axis}${dist}${feed ? ` F${feed}` : ''}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/machine/run', async (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const { name, gcode, start } = req.body || {};
    if (!name || !gcode) return res.status(400).json({ error: 'name and gcode required' });
    const { path: rp, md5 } = await conn.upload(name, gcode);
    let started = false;
    if (start) { conn.send(`play ${rp}`); started = true; }
    res.json({ ok: true, path: rp, md5, started });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- SD file browser ----------------
// Browse, download, upload, create, rename and delete files on the machine's
// SD card. Download/list run over the SimpleShell console (cat/ls), upload
// reuses the framed file transfer. All of these are text-oriented (the PCB
// workflow only ever moves G-code / Gerber / drill / config text files).
app.get('/api/machine/files', async (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const path = String(req.query?.path || '/sd');
    const entries = await conn.list(path);
    res.json({ ok: true, path, entries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/machine/file', async (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const path = String(req.query?.path || '');
    if (!path) return res.status(400).json({ error: 'path required' });
    const buf = await conn.download(path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (req.query?.raw === '1') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"`);
      return res.send(buf);
    }
    res.json({ ok: true, path, name, size: buf.length, content: buf.toString('latin1') });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/machine/file/upload', async (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const { path, contentBase64, content } = req.body || {};
    if (!path) return res.status(400).json({ error: 'path required' });
    const buf = contentBase64 != null
      ? Buffer.from(String(contentBase64), 'base64')
      : Buffer.from(String(content ?? ''), 'utf8');
    const result = await conn.upload(path, buf);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/machine/file/mkdir', async (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const path = String(req.body?.path || '');
    if (!path) return res.status(400).json({ error: 'path required' });
    await conn.makeDir(path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/machine/file/rename', async (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    await conn.rename(String(from), String(to));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/machine/file/delete', async (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const path = String(req.body?.path || '');
    if (!path) return res.status(400).json({ error: 'path required' });
    await conn.remove(path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- AI config review (OpenAI) ----------------
app.get('/api/ai/config', (req, res) => {
  res.json({ hasKey: !!process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' });
});

app.post('/api/ai/review', async (req, res) => {
  try {
    const { apiKey, model, config, board, checks, operations, stats } = req.body || {};
    const key = apiKey || process.env.OPENAI_API_KEY;
    const mdl = model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const review = await reviewConfig({ apiKey: key, model: mdl, config, board, checks, operations, stats });
    res.json(review);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ai/diagnose', async (req, res) => {
  try {
    const { apiKey, model, log, config, board, stats } = req.body || {};
    const key = apiKey || process.env.OPENAI_API_KEY;
    const mdl = model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const result = await diagnoseLog({ apiKey: key, model: mdl, log, config, board, stats });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`makera-pcb UI running at http://localhost:${PORT}`);
  // Mobile remote control: print the LAN URL (and a scannable QR code) so the
  // phone next to the machine can open it directly.
  const mobileUrl = lanUrls(PORT).map((u) => `${u}/mobile`)[0];
  if (mobileUrl) {
    console.log(`Mobile remote control: ${mobileUrl}`);
    try { qrcode.generate(mobileUrl, { small: true }); } catch { /* QR is optional */ }
  }
});
