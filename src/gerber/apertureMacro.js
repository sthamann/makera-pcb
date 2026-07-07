// Gerber aperture macro (%AM...%) support.
//
// A macro is stored as its raw primitive lines. At flash time it is evaluated
// with the concrete argument list from the %ADD..% call and rendered into a
// polygon set (rings in millimetres, centred on the aperture origin).
//
// Supported primitives: 1 (circle), 4 (outline), 5 (regular polygon),
// 20 (vector line), 21 (centre line / rectangle) and a best-effort 7 (thermal).
// Exposure 0 primitives are subtracted from the accumulated shape.

import { circleRing, union, difference } from '../geometry/clipper.js';

// --- tiny arithmetic evaluator for macro expressions ------------------------
// Grammar:  expr = term (('+'|'-') term)* ; term = factor (('x'|'X'|'*'|'/') factor)* ;
//           factor = ['-'|'+'] (number | $var | '(' expr ')')
function evalExpr(src, vars) {
  let i = 0;
  const s = String(src).trim();

  function peek() {
    return s[i];
  }
  function skipWs() {
    while (i < s.length && s[i] === ' ') i++;
  }
  function parseExpr() {
    let v = parseTerm();
    skipWs();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const rhs = parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
      skipWs();
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    skipWs();
    while (peek() === 'x' || peek() === 'X' || peek() === '*' || peek() === '/') {
      const op = s[i++];
      const rhs = parseFactor();
      v = op === '/' ? v / rhs : v * rhs;
      skipWs();
    }
    return v;
  }
  function parseFactor() {
    skipWs();
    let sign = 1;
    while (peek() === '+' || peek() === '-') {
      if (s[i] === '-') sign = -sign;
      i++;
      skipWs();
    }
    let v;
    if (peek() === '(') {
      i++;
      v = parseExpr();
      skipWs();
      if (peek() === ')') i++;
    } else if (peek() === '$') {
      i++;
      let num = '';
      while (i < s.length && /[0-9]/.test(s[i])) num += s[i++];
      v = Number(vars[Number(num)] ?? 0);
    } else {
      let num = '';
      while (i < s.length && /[0-9.eE+-]/.test(s[i])) {
        // stop a trailing sign that actually belongs to the next operator
        if ((s[i] === '+' || s[i] === '-') && num !== '' && !/[eE]$/.test(num)) break;
        num += s[i++];
      }
      v = Number(num);
    }
    return sign * v;
  }

  const result = parseExpr();
  return Number.isFinite(result) ? result : 0;
}

function rotatePoint([x, y], deg) {
  if (!deg) return [x, y];
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

export class ApertureMacro {
  constructor(name, primitiveLines) {
    this.name = name;
    // Keep only meaningful lines.
    this.lines = primitiveLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  // args: 1-indexed array where args[1] === $1.
  render(args) {
    const vars = args.slice();
    const addRings = [];
    const subRings = [];

    for (const line of this.lines) {
      const varDef = line.match(/^\$(\d+)\s*=\s*(.+)$/);
      if (varDef) {
        vars[Number(varDef[1])] = evalExpr(varDef[2], vars);
        continue;
      }
      const fields = line.split(',').map((f) => f.trim());
      const code = Number(fields[0]);
      if (code === 0 || Number.isNaN(code)) continue; // comment / noise
      const val = (idx) => evalExpr(fields[idx], vars);

      if (code === 1) {
        // circle: exposure, diameter, cx, cy [, rotation]
        const exposure = val(1);
        const dia = val(2);
        const cx = val(3);
        const cy = val(4);
        const rot = fields.length > 5 ? val(5) : 0;
        const [rx, ry] = rotatePoint([cx, cy], rot);
        (exposure ? addRings : subRings).push(circleRing(rx, ry, dia / 2));
      } else if (code === 20) {
        // vector line: exposure, width, x1, y1, x2, y2, rotation
        const exposure = val(1);
        const w = val(2);
        const p1 = rotatePoint([val(3), val(4)], val(7));
        const p2 = rotatePoint([val(5), val(6)], val(7));
        (exposure ? addRings : subRings).push(strokeRect(p1, p2, w));
      } else if (code === 21) {
        // centre line rectangle: exposure, width, height, cx, cy, rotation
        const exposure = val(1);
        const w = val(2);
        const h = val(3);
        const cx = val(4);
        const cy = val(5);
        const rot = val(6);
        const ring = [
          [-w / 2, -h / 2],
          [w / 2, -h / 2],
          [w / 2, h / 2],
          [-w / 2, h / 2],
        ].map(([px, py]) => rotatePoint([px + cx, py + cy], rot));
        (exposure ? addRings : subRings).push(ring);
      } else if (code === 4) {
        // outline: exposure, n, x0,y0, x1,y1, ... xn,yn, rotation
        const exposure = val(1);
        const n = val(2);
        const pts = [];
        for (let k = 0; k <= n; k++) {
          pts.push([val(3 + k * 2), val(4 + k * 2)]);
        }
        const rot = val(3 + (n + 1) * 2);
        (exposure ? addRings : subRings).push(pts.map((p) => rotatePoint(p, rot)));
      } else if (code === 5) {
        // regular polygon: exposure, vertices, cx, cy, diameter, rotation
        const exposure = val(1);
        const verts = Math.max(3, Math.round(val(2)));
        const cx = val(3);
        const cy = val(4);
        const dia = val(5);
        const rot = fields.length > 6 ? val(6) : 0;
        const r = dia / 2;
        const ring = [];
        for (let k = 0; k < verts; k++) {
          const a = (2 * Math.PI * k) / verts + (rot * Math.PI) / 180;
          ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        (exposure ? addRings : subRings).push(ring);
      } else if (code === 7) {
        // thermal: cx, cy, outerDia, innerDia, gap, rotation (best effort:
        // outer ring minus inner hole, gaps approximated as two crosses)
        const cx = val(1);
        const cy = val(2);
        const outer = circleRing(cx, cy, val(3) / 2);
        const inner = circleRing(cx, cy, val(4) / 2);
        const ann = difference([outer], [inner]);
        for (const ring of ann) addRings.push(ring);
      }
      // Unknown primitive codes are ignored (documented limitation).
    }

    const positive = union(addRings);
    if (!subRings.length) return positive;
    return difference(positive, union(subRings));
  }
}

// Rectangle (capsule body without round caps) between two points, given width.
function strokeRect(p1, p2, w) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  return [
    [p1[0] + nx, p1[1] + ny],
    [p2[0] + nx, p2[1] + ny],
    [p2[0] - nx, p2[1] - ny],
    [p1[0] - nx, p1[1] - ny],
  ];
}
