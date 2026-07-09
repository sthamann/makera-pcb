// Single source of truth for "does the board fit on the stock blank?".
//
// Used by BOTH the browser UI (material preview / warning, web/public/app.js)
// and the server-side feasibility check (src/cam/checks.js) so the two can
// never disagree again. Pure module — no DOM, no Node APIs (unit-tested in
// test/stock-fit.test.js).
//
// Real geometry of the Makera PCB workflow (verified against the official
// firmware, the community controller and a real machine run):
//
//   * anchor 1 is the reference corner the blank is pushed against. On a real
//     Carvera the blank's bottom-left corner lands directly ON anchor 1, so the
//     work origin must be set AT anchor 1 (CARVERA_ANCHOR_OFFSET = 0/0). The
//     L-bracket arms (coordinate.anchor_width/anchor_length) are only DRAWN as
//     a visual cue; they no longer offset the coordinate origin.
//   * An earlier version set the origin at anchor 1 + X15/Y10 (from a Makera
//     wiki note). On the real machine that shifted EVERY operation 15 mm/10 mm
//     onto the board: "Rand abfahren" started ~1.5 cm right / ~1.0 cm up of the
//     board corner and ran over the edge, even with the placement offset at 0.
//     Root cause: the board corner already sits at anchor 1, so the +15/10 was
//     added on top instead of "skipping bracket arms".
//   * The board therefore starts flush at the blank's bottom-left corner
//     (BOARD_INSET_ON_STOCK = 0/0); the placement offset (drag & drop) is the
//     only thing that moves it from there.
//
//   Cross-check against a real run: a 138.5 mm wide board fits the 150 mm wide
//   Makera blank (138.5 + 4 clamp margin = 142.5 ≤ 150) and scans its full
//   margin from the blank corner without leaving the blank.

// Work offset of the PCB work origin from anchor 1. VERIFIED ON A REAL MACHINE
// to be ZERO: the blank's bottom-left corner sits directly ON anchor 1, so the
// work origin must be set AT anchor 1 (no extra offset). An earlier X15/Y10
// value (from a Makera wiki note) shifted EVERY job 15 mm/10 mm onto the board
// — the tool started ~1.5 cm right / ~1.0 cm up of the board corner and ran
// over the edge (confirmed: with the origin at anchor 1 + X15/Y10, MPos of the
// job start was 15/10 past the measured board corner = anchor 1). Kept at 0/0.
export const CARVERA_ANCHOR_OFFSET = { x: 0, y: 0 };

// Visual only: dimensions of the L-bracket the blank rests against, used to
// draw the anchor in the material preview. NOT part of the coordinate model —
// the work origin sits at the blank corner (CARVERA_ANCHOR_OFFSET = 0/0).
export const BRACKET_ARM_MM = { x: 15, y: 10 };
export const BRACKET_ARM_LENGTH_MM = 100;

// Where the board's bottom-left corner lands ON the blank, relative to the work
// origin. The origin sits at the blank corner, so the board starts flush there.
export const BOARD_INSET_ON_STOCK = { x: 0, y: 0 };

// Minimum free stock beyond the board edge (right/top) for top clamps / handling.
export const STOCK_CLAMP_MARGIN_MM = 4;

// Drag & drop board placement snaps to this grid (UI + numeric fields).
export const PLACEMENT_SNAP_MM = 0.5;

// Space one oriented board needs on the blank. `offset` is the user's board
// placement offset (drag & drop) measured from the default position at the
// blank's corner — it shifts the board up/right, so it adds to the required
// size the same way the inset does.
function requiredSize(boardW, boardH, inset, margin, offset) {
  return {
    x: inset.x + offset.x + boardW + margin,
    y: inset.y + offset.y + boardH + margin,
  };
}

// Check whether a board of boardW × boardH mm fits a blank of sizeX × sizeY mm
// with the anchor-1 placement. Returns a detail object; `fits` is true when
// the board fits as-is OR with the blank rotated by 90° (X/Y swapped).
// `offset` = board placement offset on the blank (mm, from the default corner
// position); it moves the board away from the corner and shrinks the room.
export function boardFitsStock(boardW, boardH, sizeX, sizeY, {
  inset = BOARD_INSET_ON_STOCK,
  margin = STOCK_CLAMP_MARGIN_MM,
  offset = { x: 0, y: 0 },
} = {}) {
  const required = requiredSize(boardW, boardH, inset, margin, offset);
  const fitsAsIs = required.x <= sizeX && required.y <= sizeY;
  const fitsRotated = required.x <= sizeY && required.y <= sizeX;
  return {
    fits: fitsAsIs || fitsRotated,
    fitsAsIs,
    fitsRotated,
    requiredX: required.x,
    requiredY: required.y,
    inset,
    margin,
    offset,
  };
}

// Snap a placement value to the drag grid (0.5 mm), never below 0.
export function snapPlacement(v, snap = PLACEMENT_SNAP_MM) {
  const n = Number(v) || 0;
  return Math.max(0, Math.round(n / snap) * snap);
}

// Clamp a board placement offset so the board stays on the blank INCLUDING
// the clamp margin (right/top). Negative offsets would push the board over
// the L-bracket arms, so the lower bound is always 0. When the board doesn't
// fit the blank at all (max < 0) the offset collapses to 0.
export function clampPlacementOffset(boardW, boardH, sizeX, sizeY, offX, offY, {
  inset = BOARD_INSET_ON_STOCK,
  margin = STOCK_CLAMP_MARGIN_MM,
} = {}) {
  const maxX = sizeX - margin - boardW - inset.x;
  const maxY = sizeY - margin - boardH - inset.y;
  return {
    x: Math.min(Math.max(0, Number(offX) || 0), Math.max(0, maxX)),
    y: Math.min(Math.max(0, Number(offY) || 0), Math.max(0, maxY)),
  };
}

// Pick the smallest option (label + sizeX/sizeY) from `stockOptions` that the
// board fits on — used for the "use this blank instead" hint. Returns null
// when nothing fits.
export function smallestFittingStock(boardW, boardH, stockOptions, opts) {
  const fitting = (stockOptions || [])
    .filter((s) => s && s.sizeX > 0 && s.sizeY > 0)
    .filter((s) => boardFitsStock(boardW, boardH, s.sizeX, s.sizeY, opts).fits)
    .sort((a, b) => a.sizeX * a.sizeY - b.sizeX * b.sizeY);
  return fitting[0] || null;
}
