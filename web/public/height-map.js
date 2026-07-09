// Auto-leveling height-map: parse + plausibility assessment. Pure module in
// the style of machine-commands.js (no DOM/network) so it is unit-testable
// (test/height-map.test.js) and shared between the app and the tests.
//
// DATA SOURCE (official firmware 1.0.6, src/modules/tools/zprobe/
// CartGridStrategy.cpp): a G32 grid probe (what M495 auto-leveling queues,
// ATCHandler.cpp fill_autolevel_scripts) prints to the console — and thus
// into the machine log the app already mirrors:
//
//   Probe start ht: 2.000 mm, start MCS x,y: -273.310,-190.640, rectangular
//     bed width,height in mm: 138.500,30.000, grid size: 9x5   (doProbe:659)
//   probe at 0,0 is 0.000 mm                                    (doProbe:666)
//   DEBUG: X-273.310, Y-190.640, Z0.000        (one per grid point, :698)
//   ...
//   -0.001 -0.171 ... -1.366                    (print_bed_level rows, :811)
//   Max deviation from zero: 1.366                              (doProbe:706)
//
// Every grid value is RELATIVE to the reference probe at the grid origin
// (measured_z - z_reference, doProbe:697), i.e. 0.000 = same height as the
// work-origin corner. M375.1 re-prints the same rows on demand.

// --- warning thresholds (mm) -------------------------------------------------
// A 1.5 mm FR4 blank clamped flat on a waste board stays well below ~0.2 mm
// total deviation. 0.4 mm is ~2.7x the standard isolation depth (0.15 mm):
// beyond that the cut becomes unreliable even WITH compensation, and the
// fixturing is almost certainly wrong (chip under the board, loose clamp,
// wedged waste board) — so warn, loudly, before any job runs.
export const LEVELING_MAX_DEV_WARN_MM = 0.4;
// A mostly-linear slope of the fitted plane across the scanned area: the board
// (or waste board / bed) is tilted as a whole rather than locally warped.
export const LEVELING_TILT_WARN_MM = 0.3;
// A single cell deviating this far from the fitted plane is more likely a
// measurement artefact (chip/swarf on the copper, probe mis-trigger) than
// real board topology.
export const LEVELING_OUTLIER_WARN_MM = 0.15;

const HEADER_RE = /Probe start ht:\s*([-\d.]+)\s*mm,\s*start MCS x,y:\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*rectangular bed width,height in mm:\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*grid size:\s*(\d+)\s*x\s*(\d+)/i;
const POINT_RE = /DEBUG:\s*X([-\d.]+),\s*Y([-\d.]+),\s*Z([-\d.]+)/i;
const MAX_DEV_RE = /Max deviation from zero:\s*([-\d.]+)/i;

