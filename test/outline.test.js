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
