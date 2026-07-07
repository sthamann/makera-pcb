import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGerber, toFilledPolygons } from '../src/gerber/parser.js';
import { ringArea, outerContourCount } from '../src/geometry/clipper.js';

const SAMPLE = `%FSLAX46Y46*%
%MOMM*%
%ADD10C,1.000000*%
%ADD11C,0.500000*%
D10*
X0Y0D03*
X5000000Y0D03*
D11*
X0Y0D02*
X5000000Y0D01*
M02*
`;

test('parses format, apertures, flashes and strokes', () => {
  const p = parseGerber(SAMPLE);
  assert.equal(p.format.xDec, 6);
  assert.equal(p.flashes.length, 2);
  assert.equal(p.strokes.length, 1);
});

test('aperture parameter is not corrupted by the trailing asterisk', () => {
  const p = parseGerber(SAMPLE);
  // C,1.000000 -> diameter exactly 1 (regression for the trailing-* bug)
  assert.equal(p.flashes[0].aperture.diameter, 1);
});

test('flash Y coordinates advance (regression for stuck modal Y)', () => {
  const g = `%FSLAX46Y46*%
%MOMM*%
%ADD10C,1.000000*%
D10*
X0Y0D03*
X0Y-5000000D03*
X0Y-10000000D03*
M02*
`;
  const p = parseGerber(g);
  const ys = p.flashes.map((f) => f.y);
  assert.deepEqual(ys, [0, -5, -10]);
});

test('connected copper forms a single filled island', () => {
  const p = parseGerber(SAMPLE);
  const polys = toFilledPolygons(p);
  assert.equal(outerContourCount(polys), 1);
  const area = polys.reduce((s, r) => s + Math.abs(ringArea(r)), 0);
  assert.ok(area > 2.5, `expected trace+pads area > 2.5, got ${area}`);
});

test('clear polarity subtracts copper', () => {
  const g = `%FSLAX46Y46*%
%MOMM*%
%ADD10R,10.000000X10.000000*%
%ADD11C,4.000000*%
%LPD*%
D10*
X0Y0D03*
%LPC*%
D11*
X0Y0D03*
M02*
`;
  const p = parseGerber(g);
  const polys = toFilledPolygons(p);
  // difference returns an outer ring plus a hole ring; net filled area is
  // outer - hole.
  const areas = polys.map((r) => Math.abs(ringArea(r)));
  const outer = Math.max(...areas);
  const hole = areas.reduce((a, b) => a + b, 0) - outer;
  const net = outer - hole;
  // 10x10 minus a disc of r=2 -> ~100 - 12.57
  assert.ok(Math.abs(net - (100 - Math.PI * 4)) < 1, `net ${net}`);
});
