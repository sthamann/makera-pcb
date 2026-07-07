import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExcellon } from '../src/excellon/parser.js';

const SAMPLE = `M48
METRIC
T1C1.000
T2C1.300
%
G90
G05
T1
X0Y0
X5.0Y0
X10.0Y-2.5
T2
X20.0Y0
M30
`;

test('parses tools and hole counts, sorted by diameter', () => {
  const r = parseExcellon(SAMPLE);
  assert.equal(r.drills.length, 2);
  assert.equal(r.drills[0].diameter, 1);
  assert.equal(r.drills[0].holes.length, 3);
  assert.equal(r.drills[1].diameter, 1.3);
  assert.equal(r.drills[1].holes.length, 1);
});

test('coordinates are in millimetres', () => {
  const r = parseExcellon(SAMPLE);
  assert.deepEqual(r.drills[0].holes[1], { x: 5, y: 0 });
  assert.deepEqual(r.drills[0].holes[2], { x: 10, y: -2.5 });
});

test('integer coordinate format is decoded with implied decimals', () => {
  const g = `M48
METRIC
T1C0.800
%
G90
T1
X9000Y-16000
M30
`;
  const r = parseExcellon(g);
  // metric 3.3 implied decimals -> 9.0 / -16.0
  assert.deepEqual(r.drills[0].holes[0], { x: 9, y: -16 });
});
