import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVELING_MAX_DEV_WARN_MM,
  LEVELING_TILT_WARN_MM,
  LEVELING_OUTLIER_WARN_MM,
  parseLevelingFromLog,
  parseGridDump,
  fitPlane,
  assessHeightMap,
} from '../web/public/height-map.js';

// ---------------------------------------------------------------------------
// Fixture: the REAL leveling run from the user's machine log (Carvera Air,
// firmware 1.0.6) — a 9x5 grid over the 138.5 x 30 mm board, values falling
// monotonically from 0.000 at the work origin to -1.366 at X=138.5
// ("Max deviation from zero: 1.366"). Line formats are byte-identical to
// CartGridStrategy.cpp: doProbe (":659 header, :698 DEBUG points, :706 max
// deviation") and print_bed_level (":818 rows of %1.4f).
// ---------------------------------------------------------------------------
const COLS = 9;
const ROWS = 5;
const X_SIZE = 138.5;
const Y_SIZE = 30.0;
const X_START = -273.31;
const Y_START = -190.64;
const zAt = (col) => -(1.366 * col) / (COLS - 1);

function realLevelingLog({ withMaxDev = true } = {}) {
  const lines = [
    'Auto leveling, grid: 9 * 5 height: 2.00',
    'Rectangular Grid Probe...',
    'Leveling start, offset by XY',
    `Probe start ht: 2.000 mm, start MCS x,y: ${X_START.toFixed(3)},${Y_START.toFixed(3)}, rectangular bed width,height in mm: ${X_SIZE.toFixed(3)},${Y_SIZE.toFixed(3)}, grid size: ${COLS}x${ROWS}`,
    'probe at 0,0 is 0.000 mm',
  ];
  // firmware probes serpentine (x zig-zag per row) — order must not matter
  for (let row = 0; row < ROWS; row++) {
    const cols = [...Array(COLS).keys()];
    if (row % 2) cols.reverse();
    for (const col of cols) {
      const x = X_START + (X_SIZE / (COLS - 1)) * col;
      const y = Y_START + (Y_SIZE / (ROWS - 1)) * row;
      lines.push(`DEBUG: X${x.toFixed(3)}, Y${y.toFixed(3)}, Z${zAt(col).toFixed(3)}`);
    }
  }
  for (let row = 0; row < ROWS; row++) {
    lines.push([...Array(COLS).keys()].map((c) => `${zAt(c).toFixed(4)} `).join(''));
  }
  if (withMaxDev) {
    lines.push('Max deviation from zero: 1.366');
    lines.push('Max deviation between highest and lowest: 1.366');
  }
  lines.push('goto x and y clearance first', 'G53 G0 Z-3.000', 'G53 G90 G0 Y-21.000', 'G53 G90 G0 X-5.000', 'Done ATC');
  return lines;
}

test('parseLevelingFromLog reads the real 9x5 run (size, points, max deviation)', () => {
  const map = parseLevelingFromLog(realLevelingLog());
  assert.ok(map, 'map parsed');
  assert.equal(map.cols, COLS);
  assert.equal(map.rows, ROWS);
  assert.equal(map.xSize, X_SIZE);
  assert.equal(map.ySize, Y_SIZE);
  assert.equal(map.points.length, COLS * ROWS);
  assert.equal(map.complete, true);
  assert.equal(map.maxDeviation, 1.366);
  // grid is row-major, origin cell 0, right edge -1.366 in every row
  assert.equal(map.grid[0], 0);
  assert.equal(map.grid[COLS - 1], -1.366);
  assert.equal(map.grid[4 * COLS + (COLS - 1)], -1.366);
  // local coordinates start at the work origin
  const origin = map.points.find((p) => p.col === 0 && p.row === 0);
  assert.ok(Math.abs(origin.x) < 1e-9 && Math.abs(origin.y) < 1e-9);
});

test('parseLevelingFromLog picks the LAST run and survives a missing max-deviation line', () => {
  const old = realLevelingLog().map((l) => l.replace('1.366', '9.999').replace(/Z-([\d.]+)/g, 'Z-0.010'));
  const log = [...old, ...realLevelingLog({ withMaxDev: false })];
  const map = parseLevelingFromLog(log);
  assert.equal(map.maxDeviation, 1.366); // derived from the points
  assert.equal(map.grid[COLS - 1], -1.366);
});