// Parse the LAST complete G32 leveling run out of the machine log lines.
// Returns null when no leveling block is present. The result:
//   { cols, rows, xSize, ySize, points: [{col,row,x,y,z}], grid: Float row-
//     major array (row 0 = front), maxDeviation, complete }
// x/y in points are LOCAL mm from the grid origin (the work-origin corner).
export function parseLevelingFromLog(lines) {
  const arr = Array.isArray(lines) ? lines.map(String) : String(lines || '').split('\n');
  let headerIdx = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (HEADER_RE.test(arr[i])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return null;
  const h = HEADER_RE.exec(arr[headerIdx]);
  const xStart = parseFloat(h[2]);
  const yStart = parseFloat(h[3]);
  const xSize = parseFloat(h[4]);
  const ySize = parseFloat(h[5]);
  const cols = parseInt(h[6], 10);
  const rows = parseInt(h[7], 10);
  if (!(cols > 1) || !(rows > 1) || !(xSize > 0) || !(ySize > 0)) return null;

  const xStep = xSize / (cols - 1);
  const yStep = ySize / (rows - 1);
  const grid = new Array(cols * rows).fill(NaN);
  const points = [];
  let maxDeviation = null;
  for (let i = headerIdx + 1; i < arr.length; i++) {
    const line = arr[i];
    const hm = HEADER_RE.test(line);
    if (hm) break; // a newer run started (shouldn't happen — we took the last)
    const pm = POINT_RE.exec(line);
    if (pm) {
      const x = parseFloat(pm[1]) - xStart;
      const y = parseFloat(pm[2]) - yStart;
      const z = parseFloat(pm[3]);
      const col = Math.round(x / xStep);
      const row = Math.round(y / yStep);
      if (col >= 0 && col < cols && row >= 0 && row < rows) {
        grid[row * cols + col] = z;
        points.push({ col, row, x, y, z });
      }
      continue;
    }
    const mm = MAX_DEV_RE.exec(line);
    if (mm) { maxDeviation = parseFloat(mm[1]); break; }
  }
  if (!points.length) return null;
  const complete = points.length === cols * rows;
  if (maxDeviation == null) {
    maxDeviation = points.reduce((m, p) => Math.max(m, Math.abs(p.z)), 0);
  }
  return { cols, rows, xSize, ySize, grid, points, maxDeviation, complete };
}

// Parse a bare grid dump (M375.1 / print_bed_level non-human format): rows of
// space-separated floats. Sizes are unknown there, so the caller may pass the
// board extent; defaults keep indices as coordinates.
export function parseGridDump(lines, { xSize = null, ySize = null } = {}) {
  const arr = Array.isArray(lines) ? lines.map(String) : String(lines || '').split('\n');
  const rowsData = [];
  for (const line of arr) {
    const trimmed = line.trim();
    if (!/^(-?\d+\.\d+\s*)+$/.test(trimmed)) {
      if (rowsData.length) break; // grid rows are contiguous — stop at the first non-row
      continue;
    }
    rowsData.push(trimmed.split(/\s+/).map(parseFloat));
  }
  if (rowsData.length < 2 || rowsData[0].length < 2) return null;
  const cols = rowsData[0].length;
  if (!rowsData.every((r) => r.length === cols)) return null;
  const rows = rowsData.length;
  const sx = xSize ?? cols - 1;
  const sy = ySize ?? rows - 1;
  const grid = [];
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z = rowsData[r][c];
      grid.push(z);
      points.push({ col: c, row: r, x: (sx / (cols - 1)) * c, y: (sy / (rows - 1)) * r, z });
    }
  }
  const maxDeviation = points.reduce((m, p) => Math.max(m, Math.abs(p.z)), 0);
  return { cols, rows, xSize: sx, ySize: sy, grid, points, maxDeviation, complete: true };
}

// Least-squares plane fit z = a*x + b*y + c over the map points.
export function fitPlane(map) {
  const pts = map.points.filter((p) => Number.isFinite(p.z));
  const n = pts.length;
  if (n < 3) return { a: 0, b: 0, c: 0 };
  let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (const p of pts) {
    sx += p.x; sy += p.y; sz += p.z;
    sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sxz += p.x * p.z; syz += p.y * p.z;
  }
  // normal equations for [a b c]
  const A = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const B = [sxz, syz, sz];
  const sol = solve3(A, B);
  if (!sol) return { a: 0, b: 0, c: 0 };
  return { a: sol[0], b: sol[1], c: sol[2] };
}

