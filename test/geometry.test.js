import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  circleRing,
  union,
  offsetClosed,
  difference,
  outerContourCount,
  ringArea,
  boundingBox,
} from '../src/geometry/clipper.js';

test('circleRing approximates area of a disc', () => {
  const r = 3;
  const a = Math.abs(ringArea(circleRing(0, 0, r)));
  const exact = Math.PI * r * r;
  assert.ok(Math.abs(a - exact) / exact < 0.01, `area ${a} vs ${exact}`);
});

test('union of overlapping squares merges into one island', () => {
  const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const b = [[5, 5], [15, 5], [15, 15], [5, 15]];
  const u = union([a, b]);
  assert.equal(outerContourCount(u), 1);
});

test('union of separate squares keeps two islands', () => {
  const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const b = [[20, 0], [30, 0], [30, 10], [20, 10]];
  const u = union([a, b]);
  assert.equal(outerContourCount(u), 2);
});

test('offsetClosed grows area with positive delta regardless of winding', () => {
  const cw = [[0, 0], [0, 10], [10, 10], [10, 0]]; // clockwise
  const ccw = [[0, 0], [10, 0], [10, 10], [0, 10]]; // counter-clockwise
  for (const sq of [cw, ccw]) {
    const grown = offsetClosed([sq], 1);
    const area = Math.abs(ringArea(grown[0]));
    assert.ok(area > 100, `expected grown area > 100, got ${area}`);
  }
});

test('two islands merge at half the gap', () => {
  const a = [[0, 0], [0, 10], [10, 10], [10, 0]];
  const gap = 0.8;
  const b = [[10 + gap, 0], [10 + gap, 10], [20 + gap, 10], [20 + gap, 0]];
  const u = union([a, b]);
  assert.equal(outerContourCount(offsetClosed(u, gap / 2 - 0.05)), 2);
  assert.equal(outerContourCount(offsetClosed(u, gap / 2 + 0.05)), 1);
});

test('difference punches a hole', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole = circleRing(5, 5, 2);
  const res = difference([outer], [hole]);
  const totalArea = res.reduce((s, r) => s + Math.abs(ringArea(r)), 0);
  // outer 100 minus disc (~12.57) leaves the outer ring plus a hole ring;
  // net filled area is outer - hole.
  const outerArea = Math.abs(ringArea(res.find((r) => Math.abs(ringArea(r)) > 50)));
  const holeArea = totalArea - outerArea;
  assert.ok(Math.abs(holeArea - Math.PI * 4) / (Math.PI * 4) < 0.02);
});

test('boundingBox spans all rings', () => {
  const bb = boundingBox([
    [[0, 0], [1, 0], [1, 1]],
    [[5, 5], [6, 6]],
  ]);
  assert.deepEqual(bb, { minX: 0, minY: 0, maxX: 6, maxY: 6 });
});
