import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isolationGcode,
  drillGcode,
  outlineGcode,
  combinedGcode,
  laserGcode,
  emitIsolationMotion,
  emitOutlineMotion,
  outlineTabFloor,
  outlineTotalDepth,
  PECK_DEPTH_EPSILON,
} from '../src/cam/gcode.js';
import { defaultConfig, VACUUM_ON_COMMAND, VACUUM_OFF_COMMAND } from '../src/config.js';
import { generateIsolation } from '../src/cam/isolation.js';
import { generateOutline } from '../src/cam/outline.js';
import { runPipeline } from '../src/pipeline.js';

class CaptureEmitter {
  constructor() { this.lines = []; }
  raw(s) { this.lines.push(s); return this; }
  comment(s) { this.lines.push(`; ${s}`); return this; }
  g0(x, y, z) {
    const parts = [];
    if (x != null) parts.push(`X${x}`);
    if (y != null) parts.push(`Y${y}`);
    if (z != null) parts.push(`Z${z}`);
    this.lines.push('G0 ' + parts.join(' '));
    return this;
  }
  g1(x, y, z, f) {
    const parts = [];
    if (x != null) parts.push(`X${x}`);
    if (y != null) parts.push(`Y${y}`);
    if (z != null) parts.push(`Z${z}`);
    if (f != null) parts.push(`F${f}`);
    this.lines.push('G1 ' + parts.join(' '));
    return this;
  }
}

test('individual isolation file starts with M6 before the first cut', () => {
  const cfg = structuredClone(defaultConfig);
  const iso = generateIsolation([[[0, 0], [10, 0], [10, 5], [0, 5]]], cfg.isolation);
  const gcode = isolationGcode(iso, cfg, { x: 0, y: 0 }, { number: 1, label: 'V-Bit', rpm: 12000 });
  const m6 = gcode.indexOf('M6 T1');
  const m3 = gcode.indexOf('M3 S12000');
  const firstCut = gcode.indexOf('G1');
  assert.ok(m6 >= 0, 'M6 present');
  assert.ok(m6 < m3, 'M6 before spindle on');
  assert.ok(m3 < firstCut, 'spindle on before first cut');
  assert.match(gcode, /\nM30\n$/);
  assert.doesNotMatch(gcode, /G94/);
});

test('first isolation traverse uses safeZ, later hops use travelZ', () => {
  const cfg = structuredClone(defaultConfig);
  cfg.safeZ = 12;
  cfg.travelZ = 2;
  const iso = {
    passes: [{
      index: 0,
      offset: 0.1,
      rings: [
        [[0, 0], [5, 0], [5, 5], [0, 5]],
        [[20, 20], [25, 20], [25, 25], [20, 25]],
      ],
    }],
  };
  const e = new CaptureEmitter();
  emitIsolationMotion(e, iso, cfg, { x: 0, y: 0 });
  const zMoves = e.lines.filter((l) => l.startsWith('G0') && l.includes('Z'));
  assert.equal(zMoves[0], 'G0 Z12', 'first approach at safeZ');
  assert.equal(zMoves[1], 'G0 Z2', 'retract to travelZ after first ring');
  assert.equal(zMoves[2], 'G0 Z2', 'second ring still hops at travelZ');
});

test('tab floor leaves configured tabHeight of material', () => {
  const cfg = structuredClone(defaultConfig);
  cfg.material.thickness = 1.5;
  cfg.outline.tabHeight = 0.4;
  cfg.outline.throughMargin = 0.2;
  assert.equal(outlineTabFloor(cfg), -1.1);
  assert.equal(outlineTotalDepth(cfg), 1.7);
  const remaining = cfg.material.thickness + outlineTabFloor(cfg);
  assert.ok(Math.abs(remaining - cfg.outline.tabHeight) < 1e-6);
});

test('outline g-code uses tab plateau at -(thickness - tabHeight)', () => {
  const cfg = structuredClone(defaultConfig);
  cfg.material.thickness = 1.5;
  cfg.outline.tabHeight = 0.4;
  cfg.outline.tabs = 2;
  cfg.outline.depthPerPass = 0.4;
  const strokes = [
    { points: [[0, 0], [10, 0]] },
    { points: [[10, 0], [10, 5]] },
    { points: [[10, 5], [0, 5]] },
    { points: [[0, 5], [0, 0]] },
  ];
  const outline = generateOutline(strokes, cfg);
  const e = new CaptureEmitter();
  emitOutlineMotion(e, outline, cfg, { x: 0, y: 0 });
  const tabFloor = outlineTabFloor(cfg);
  const tabZs = e.lines
    .filter((l) => l.startsWith('G1') && l.includes('Z'))
    .map((l) => Number(l.match(/Z(-?[\d.]+)/)[1]))
    .filter((z) => Math.abs(z - tabFloor) < 1e-6);
  assert.ok(tabZs.length > 0, `expected tab plateau at Z${tabFloor}`);
});

test('drill peck loop stops without redundant final peck', () => {
  const cfg = structuredClone(defaultConfig);
  cfg.material.thickness = 1.5;
  cfg.drill.throughMargin = 0.3;
  cfg.drill.peck = 0.6;
  const depth = cfg.material.thickness + cfg.drill.throughMargin;
  let z = 0;
  let pecks = 0;
  while (z > -depth + PECK_DEPTH_EPSILON) {
    z = Math.max(-depth, z - cfg.drill.peck);
    pecks++;
  }
  assert.equal(pecks, 3, `expected 3 pecks to -${depth}, got ${pecks}`);
});

