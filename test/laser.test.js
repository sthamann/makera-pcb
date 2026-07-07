import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laserGcode } from '../src/cam/gcode.js';
import { defaultConfig, mergeConfig } from '../src/config.js';

test('laserGcode wraps engraving in M321/M322 with focus Z0 and S power', () => {
  const cfg = mergeConfig(defaultConfig, { laser: { enable: true, power: 0.6, feedXY: 600, passes: 1 } });
  const strokes = [
    [[10, -5], [20, -5], [20, -10]],
    [[0, 0], [5, 0]],
  ];
  const g = laserGcode(strokes, cfg, { x: 0, y: -10 });
  assert.match(g, /M321/);
  assert.match(g, /\nG0 Z0\n/);
  assert.match(g, /M322/);
  // engrave moves use G1 with the power S value; travel uses G0
  assert.match(g, /G1 X[\d.]+ Y[\d.]+ F600 S0\.6/);
  assert.ok(g.includes('G0 '));
  assert.ok(!/NaN/.test(g));
});

test('laserGcode honours multiple passes', () => {
  const cfg = mergeConfig(defaultConfig, { laser: { enable: true, power: 0.5, feedXY: 500, passes: 3 } });
  const g = laserGcode([[[0, 0], [1, 0]]], cfg, { x: 0, y: 0 });
  const passes = [...g.matchAll(/laser pass \d/g)].length;
  assert.equal(passes, 3);
});
