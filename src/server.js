// Web server: static UI + JSON API around the pipeline.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { makeZip } from './zip.js';
import { discover, CarveraConnection, DEFAULT_PORT } from './machine.js';
import { reviewConfig } from './ai.js';

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

// Load the bundled example board if it is available next to the project.
app.get('/api/example', (req, res) => {
  const dir = path.join(__dirname, '..', '..', 'platine', 'gerbers');
  try {
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
  });
});

app.post('/api/machine/command', (req, res) => {
  try {
    if (!conn?.connected) return res.status(400).json({ error: 'not connected' });
    const line = String(req.body?.line || '').trim();
    if (!line) return res.status(400).json({ error: 'empty command' });
    conn.send(line);
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

app.listen(PORT, () => {
  console.log(`makera-pcb UI running at http://localhost:${PORT}`);
});
