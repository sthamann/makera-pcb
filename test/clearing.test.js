import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateClearing } from '../src/cam/clearing.js';
import { union, offsetClosed } from '../src/geometry/clipper.js';
import { defaultConfig, mergeConfig, isolationToolWidth } from '../src/config.js';
import { runPipeline } from '../src/pipeline.js';

// Ray-casting point-in-ring (even-odd). Rings are [[x,y], ...] (implicitly closed).
function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// A polygon set (rings, holes as opposite winding) fills a point when an odd
// number of its rings contain it.
function pointInPolys(pt, polys) {
  let count = 0;
  for (const ring of polys) if (ring.length >= 3 && pointInRing(pt, ring)) count++;
  return count % 2 === 1;
}

test('generateClearing fills the background and never enters the trace halo', () => {
  const copper = [
    [[10, 10], [14, 10], [14, 14], [10, 14]],
    [[26, 26], [30, 26], [30, 30], [26, 30]],
  ];
  const boardBounds = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
  const cfg = mergeConfig(defaultConfig, { clearing: { enable: true } });
  const isoWidth = isolationToolWidth(cfg.isolation);

  const clearing = generateClearing(copper, boardBounds, cfg, isoWidth);

  assert.ok(Array.isArray(clearing.paths), 'paths is an array');
  assert.ok(clearing.paths.length > 0, 'produced at least one clearing ring');
  assert.equal(clearing.toolDiameter, cfg.clearing.toolDiameter);
  assert.equal(clearing.cutDepth, cfg.clearing.cutDepth);
  assert.ok(clearing.stepover > 0, 'positive stepover');

  // Reconstruct the no-go halo around the traces and assert no toolpath point
  // lies inside it (clearing must never nick a conductor).
  const keepGap = isoWidth / 2 + cfg.clearing.toolDiameter / 2 + cfg.clearing.gap;
  const keep = offsetClosed(union(copper), keepGap);
  for (const ring of clearing.paths) {
    assert.ok(ring.length >= 3, 'each clearing ring is a closed polygon');
    for (const pt of ring) {
      assert.ok(!pointInPolys(pt, keep), `clearing point ${pt} is inside the trace halo`);
    }
  }
});

test('generateClearing returns no paths when the board is fully covered by copper', () => {
  // One big square that, after the keep halo, leaves no clearable region inside
  // the margin-inset board rectangle.
  const copper = [[[0, 0], [40, 0], [40, 40], [0, 40]]];
  const boardBounds = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
  const cfg = mergeConfig(defaultConfig, { clearing: { enable: true } });
  const clearing = generateClearing(copper, boardBounds, cfg, isolationToolWidth(cfg.isolation));
  assert.deepEqual(clearing.paths, []);
});

// --- pipeline-level wiring on the bundled example board --------------------

const gerberDir = fileURLToPath(new URL('../gerbers/', import.meta.url));
const files = {
  copper: gerberDir + 'i2c_bus_board-F_Cu.gbr',
  edge: gerberDir + 'i2c_bus_board-Edge_Cuts.gbr',
  drill: gerberDir + 'i2c_bus_board.drl',
};
const haveGerbers = fs.existsSync(files.copper);

test('pipeline wires clearing into files/operations/preview/combined', { skip: !haveGerbers }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const tools = [
    { number: 1, type: 'vbit', diameter: 0.1, label: 'V-Bit 30°' },
    { number: 2, type: 'drill', diameter: 1.0 },
    { number: 3, type: 'drill', diameter: 1.3 },
    { number: 4, type: 'endmill', diameter: 1.0 },
    { number: 5, type: 'endmill', diameter: 1.0, label: 'Corn bit' },
  ];
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    config: {
      clearing: { enable: true },
      tools,
      toolAssignment: { isolation: 1, clearing: 5, 'drill:1.00': 2, 'drill:1.30': 3, outline: 4 },
    },
  });

  // File produced with the expected name.
  assert.equal(result.fileNames.clearing, '1b_clearing.nc');
  const cf = result.files['1b_clearing.nc'];
  assert.ok(cf, 'clearing file produced');
  assert.ok(cf.startsWith('; makera-pcb'), 'clearing header');
  assert.match(cf, /\nG21\n/, 'clearing sets mm');
  assert.match(cf, /M3 S12000\b/, 'clearing spindle rpm');
  assert.match(cf, /\nM5\n/, 'clearing spindle off');
  assert.ok(!/NaN|Infinity/.test(cf), 'clearing has no NaN/Infinity');

  // Operation exposed for tool assignment, right after isolation.
  const ids = result.operations.map((o) => o.id);
  assert.ok(ids.includes('clearing'), 'clearing operation present');
  assert.equal(ids.indexOf('clearing'), 1, 'clearing operation sits right after isolation');

  // Preview layer present and non-empty.
  assert.ok(Array.isArray(result.preview.clearing), 'preview.clearing is an array');
  assert.ok(result.preview.clearing.length > 0, 'preview.clearing has rings');

  // Time estimate recorded under byOp.clearing.
  assert.ok(result.times.byOp.clearing > 0, 'clearing time estimated');

  // Combined M6 job includes the clearing tool change in order iso -> clearing -> drills -> outline.
  const combined = result.files['0_full_job.nc'];
  assert.ok(combined, 'combined program produced');
  const order = [...combined.matchAll(/M6 T(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [1, 5, 2, 3, 4]);
});

test('pipeline omits clearing when disabled (default)', { skip: !haveGerbers }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({ copper: read(files.copper), edge: read(files.edge), drill: read(files.drill) });
  assert.equal(result.fileNames.clearing, undefined);
  assert.ok(!result.files['1b_clearing.nc']);
  assert.deepEqual(result.preview.clearing, []);
  assert.ok(!result.operations.some((o) => o.id === 'clearing'));
});
