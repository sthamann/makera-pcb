// Gerber (RS-274X) parser.
//
// Produces the raw geometric primitives found in the file:
//   - flashes  : aperture placed at a point (D03)
//   - strokes  : polylines drawn with a circular pen (D01/D02), keep centre line
//   - regions  : filled contours (G36/G37)
// each tagged with polarity (dark/clear).
//
// A helper (toFilledPolygons) turns those into a single copper polygon set,
// while the outline stage consumes the raw strokes/regions directly.

import { ApertureMacro } from './apertureMacro.js';
import { makeAperture } from './apertures.js';
import { union, difference, offsetOpen } from '../geometry/clipper.js';

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '%') {
      const end = text.indexOf('%', i + 1);
      if (end < 0) break;
      const body = text.slice(i + 1, end);
      tokens.push({ type: 'ext', body });
      i = end + 1;
    } else if (ch === '*') {
      i++;
    } else if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') {
      i++;
    } else {
      const end = text.indexOf('*', i);
      const stop = end < 0 ? n : end;
      const body = text.slice(i, stop).trim();
      if (body) tokens.push({ type: 'std', body });
      i = stop + 1;
    }
  }
  return tokens;
}

export function parseGerber(text) {
  const warnings = [];
  const macros = new Map();
  const apertures = new Map();

  const format = {
    unit: 'mm',
    xInt: 4,
    xDec: 6,
    yInt: 4,
    yDec: 6,
    absolute: true,
  };

  const flashes = [];
  const strokes = [];
  const regions = [];

  let currentAperture = null;
  let polarity = 'D'; // D=dark, C=clear
  let interp = 1; // 1 linear, 2 cw, 3 ccw
  let quadrant = 'multi'; // KiCad uses G75
  let x = 0;
  let y = 0;
  let inRegion = false;
  let regionContour = null;
  let openStroke = null;

  const tokens = tokenize(text);

  const scaleCoord = (raw, dec) => parseInt(raw, 10) / Math.pow(10, dec);

  function finalizeStroke() {
    if (openStroke && openStroke.points.length >= 2) {
      strokes.push(openStroke);
    }
    openStroke = null;
  }

  function unitScale() {
    return format.unit === 'in' ? 25.4 : 1;
  }

  // Parse a standard block that may contain G/D/X/Y/I/J/M codes.
  function handleStd(body) {
    if (body.startsWith('G04')) return; // comment
    const codes = [...body.matchAll(/([GDMXYIJ])([+-]?[0-9]*)/g)];
    let hasCoord = false;
    let nx = x;
    let ny = y;
    let i = null;
    let j = null;
    let op = null;
    let dsel = null;
    const gcodes = [];

    for (const [, letter, digits] of codes) {
      if (letter === 'G') {
        gcodes.push(Number(digits));
      } else if (letter === 'X') {
        nx = scaleCoord(digits, format.xDec) * unitScale();
        hasCoord = true;
      } else if (letter === 'Y') {
        ny = scaleCoord(digits, format.yDec) * unitScale();
        hasCoord = true;
      } else if (letter === 'I') {
        i = scaleCoord(digits, format.xDec) * unitScale();
      } else if (letter === 'J') {
        j = scaleCoord(digits, format.yDec) * unitScale();
      } else if (letter === 'D') {
        const d = Number(digits);
        if (d === 1 || d === 2 || d === 3) op = d;
        else dsel = d;
      } else if (letter === 'M') {
        // M02 end of file; nothing to do here.
      }
    }

    for (const g of gcodes) {
      if (g === 1) interp = 1;
      else if (g === 2) interp = 2;
      else if (g === 3) interp = 3;
      else if (g === 74) quadrant = 'single';
      else if (g === 75) quadrant = 'multi';
      else if (g === 36) {
        finalizeStroke();
        inRegion = true;
        regionContour = null;
      } else if (g === 37) {
        if (regionContour && regionContour.length >= 3) {
          regions.push({ ring: regionContour, polarity });
        }
        regionContour = null;
        inRegion = false;
      }
    }

    if (dsel !== null) {
      finalizeStroke();
      currentAperture = apertures.get(dsel) || null;
      if (!currentAperture) warnings.push(`Referenced undefined aperture D${dsel}`);
    }

    if (op === null) {
      if (hasCoord) {
        x = nx;
        y = ny;
      }
      return;
    }

    if (inRegion) {
      handleRegionOp(op, nx, ny, i, j);
      x = nx;
      y = ny;
      return;
    }

    if (op === 2) {
      // move
      finalizeStroke();
      x = nx;
      y = ny;
      openStroke = null;
    } else if (op === 1) {
      // draw
      if (!currentAperture) {
        warnings.push('Draw (D01) without selected aperture');
      }
      if (!openStroke) {
        openStroke = {
          width: currentAperture ? currentAperture.diameter : 0,
          polarity,
          points: [[x, y]],
        };
      }
      if (interp === 1) {
        openStroke.points.push([nx, ny]);
      } else {
        for (const p of arcSegments(x, y, nx, ny, i ?? 0, j ?? 0, interp === 2)) {
          openStroke.points.push(p);
        }
      }
      x = nx;
      y = ny;
    } else if (op === 3) {
      // flash
      finalizeStroke();
      if (currentAperture) {
        flashes.push({ aperture: currentAperture, x: nx, y: ny, polarity });
      } else {
        warnings.push('Flash (D03) without selected aperture');
      }
      x = nx;
      y = ny;
    }
  }

  function handleRegionOp(op, nx, ny, i, j) {
    if (op === 2) {
      if (regionContour && regionContour.length >= 3) {
        regions.push({ ring: regionContour, polarity });
      }
      regionContour = [[nx, ny]];
    } else if (op === 1) {
      if (!regionContour) regionContour = [[x, y]];
      if (interp === 1) {
        regionContour.push([nx, ny]);
      } else {
        for (const p of arcSegments(x, y, nx, ny, i ?? 0, j ?? 0, interp === 2)) {
          regionContour.push(p);
        }
      }
    }
  }

  function handleExt(rawBody) {
    // The block content keeps its terminating '*' (and AM blocks use '*' as an
    // internal separator). Strip trailing terminators so single-statement
    // commands parse cleanly; AM still splits on the remaining separators.
    const body = rawBody.replace(/\*+$/, '');
    if (body.startsWith('FS')) {
      const m = body.match(/FS([LT])([AI])X(\d)(\d)Y(\d)(\d)/);
      if (m) {
        format.absolute = m[2] === 'A';
        format.xInt = Number(m[3]);
        format.xDec = Number(m[4]);
        format.yInt = Number(m[5]);
        format.yDec = Number(m[6]);
      }
      return;
    }
    if (body.startsWith('MO')) {
      format.unit = body.includes('IN') ? 'in' : 'mm';
      return;
    }
    if (body.startsWith('LP')) {
      polarity = body.includes('C') ? 'C' : 'D';
      return;
    }
    if (body.startsWith('AM')) {
      const lines = body.split('*');
      const name = lines[0].slice(2).trim();
      macros.set(name, new ApertureMacro(name, lines.slice(1)));
      return;
    }
    if (body.startsWith('AD')) {
      const m = body.match(/^ADD(\d+)([A-Za-z_$.][A-Za-z0-9_$.]*)(?:,(.*))?$/);
      if (!m) {
        warnings.push(`Unparsable aperture definition: ${body}`);
        return;
      }
      const code = Number(m[1]);
      const template = m[2];
      const params = (m[3] || '')
        .split('X')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map(Number);
      try {
        apertures.set(code, makeAperture({ code, template, params }, macros));
      } catch (err) {
        warnings.push(err.message);
      }
      return;
    }
    if (body.startsWith('AB') || body.startsWith('SR')) {
      warnings.push(`Unsupported block command ignored: ${body.slice(0, 2)}`);
    }
    // TF/TA/TD/TO attributes carry metadata only; ignored on purpose.
  }

  for (const tok of tokens) {
    if (tok.type === 'ext') handleExt(tok.body);
    else handleStd(tok.body);
  }
  finalizeStroke();

  return { format, warnings, flashes, strokes, regions };
}

