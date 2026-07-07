import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAperture } from '../src/gerber/apertures.js';
import { ApertureMacro } from '../src/gerber/apertureMacro.js';
import { ringArea, boundingBox } from '../src/geometry/clipper.js';

const noMacros = new Map();

test('circle aperture area matches diameter', () => {
  const ap = makeAperture({ code: 10, template: 'C', params: [2] }, noMacros);
  const area = Math.abs(ringArea(ap.flash(0, 0)[0]));
  assert.ok(Math.abs(area - Math.PI) / Math.PI < 0.01);
  assert.equal(ap.diameter, 2);
});

test('rectangle aperture area equals w*h', () => {
  const ap = makeAperture({ code: 11, template: 'R', params: [2, 3] }, noMacros);
  const area = Math.abs(ringArea(ap.flash(0, 0)[0]));
  assert.equal(Math.round(area), 6);
});

test('obround aperture is a capsule with correct bbox', () => {
  const ap = makeAperture({ code: 12, template: 'O', params: [4, 2] }, noMacros);
  const bb = boundingBox(ap.flash(0, 0));
  assert.ok(Math.abs(bb.maxX - bb.minX - 4) < 0.05);
  assert.ok(Math.abs(bb.maxY - bb.minY - 2) < 0.05);
});

test('flash translates the prototype', () => {
  const ap = makeAperture({ code: 10, template: 'C', params: [2] }, noMacros);
  const bb = boundingBox(ap.flash(10, 20));
  assert.ok(Math.abs((bb.minX + bb.maxX) / 2 - 10) < 1e-6);
  assert.ok(Math.abs((bb.minY + bb.maxY) / 2 - 20) < 1e-6);
});

test('KiCad RoundRect macro renders a rounded rectangle', () => {
  const macro = new ApertureMacro('RoundRect', [
    '0 comment',
    '4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0',
    '1,1,$1+$1,$2,$3',
    '1,1,$1+$1,$4,$5',
    '1,1,$1+$1,$6,$7',
    '1,1,$1+$1,$8,$9',
    '20,1,$1+$1,$2,$3,$4,$5,0',
    '20,1,$1+$1,$4,$5,$6,$7,0',
    '20,1,$1+$1,$6,$7,$8,$9,0',
    '20,1,$1+$1,$8,$9,$2,$3,0',
  ]);
  // args as in %ADD10RoundRect,0.25X-1.05X1.05X-1.05X-1.05X1.05X-1.05X1.05X1.05X0
  const args = [0, 0.25, -1.05, 1.05, -1.05, -1.05, 1.05, -1.05, 1.05, 1.05, 0];
  const rings = macro.render(args);
  const bb = boundingBox(rings);
  // half-size = corner (1.05) + rounding radius (0.25) = 1.3 -> full 2.6
  assert.ok(Math.abs(bb.maxX - bb.minX - 2.6) < 0.05, `width ${bb.maxX - bb.minX}`);
  assert.ok(Math.abs(bb.maxY - bb.minY - 2.6) < 0.05);
});
