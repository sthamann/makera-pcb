#!/usr/bin/env node
// CLI: turn a KiCad gerber folder (or explicit files) into Makera G-code.
//
//   makera-pcb <gerber-folder> [--out <dir>] [--config <cfg.json>]
//   makera-pcb --copper F_Cu.gbr --edge Edge_Cuts.gbr --drill board.drl --out out
//
// Config overrides may also be given inline, e.g.:
//   --set isolation.cutDepth=0.12 --set outline.tabs=6

import fs from 'node:fs';
import path from 'node:path';
import { loadFolder } from './io.js';
import { runPipeline } from './pipeline.js';

function parseArgs(argv) {
  const args = { _: [], set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') {
      const [k, v] = argv[++i].split('=');
      setDeep(args.set, k, coerce(v));
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

function setDeep(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = cur[keys[i]] || {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out || 'makera-out';

  let inputs;
  if (args.copper || args.edge || args.drill) {
    const read = (p) => (p ? fs.readFileSync(p, 'utf8') : null);
    inputs = { copper: read(args.copper), edge: read(args.edge), drill: read(args.drill), silk: read(args.silk) };
  } else if (args._[0]) {
    const loaded = loadFolder(args._[0]);
    inputs = { copper: loaded.copper, edge: loaded.edge, drill: loaded.drill, silk: loaded.silk };
    console.log('Detected files:');
    for (const [role, p] of Object.entries(loaded.paths)) console.log(`  ${role.padEnd(7)} ${p || '(none)'}`);
  } else {
    console.error('Usage: makera-pcb <gerber-folder> [--out dir] [--config cfg.json] [--set key=value]');
    process.exit(1);
  }

  let config = {};
  if (args.config) config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  config = deepMerge(config, args.set);

  const result = runPipeline({ ...inputs, config });

  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(result.files)) {
    fs.writeFileSync(path.join(outDir, name), content);
  }
  fs.writeFileSync(path.join(outDir, 'FERTIGUNGSPLAN.md'), result.report);

  console.log(`\nBoard: ${result.board.width.toFixed(2)} × ${result.board.height.toFixed(2)} mm`);
  console.log(`Isolation rings: ${result.stats.isolationRings}`);
  for (const g of result.stats.drillGroups) console.log(`Drill ${g.diameter.toFixed(2)} mm: ${g.holes} holes`);
  if (result.stats.minCopperGap != null)
    console.log(`Min copper gap ≈ ${result.stats.minCopperGap.toFixed(3)} mm`);

  console.log('\nChecks:');
  for (const m of result.checks.messages) {
    const tag = m.level === 'error' ? 'ERROR' : m.level === 'warn' ? 'WARN ' : 'OK   ';
    console.log(`  [${tag}] ${m.text}`);
  }

  console.log(`\nWrote ${Object.keys(result.files).length} G-code file(s) + FERTIGUNGSPLAN.md to ${outDir}/`);
}

function deepMerge(a, b) {
  const out = structuredClone(a || {});
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k] || {}, v);
    else out[k] = v;
  }
  return out;
}

main();
