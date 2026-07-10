// Geometry layer built on clipper-lib.
//
// Public API works in millimetres. A ring is an array of [x, y] points
// (implicitly closed). A "polygon set" is an array of rings, where holes are
// simply rings with opposite winding to their enclosing ring (Clipper's
// EvenOdd/NonZero rules and the offset engine both honour winding, so we never
// have to track parent/child relationships ourselves).
//
// Internally everything is scaled to integers because Clipper is an
// integer-coordinate library.

import ClipperLib from 'clipper-lib';

// 1e5 units per millimetre => 10 nm resolution. Board coordinates stay far
// inside the safe-integer range (140 mm -> 1.4e7 units).
export const SCALE = 1e5;

const ARC_TOLERANCE = 0.003 * SCALE; // ~3 µm chord error on curved offsets
const MITER_LIMIT = 2.0;

export function mmToClipper(v) {
  return Math.round(v * SCALE);
}

export function clipperToMm(v) {
  return v / SCALE;
}

function ringToPath(ring) {
  return ring.map(([x, y]) => ({ X: mmToClipper(x), Y: mmToClipper(y) }));
}

function pathToRing(path) {
  return path.map((p) => [clipperToMm(p.X), clipperToMm(p.Y)]);
}

export function toClipper(polys) {
  return polys.map(ringToPath);
}

export function fromClipper(paths) {
  return paths.map(pathToRing);
}

// Approximate a circle as a closed ring. Segment count is derived from radius
// so small pads and large pads keep a comparable chord error.
export function circleRing(cx, cy, r, minSegments = 32) {
  const chord = 0.015; // mm max chord error target
  const bySize = Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - chord / Math.max(r, chord))));
  const segs = Math.max(minSegments, Math.min(256, bySize));
  const ring = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return ring;
}

// Union an arbitrary set of closed rings into a normalised polygon set.
// Every input ring is treated as an independent solid: we force each to the
// same (positive) orientation so overlapping shapes reinforce under the NonZero
// rule instead of cancelling. Genuine cut-outs are handled via difference().
export function union(polys) {
  if (!polys.length) return [];
  const paths = toClipper(polys);
  for (const p of paths) {
    if (ClipperLib.Clipper.Area(p) < 0) p.reverse();
  }
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const solution = new ClipperLib.Paths();
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );
  return fromClipper(solution);
}

// Offset closed polygons by delta mm (positive = grow, negative = shrink).
// ClipperOffset uses path orientation to decide inside/outside, so we first
// normalise it: the largest-area ring (always an outer) is forced to Clipper's
// positive orientation, guaranteeing positive delta grows the filled area.
export function offsetClosed(polys, delta) {
  if (!polys.length) return [];
  const paths = toClipper(polys);
  normaliseOrientation(paths);
  const co = new ClipperLib.ClipperOffset(MITER_LIMIT, ARC_TOLERANCE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, delta * SCALE);
  return fromClipper(solution);
}

function normaliseOrientation(paths) {
  let maxAbs = -1;
  let maxSigned = 0;
  for (const p of paths) {
    const a = ClipperLib.Clipper.Area(p);
    if (Math.abs(a) > maxAbs) {
      maxAbs = Math.abs(a);
      maxSigned = a;
    }
  }
  if (maxSigned < 0) {
    for (const p of paths) p.reverse();
  }
}

// Offset open polylines by delta mm. Used to turn zero-width strokes (traces,
// board outline centre lines) into filled shapes. Result is a closed polygon
// set (a "capsule" per stroke).
export function offsetOpen(polylines, delta, round = true) {
  if (!polylines.length) return [];
  const co = new ClipperLib.ClipperOffset(MITER_LIMIT, ARC_TOLERANCE);
  const endType = round ? ClipperLib.EndType.etOpenRound : ClipperLib.EndType.etOpenSquare;
  const joinType = round ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter;
  for (const line of polylines) {
    co.AddPath(
      line.map(([x, y]) => ({ X: mmToClipper(x), Y: mmToClipper(y) })),
      joinType,
      endType,
    );
  }
  const solution = new ClipperLib.Paths();
  co.Execute(solution, delta * SCALE);
  return fromClipper(solution);
}

// Boolean difference: subject minus clip (both closed polygon sets).
export function difference(subject, clip) {
  if (!subject.length) return [];
  if (!clip.length) return subject.map((r) => r.slice());
  const c = new ClipperLib.Clipper();
  c.AddPaths(toClipper(subject), ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(toClipper(clip), ClipperLib.PolyType.ptClip, true);
  const solution = new ClipperLib.Paths();
  c.Execute(
    ClipperLib.ClipType.ctDifference,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );
  return fromClipper(solution);
}

// Boolean intersection: subject ∩ clip (both closed polygon sets). Used to keep
// derived pad regions strictly on top of actual copper.
export function intersection(subject, clip) {
  if (!subject.length || !clip.length) return [];
  const c = new ClipperLib.Clipper();
  c.AddPaths(toClipper(subject), ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(toClipper(clip), ClipperLib.PolyType.ptClip, true);
  const solution = new ClipperLib.Paths();
  c.Execute(
    ClipperLib.ClipType.ctIntersection,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );
  return fromClipper(solution);
}

// Number of distinct outer contours (islands). After a union, outer contours
// all share one winding and holes have the opposite. The ring with the largest
// absolute area is always an outer, so its sign defines the "outer" sign; we
// count rings matching it. Used by the clearance estimator to detect merges.
export function outerContourCount(polys) {
  if (!polys.length) return 0;
  let maxAbs = -Infinity;
  let outerSign = 1;
  for (const ring of polys) {
    const a = ringArea(ring);
    if (Math.abs(a) > maxAbs) {
      maxAbs = Math.abs(a);
      outerSign = a >= 0 ? 1 : -1;
    }
  }
  let n = 0;
  for (const ring of polys) {
    const a = ringArea(ring);
    if (a === 0) continue;
    if ((a > 0 ? 1 : -1) === outerSign) n++;
  }
  return n;
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}

export function boundingBox(polys) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of polys) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}
