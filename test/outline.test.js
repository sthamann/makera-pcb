import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stitchPaths, generateOutline } from '../src/cam/outline.js';
import { defaultConfig } from '../src/config.js';

test('stitchPaths joins four edge segments into one closed loop', () => {
  const segs = [
    [[0, 0], [10, 0]],
    [[10, 0], [10, 5]],
    [[10, 5], [0, 5]],
    [[0, 5], [0, 0]],
  ];
  const { closed, open } = stitchPaths(segs);
  assert.equal(closed.length, 1);
  assert.equal(open.length, 0);
});

test('generateOutline offsets outward and places tabs', () => {
  const strokes = [
    { points: [[0, 0], [10, 0]] },
    { points: [[10, 0], [10, 5]] },
    { points: [[10, 5], [0, 5]] },
    { points: [[0, 5], [0, 0]] },
  ];
  const cfg = structuredClone(defaultConfig);
  cfg.outline.tabs = 4;
  const res = generateOutline(strokes, cfg);
  assert.equal(res.loops.length, 1);
  const loop = res.loops[0];
  assert.ok(loop.closed);
  const tabPts = loop.pts.filter((p) => p.tab).length;
  assert.ok(tabPts > 0, 'expected some points flagged as tabs');
  // Outward offset makes the loop larger than the 10x5 board.
  const xs = loop.pts.map((p) => p.x);
  assert.ok(Math.max(...xs) > 10);
  assert.ok(Math.min(...xs) < 0);
});

test('inner cutouts offset inward and are cut before the outer profile', () => {
  const outer = [
    { points: [[0, 0], [20, 0]] },
    { points: [[20, 0], [20, 20]] },
    { points: [[20, 20], [0, 20]] },
    { points: [[0, 20], [0, 0]] },
  ];
  const inner = [
    { points: [[8, 8], [12, 8]] },
    { points: [[12, 8], [12, 12]] },
    { points: [[12, 12], [8, 12]] },
    { points: [[8, 12], [8, 8]] },
  ];
  const cfg = structuredClone(defaultConfig);
  cfg.outline.cutterDiameter = 1.0;
  cfg.outline.tabs = 0;
  const res = generateOutline([...outer, ...inner], cfg);
  assert.equal(res.loops.length, 2);
  // Smaller inner loop first, larger outer loop last.
  assert.ok(res.loops[0].area < res.loops[1].area);
  const innerXs = res.loops[0].pts.map((p) => p.x);
  const outerXs = res.loops[1].pts.map((p) => p.x);
  // Inner hole shrinks (offset inward): max X stays inside the 12 mm edge line.
  assert.ok(Math.max(...innerXs) < 12.5);
  // Outer profile still grows beyond the 20 mm board edge.
  assert.ok(Math.max(...outerXs) > 20);
});
