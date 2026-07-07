// Board outline / profile toolpaths.
//
// The Edge.Cuts strokes are stitched into continuous loops, offset to one side
// by the cutter radius, densified, and annotated with holding tabs. The G-code
// stage steps the depth down and ramps up over the tabs on the deep passes.

import { offsetClosed, offsetOpen, ringArea } from '../geometry/clipper.js';

const STITCH_TOL = 2e-3; // mm
const DENSIFY_MAX_SEG = 0.4; // mm

export function generateOutline(strokes, cfg) {
  const warnings = [];
  const { closed, open } = stitchPaths(strokes.map((s) => s.points));

  const radius = cfg.outline.cutterDiameter / 2;
  const side = cfg.outline.offsetSide;
  const delta = side === 'inside' ? -radius : side === 'on' ? 0 : radius;

  const loops = [];

  for (const loop of closed) {
    let rings;
    if (delta === 0) {
      rings = [loop];
    } else {
      // Offsetting a filled polygon outward keeps the board full-size and puts
      // the tool centre outside the edge.
      rings = offsetClosed([loop], delta);
    }
    for (const ring of rings) {
      const pts = densifyAndTab(ring, true, cfg.outline);
      loops.push({ pts, closed: true, area: Math.abs(ringArea(ring)) });
    }
  }

  const openLoops = [];
  for (const path of open) {
    warnings.push('Outline contains an open contour; cutting it without tabs.');
    let outPts;
    if (delta === 0) {
      outPts = path.map(([x, y]) => ({ x, y, tab: false }));
    } else {
      const rings = offsetOpen([path], delta, false);
      // offsetOpen closes the path into a thin loop; fall back to raw centre line
      outPts = (rings[0] || path.map((p) => p)).map((p) =>
        Array.isArray(p) ? { x: p[0], y: p[1], tab: false } : p,
      );
    }
    openLoops.push({ pts: outPts, closed: false, area: 0 });
  }

  return {
    loops: [...loops, ...openLoops],
    cutterDiameter: cfg.outline.cutterDiameter,
    warnings,
  };
}

// --- helpers ---------------------------------------------------------------

function key(p) {
  return `${Math.round(p[0] / STITCH_TOL)}:${Math.round(p[1] / STITCH_TOL)}`;
}

function near(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= STITCH_TOL;
}

export function stitchPaths(polylines) {
  const chains = polylines.map((p) => p.slice()).filter((p) => p.length >= 2);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const a = chains[i];
        const b = chains[j];
        const aStart = a[0];
        const aEnd = a[a.length - 1];
        const bStart = b[0];
        const bEnd = b[b.length - 1];
        let joined = null;
        if (near(aEnd, bStart)) joined = a.concat(b.slice(1));
        else if (near(aEnd, bEnd)) joined = a.concat(b.slice(0, -1).reverse());
        else if (near(aStart, bEnd)) joined = b.concat(a.slice(1));
        else if (near(aStart, bStart)) joined = a.slice().reverse().concat(b.slice(1));
        if (joined) {
          chains.splice(j, 1);
          chains[i] = joined;
          merged = true;
          break outer;
        }
      }
    }
  }

  const closed = [];
  const open = [];
  for (const c of chains) {
    if (c.length >= 3 && near(c[0], c[c.length - 1])) {
      closed.push(c.slice(0, -1)); // drop duplicated closing point
    } else {
      open.push(c);
    }
  }
  return { closed, open };
}

function loopLength(pts) {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

function densifyAndTab(ring, closed, oCfg) {
  const L = loopLength(ring);
  const nTabs = Math.max(0, oCfg.tabs | 0);
  const tabIntervals = [];
  if (nTabs > 0 && L > 0) {
    for (let i = 0; i < nTabs; i++) {
      const center = ((i + 0.5) / nTabs) * L;
      tabIntervals.push([center - oCfg.tabWidth / 2, center + oCfg.tabWidth / 2]);
    }
  }
  const inTab = (s) => {
    const sm = ((s % L) + L) % L;
    for (const [a, b] of tabIntervals) {
      const a2 = ((a % L) + L) % L;
      const b2 = ((b % L) + L) % L;
      if (a2 <= b2) {
        if (sm >= a2 && sm <= b2) return true;
      } else if (sm >= a2 || sm <= b2) {
        return true;
      }
    }
    return false;
  };

  const out = [];
  let s = 0;
  const count = ring.length;
  for (let i = 0; i < count; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % count];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(segLen / DENSIFY_MAX_SEG));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const sHere = s + segLen * t;
      out.push({ x, y, tab: inTab(sHere) });
    }
    s += segLen;
  }
  return out;
}
