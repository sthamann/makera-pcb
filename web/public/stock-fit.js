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
//   * anchor 1 is the corner point where the L-bracket is bolted to the bed.
//     The bracket ARMS extend INTO the work area from that point (firmware
//     config: coordinate.anchor_width 15.0 / anchor_length 100.0,
//     MakeraInc/CarveraFirmware src/config2.default; drawn the same way by
//     carvera-community/carvera_controller main.py draw()).
//   * The blank rests flush AGAINST those arms — its bottom-left corner
//     therefore sits at anchor 1 + (arm width), NOT at the anchor point.
//   * The official Makera PCB workflow places the work origin at anchor 1 +
//     X15/Y10 (wiki.makera.com PCB tutorial). That offset exists to skip the
//     bracket arms: the work origin lands ON the blank's corner, so the board
//     effectively starts at the blank's bottom-left corner.
//
//   Cross-check against a real run: a 138.5 mm wide board on the 150 mm wide
//   Makera blank scanned its full margin (MPos X-280.31 … X-141.81) without
//   leaving the blank — impossible under the old "origin is 15 mm inside the
//   blank" model (15 + 138.5 + 4 = 157.5 > 150), consistent with this one
//   (0 + 138.5 + 4 = 142.5 ≤ 150).

// Makera work offset of the PCB work origin from anchor 1 (bracket corner).
export const CARVERA_ANCHOR_OFFSET = { x: 15, y: 10 };

// L-bracket arm widths the anchor offset skips: the vertical arm (along Y) is
// 15 mm wide in X, the horizontal arm (along X) ~10 mm in Y. The blank's
// corner sits at anchor 1 + these arms.
export const BRACKET_ARM_MM = { x: 15, y: 10 };

// Visual length of the bracket arms (firmware coordinate.anchor_length).
export const BRACKET_ARM_LENGTH_MM = 100;

// Where the board's bottom-left corner lands ON the blank: work origin minus
// blank corner. With the Makera offsets this is (0,0) — flush at the corner.
export const BOARD_INSET_ON_STOCK = {
  x: CARVERA_ANCHOR_OFFSET.x - BRACKET_ARM_MM.x,
  y: CARVERA_ANCHOR_OFFSET.y - BRACKET_ARM_MM.y,
};

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
