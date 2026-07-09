import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARVERA_ANCHOR_OFFSET,
  BRACKET_ARM_MM,
  BOARD_INSET_ON_STOCK,
  STOCK_CLAMP_MARGIN_MM,
  PLACEMENT_SNAP_MM,
  boardFitsStock,
  smallestFittingStock,
  snapPlacement,
  clampPlacementOffset,
} from '../web/public/stock-fit.js';

test('shared constants match the verified Makera anchor geometry', () => {
  // Verified on a real machine: the blank corner sits ON anchor 1, so the work
  // origin is set AT anchor 1 with NO offset (a former X15/Y10 shifted every
  // job 15/10 onto the board and over its edge).
  assert.deepEqual(CARVERA_ANCHOR_OFFSET, { x: 0, y: 0 });
  // BRACKET_ARM_MM is now VISUAL-only (drawing the anchor in the preview); it
  // is no longer part of the coordinate model.
  assert.deepEqual(BRACKET_ARM_MM, { x: 15, y: 10 });
  // Board starts flush at the blank corner (= work origin).
  assert.deepEqual(BOARD_INSET_ON_STOCK, { x: 0, y: 0 });
  assert.equal(STOCK_CLAMP_MARGIN_MM, 4);
});

test('the 138.5 × 30 example board FITS the 150 × 100 blank (real-machine verified)', () => {
  // Board starts at the blank corner: 138.5 + 4 (clamp margin) = 142.5 ≤ 150.
  // Verified on the real machine: scan margin + leveling ran across the full
  // 138.5 mm span (MPos X-280.31 … X-141.81) without leaving the blank.
  const fit = boardFitsStock(138.5, 30, 150, 100);
  assert.equal(fit.fits, true);
  assert.equal(fit.fitsAsIs, true);
  assert.ok(Math.abs(fit.requiredX - 142.5) < 1e-9, `requiredX ${fit.requiredX}`);
  assert.ok(Math.abs(fit.requiredY - 34) < 1e-9, `requiredY ${fit.requiredY}`);
});

test('a board wider than blank + margin does NOT fit', () => {
  // 147 + 4 = 151 > 150 in X and > 100 rotated in Y.
  const fit = boardFitsStock(147, 30, 150, 100);
  assert.equal(fit.fits, false);
  assert.equal(fit.fitsAsIs, false);
  assert.equal(fit.fitsRotated, false);
});

test('a rotated blank counts as fitting (X/Y swapped)', () => {
  // Needs 142.5 × 34 — a 100 × 160 blank only fits with X/Y swapped.
  const fit = boardFitsStock(138.5, 30, 100, 160);
  assert.equal(fit.fitsAsIs, false);
  assert.equal(fit.fitsRotated, true);
  assert.equal(fit.fits, true);
});

test('boundary: exactly the required size still fits', () => {
  const fit = boardFitsStock(138.5, 30, 142.5, 34);
  assert.equal(fit.fits, true);
});

test('placement offset counts into the required blank size', () => {
  // The 138.5 mm example board on the 150 mm blank leaves 150 − 138.5 − 4 =
  // 7.5 mm of play — exactly that offset still fits, 0.5 mm more does not.
  assert.equal(boardFitsStock(138.5, 30, 150, 100, { offset: { x: 7.5, y: 0 } }).fits, true);
  assert.equal(boardFitsStock(138.5, 30, 150, 100, { offset: { x: 8, y: 0 } }).fits, false);
  const fit = boardFitsStock(100, 50, 150, 100, { offset: { x: 10, y: 20 } });
  assert.equal(fit.requiredX, 114); // 100 + 10 offset + 4 margin
  assert.equal(fit.requiredY, 74); // 50 + 20 offset + 4 margin
  assert.equal(fit.fits, true);
});

test('clampPlacementOffset keeps board + clamp margin on the blank', () => {
  // max offset for the example board: X 150−4−138.5 = 7.5, Y 100−4−30 = 66
  assert.deepEqual(clampPlacementOffset(138.5, 30, 150, 100, 20, 100), { x: 7.5, y: 66 });
  // negative offsets would push the board over the L-bracket arms → 0
  assert.deepEqual(clampPlacementOffset(138.5, 30, 150, 100, -5, -2), { x: 0, y: 0 });
  // a board that does not fit at all collapses the offset to 0
  assert.deepEqual(clampPlacementOffset(160, 30, 150, 100, 5, 3), { x: 0, y: 3 });
  assert.deepEqual(clampPlacementOffset(160, 120, 150, 100, 5, 3), { x: 0, y: 0 });
});

test('snapPlacement snaps to the 0.5 mm drag grid, never below 0', () => {
  assert.equal(PLACEMENT_SNAP_MM, 0.5);
  assert.equal(snapPlacement(10.26), 10.5);
  assert.equal(snapPlacement(10.24), 10);
  assert.equal(snapPlacement(0.25), 0.5); // round half up
  assert.equal(snapPlacement(-3), 0);
  assert.equal(snapPlacement('not a number'), 0);
});

test('smallestFittingStock picks the smallest blank the board fits on', () => {
  const options = [
    { label: 'A 150×100', sizeX: 150, sizeY: 100 },
    { label: 'B 200×150', sizeX: 200, sizeY: 150 },
    { label: 'C 300×200', sizeX: 300, sizeY: 200 },
  ];
  assert.equal(smallestFittingStock(138.5, 30, options).label, 'A 150×100');
  assert.equal(smallestFittingStock(190, 30, options).label, 'B 200×150');
  assert.equal(smallestFittingStock(500, 400, options), null);
});