// --- external vacuum automation (M851/M852, Carvera Air external port) ------

const VAC_ON_LINE = new RegExp(`\\n${VACUUM_ON_COMMAND}\\n`);
const VAC_OFF_LINE = new RegExp(`\\n${VACUUM_OFF_COMMAND}\\n`);

function tinyIso(cfg) {
  return generateIsolation([[[0, 0], [10, 0], [10, 5], [0, 5]]], cfg.isolation);
}

test('vacuum automation: port on after spindle start, off after program end with run-on', () => {
  const cfg = structuredClone(defaultConfig); // automation is ON by default
  const gcode = isolationGcode(tinyIso(cfg), cfg, { x: 0, y: 0 }, { number: 1, label: 'V-Bit', rpm: 12000 });
  const m3 = gcode.indexOf('M3 S12000');
  const on = gcode.search(VAC_ON_LINE);
  const firstCut = gcode.indexOf('G1');
  assert.ok(on > m3, 'M851 after the spindle start');
  assert.ok(on < firstCut, 'M851 before the first cut');
  // program end: M5 → park → dwell (default 10 s) → M852 → M30
  const m5 = gcode.lastIndexOf('\nM5\n');
  const dwell = gcode.indexOf('\nG4 P10\n');
  const off = gcode.search(VAC_OFF_LINE);
  const m30 = gcode.lastIndexOf('M30');
  assert.ok(dwell > m5, 'run-on dwell after the spindle stop');
  assert.ok(off > dwell, 'M852 after the run-on dwell');
  assert.ok(off < m30, 'M852 before M30');
});

test('vacuum automation off leaves the program untouched', () => {
  const cfg = structuredClone(defaultConfig);
  cfg.vacuum.enable = false;
  const gcode = isolationGcode(tinyIso(cfg), cfg, { x: 0, y: 0 }, { number: 1, label: '', rpm: 12000 });
  assert.doesNotMatch(gcode, VAC_ON_LINE);
  assert.doesNotMatch(gcode, VAC_OFF_LINE);
});

test('vacuum run-on uses the configured linger seconds', () => {
  const cfg = structuredClone(defaultConfig);
  cfg.vacuum.lingerSec = 3.5;
  const gcode = drillGcode(
    { bitDiameter: 1.0, holes: [[2, 2]], depth: 1.8 },
    cfg, { x: 0, y: 0 }, { number: 2, label: '', rpm: 10000 },
  );
  assert.match(gcode, /\nG4 P3\.5\n/, 'dwell carries the configured run-on');
  assert.match(gcode, VAC_OFF_LINE);
});

test('combined program pauses the vacuum around every M6 when configured', () => {
  const cfg = structuredClone(defaultConfig);
  cfg.vacuum.pauseToolChange = true;
  const iso = tinyIso(cfg);
  const steps = [
    { kind: 'isolation', title: 'Isolation', iso, tool: { number: 1, label: '', rpm: 12000 }, cfg },
    { kind: 'drill', title: 'Bohren', group: { bitDiameter: 1.0, holes: [[2, 2]], depth: 1.8 }, tool: { number: 2, label: '', rpm: 10000 }, cfg },
  ];
  const gcode = combinedGcode(steps, cfg, { x: 0, y: 0 });
  const lines = gcode.split('\n');
  // every M6 is preceded by an M852 (between the M5 and the tool change)
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('M6 ')) continue;
    const before = lines.slice(Math.max(0, i - 3), i);
    assert.ok(before.includes(VACUUM_OFF_COMMAND), `M852 before "${line}"`);
  }
  // and every spindle start switches it back on
  const onCount = lines.filter((l) => l === VACUUM_ON_COMMAND).length;
  assert.equal(onCount, steps.length, 'M851 after every spindle start');
});

test('laser program honours the vacuum laser switch', () => {
  const strokes = [[[0, 0], [5, 5]]];
  const cfg = structuredClone(defaultConfig);
  const withVac = laserGcode(strokes, cfg, { x: 0, y: 0 }); // vacuum.laser default: on
  const m321 = withVac.indexOf('M321');
  const on = withVac.search(VAC_ON_LINE);
  assert.ok(on > m321, 'M851 after entering laser mode');
  assert.match(withVac, VAC_OFF_LINE);
  cfg.vacuum.laser = false;
  const noVac = laserGcode(strokes, cfg, { x: 0, y: 0 });
  assert.doesNotMatch(noVac, VAC_ON_LINE);
  assert.doesNotMatch(noVac, VAC_OFF_LINE);
});

const gerberDir = fileURLToPath(new URL('../gerbers/', import.meta.url));
const haveGerbers = fs.existsSync(gerberDir + 'i2c_bus_board-F_Cu.gbr');

test('pipeline individual files contain M6 and safe first Z', { skip: !haveGerbers }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({
    copper: read(gerberDir + 'i2c_bus_board-F_Cu.gbr'),
    edge: read(gerberDir + 'i2c_bus_board-Edge_Cuts.gbr'),
    drill: read(gerberDir + 'i2c_bus_board.drl'),
  });
  const iso = result.files['1_isolation.nc'];
  assert.match(iso, /M6 T1/);
  assert.match(iso, /G0 Z12/);
  const outline = result.files[result.fileNames.outline];
  assert.match(outline, /M6 T5/);
  assert.match(outline, /Z-1\.1\b/, 'tab plateau at -1.1 mm');
});