function solve3(A, B) {
  const m = A.map((row, i) => [...row, B[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// Plausibility assessment with plain-language warning codes the UI translates:
//   total-dev — overall deviation beyond LEVELING_MAX_DEV_WARN_MM
//   tilt      — the fitted plane slopes more than LEVELING_TILT_WARN_MM
//   outlier   — single cells deviating from the plane (chip / probe error)
export function assessHeightMap(map, thresholds = {}) {
  const maxDev = thresholds.maxDev ?? LEVELING_MAX_DEV_WARN_MM;
  const tiltWarn = thresholds.tilt ?? LEVELING_TILT_WARN_MM;
  const outlierWarn = thresholds.outlier ?? LEVELING_OUTLIER_WARN_MM;
  const pts = map.points.filter((p) => Number.isFinite(p.z));
  const zs = pts.map((p) => p.z);
  const min = Math.min(...zs);
  const max = Math.max(...zs);
  const maxDeviation = Math.max(Math.abs(min), Math.abs(max));
  const plane = fitPlane(map);
  // tilt = spread of the fitted plane across the scanned rectangle
  const corners = [
    [0, 0], [map.xSize, 0], [0, map.ySize], [map.xSize, map.ySize],
  ].map(([x, y]) => plane.a * x + plane.b * y + plane.c);
  const tiltMm = Math.max(...corners) - Math.min(...corners);
  const outliers = pts
    .map((p) => ({ ...p, residual: p.z - (plane.a * p.x + plane.b * p.y + plane.c) }))
    .filter((p) => Math.abs(p.residual) > outlierWarn)
    .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));

  const warnings = [];
  if (maxDeviation > maxDev) {
    warnings.push({ code: 'total-dev', params: { dev: maxDeviation, max: maxDev } });
  }
  if (tiltMm > tiltWarn) {
    warnings.push({ code: 'tilt', params: { tilt: tiltMm, max: tiltWarn } });
  }
  if (outliers.length) {
    const worst = outliers[0];
    warnings.push({ code: 'outlier', params: { n: outliers.length, x: worst.x, y: worst.y, residual: worst.residual } });
  }
  return { maxDeviation, min, max, range: max - min, tiltMm, plane, outliers, warnings, ok: warnings.length === 0 };
}

// --- 2D heatmap fallback (no three.js required) ------------------------------
// Green (flat) -> yellow -> red (strong deviation), per-cell value labels when
// the cells are large enough, axes in mm. Used when the 3D bundle is missing.
export function heightColor(z, scaleMm) {
  const t = Math.max(0, Math.min(1, Math.abs(z) / (scaleMm || 1)));
  // green (120°) → yellow (60°) → red (0°)
  const hue = 120 - 120 * t;
  return `hsl(${hue.toFixed(0)}, 85%, ${45 + 10 * (1 - t)}%)`;
}

export function drawHeightMap2D(canvas, map, { warnMm = LEVELING_MAX_DEV_WARN_MM } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const cssW = canvas.clientWidth || 560;
  const cssH = canvas.clientHeight || 340;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const margin = { l: 44, r: 12, t: 14, b: 30 };
  const w = cssW - margin.l - margin.r;
  const h = cssH - margin.t - margin.b;
  const scaleMm = Math.max(warnMm, map.maxDeviation || 0.001);
  const cw = w / map.cols;
  const chh = h / map.rows;
  for (const p of map.points) {
    // row 0 = front (y=0) — draw with y up
    const px = margin.l + p.col * cw;
    const py = margin.t + (map.rows - 1 - p.row) * chh;
    ctx.fillStyle = heightColor(p.z, scaleMm);
    ctx.fillRect(px, py, Math.ceil(cw), Math.ceil(chh));
    if (cw > 34 && chh > 16) {
      ctx.fillStyle = '#0b0f16';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.z.toFixed(2), px + cw / 2, py + chh / 2 + 3);
    }
  }
  // board outline + axes (mm)
  ctx.strokeStyle = '#e8edf6';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(margin.l, margin.t, map.cols * cw, map.rows * chh);
  ctx.fillStyle = '#8b98a9';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('0', margin.l, cssH - 12);
  ctx.textAlign = 'right';
  ctx.fillText(`${map.xSize.toFixed(1)} mm (X)`, margin.l + map.cols * cw, cssH - 12);
  ctx.save();
  ctx.translate(14, margin.t + map.rows * chh);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'left';
  ctx.fillText(`0 … ${map.ySize.toFixed(1)} mm (Y)`, 0, 0);
  ctx.restore();
}
