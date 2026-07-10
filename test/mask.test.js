import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMaskRemoval } from '../src/cam/mask.js';
import { defaultConfig, mergeConfig } from '../src/config.js';

const cfg = () => mergeConfig(defaultConfig, { solderMask: { enable: true } });

test('generateMaskRemoval clears a wide pad but never a thin trace', () => {
  const pad = [[0, 0], [2, 0], [2, 2], [0, 2]]; // 2 × 2 mm pad
  const trace = [[3, 0.9], [8, 0.9], [8, 1.1], [3, 1.1]]; // 0.2 mm-wide trace
  const res = generateMaskRemoval([pad, trace], [], cfg(), 0.3);
  assert.ok(res.paths.length > 0, 'the pad yields pocket-fill rings');
  // every toolpath point stays on the pad (x < 2.5) — the thin trace at x >= 3
  // vanishes under the opening and is never cleared.
  const xs = res.paths.flat().map((p) => p[0]);
  assert.ok(Math.max(...xs) < 2.5, 'no toolpath reaches the thin trace');
  assert.ok(res.cutDepth > 0 && res.cutDepth < 0.5, 'shallow mask cut depth');
});

test('generateMaskRemoval drops a large ground pour (area cutoff)', () => {
  const pour = [[0, 0], [20, 0], [20, 20], [0, 20]]; // 400 mm² pour > padMaxAreaMm2
  const res = generateMaskRemoval([pour], [], cfg(), 0.3);
  assert.equal(res.paths.length, 0, 'a big pour is not treated as a pad');
  assert.equal(res.plunges.length, 0);
});

test('generateMaskRemoval exposes copper at a drilled hole even without a wide pad', () => {
  const trace = [[-3, -0.1], [3, -0.1], [3, 0.1], [-3, 0.1]]; // thin, no wide pad
  const drills = [{ bitDiameter: 0.8, holes: [[0, 0]] }];
  const res = generateMaskRemoval([trace], drills, cfg(), 0.3);
  assert.ok(res.paths.length > 0 || res.plunges.length > 0, 'the drill pad is exposed');
});

test('generateMaskRemoval returns nothing without copper', () => {
  const res = generateMaskRemoval([], [], cfg(), 0.3);
  assert.equal(res.paths.length, 0);
  assert.equal(res.plunges.length, 0);
});