// Break an arc into line segments. i/j are offsets from the start point to the
// centre (multi-quadrant / G75 convention, which is what KiCad emits).
function arcSegments(x0, y0, x1, y1, i, j, clockwise) {
  const cx = x0 + i;
  const cy = y0 + j;
  const r = Math.hypot(i, j);
  if (r === 0) return [[x1, y1]];
  let a0 = Math.atan2(y0 - cy, x0 - cx);
  let a1 = Math.atan2(y1 - cy, x1 - cx);
  const full = Math.abs(x1 - x0) < 1e-9 && Math.abs(y1 - y0) < 1e-9;

  if (clockwise) {
    if (a1 >= a0) a1 -= 2 * Math.PI;
    if (full) a1 = a0 - 2 * Math.PI;
  } else {
    if (a1 <= a0) a1 += 2 * Math.PI;
    if (full) a1 = a0 + 2 * Math.PI;
  }
  const sweep = Math.abs(a1 - a0);
  const chord = 0.02; // mm
  const steps = Math.max(2, Math.ceil(sweep / (2 * Math.acos(Math.max(0, 1 - chord / r)))));
  const out = [];
  for (let k = 1; k <= steps; k++) {
    const a = a0 + ((a1 - a0) * k) / steps;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

// Combine parsed primitives into a single copper polygon set (mm).
export function toFilledPolygons(parsed) {
  const dark = [];
  const clear = [];

  for (const f of parsed.flashes) {
    const rings = f.aperture.flash(f.x, f.y);
    (f.polarity === 'C' ? clear : dark).push(...rings);
  }
  for (const r of parsed.regions) {
    (r.polarity === 'C' ? clear : dark).push(r.ring);
  }

  // Strokes grouped by width so each offset pass is uniform.
  const strokeByWidth = new Map();
  for (const s of parsed.strokes) {
    const key = `${s.polarity}:${s.width.toFixed(6)}`;
    if (!strokeByWidth.has(key)) strokeByWidth.set(key, { polarity: s.polarity, width: s.width, lines: [] });
    strokeByWidth.get(key).lines.push(s.points);
  }
  for (const grp of strokeByWidth.values()) {
    if (grp.width <= 0) continue;
    const rings = offsetOpen(grp.lines, grp.width / 2, true);
    (grp.polarity === 'C' ? clear : dark).push(...rings);
  }

  const positive = union(dark);
  if (!clear.length) return positive;
  return difference(positive, union(clear));
}