test('parseLevelingFromLog returns null without a leveling block', () => {
  assert.equal(parseLevelingFromLog(['<Idle|MPos:0,0,0|WPos:0,0,0>', 'ok']), null);
  assert.equal(parseLevelingFromLog([]), null);
});

test('parseGridDump reads bare M375.1 rows', () => {
  const map = parseGridDump([
    'some noise',
    '0.0000 -0.1000 -0.2000 ',
    '0.0100 -0.0900 -0.1900 ',
    'Max deviation from zero: 0.2',
  ], { xSize: 20, ySize: 10 });
  assert.equal(map.cols, 3);
  assert.equal(map.rows, 2);
  assert.equal(map.xSize, 20);
  assert.equal(map.maxDeviation, 0.2);
});

test('assessHeightMap flags the real tilted map: total deviation AND monotonic tilt', () => {
  const map = parseLevelingFromLog(realLevelingLog());
  const a = assessHeightMap(map);
  assert.equal(a.ok, false);
  assert.ok(Math.abs(a.maxDeviation - 1.366) < 1e-9);
  const codes = a.warnings.map((w) => w.code);
  assert.ok(codes.includes('total-dev'), 'total deviation over ' + LEVELING_MAX_DEV_WARN_MM);
  assert.ok(codes.includes('tilt'), 'monotonic slope over ' + LEVELING_TILT_WARN_MM);
  assert.ok(!codes.includes('outlier'), 'a clean linear slope has no outliers');
  assert.ok(Math.abs(a.tiltMm - 1.366) < 0.01, 'tilt equals the linear fall');
});

test('assessHeightMap accepts a flat clamped board (deviation well below thresholds)', () => {
  const lines = realLevelingLog().map((l) =>
    l.replace(/Z-([\d.]+)/g, (m, v) => `Z-${(parseFloat(v) * 0.02).toFixed(3)}`)
      .replace(/^(-?\d+\.\d+ )+$/g, '')
      .replace('Max deviation from zero: 1.366', 'Max deviation from zero: 0.027'));
  const map = parseLevelingFromLog(lines);
  const a = assessHeightMap(map);
  assert.equal(a.ok, true);
  assert.deepEqual(a.warnings, []);
});

test('assessHeightMap detects a single outlier cell (chip / probe error)', () => {
  // flat map with one spike well above the outlier threshold
  const lines = [
    'Probe start ht: 2.000 mm, start MCS x,y: 0.000,0.000, rectangular bed width,height in mm: 80.000,40.000, grid size: 5x5',
  ];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const z = row === 2 && col === 2 ? 0.3 : 0.0;
      lines.push(`DEBUG: X${(col * 20).toFixed(3)}, Y${(row * 10).toFixed(3)}, Z${z.toFixed(3)}`);
    }
  }
  lines.push('Max deviation from zero: 0.300');
  const map = parseLevelingFromLog(lines);
  const a = assessHeightMap(map);
  const outlier = a.warnings.find((w) => w.code === 'outlier');
  assert.ok(outlier, 'outlier detected');
  assert.equal(outlier.params.n, 1);
  assert.equal(outlier.params.x, 40);
  assert.equal(outlier.params.y, 20);
  assert.ok(Math.abs(outlier.params.residual) > LEVELING_OUTLIER_WARN_MM);
  // 0.3 mm total stays below the total-dev threshold → no total-dev warning
  assert.ok(!a.warnings.some((w) => w.code === 'total-dev'));
});

test('fitPlane recovers a known plane', () => {
  const points = [];
  for (let x = 0; x <= 40; x += 10) {
    for (let y = 0; y <= 20; y += 10) {
      points.push({ x, y, z: 0.01 * x - 0.02 * y + 0.5 });
    }
  }
  const p = fitPlane({ points });
  assert.ok(Math.abs(p.a - 0.01) < 1e-9);
  assert.ok(Math.abs(p.b - -0.02) < 1e-9);
  assert.ok(Math.abs(p.c - 0.5) < 1e-9);
});
