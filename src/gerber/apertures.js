// Standard apertures (C, R, O, P) plus macro-backed apertures.
// Each aperture exposes a prototype polygon set (rings centred at the origin)
// and a flash(cx, cy) helper that returns the prototype translated to a point.

import { circleRing, union, difference } from '../geometry/clipper.js';

function rectRing(w, h) {
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
}

function obroundRings(w, h) {
  // Capsule: body rectangle plus two round caps along the longer axis.
  if (w >= h) {
    const r = h / 2;
    const bodyW = Math.max(0, w - h);
    const parts = [rectRing(bodyW, h)];
    parts.push(circleRing(-bodyW / 2, 0, r));
    parts.push(circleRing(bodyW / 2, 0, r));
    return union(parts);
  }
  const r = w / 2;
  const bodyH = Math.max(0, h - w);
  const parts = [rectRing(w, bodyH)];
  parts.push(circleRing(0, -bodyH / 2, r));
  parts.push(circleRing(0, bodyH / 2, r));
  return union(parts);
}

function regularPolygonRings(diameter, rotationDeg, vertices) {
  const r = diameter / 2;
  const ring = [];
  const rot = (rotationDeg * Math.PI) / 180;
  for (let k = 0; k < vertices; k++) {
    const a = (2 * Math.PI * k) / vertices + rot;
    ring.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return [ring];
}

function subtractHole(rings, holeDia) {
  if (!holeDia) return rings;
  return difference(rings, [circleRing(0, 0, holeDia / 2)]);
}

export function makeAperture(def, macros) {
  // def: { code, template, params: number[] } from %ADD..%
  const { template, params } = def;
  let proto;

  if (template === 'C') {
    // C, diameter [, holeDia]
    proto = subtractHole([circleRing(0, 0, params[0] / 2)], params[1]);
  } else if (template === 'R') {
    // R, x, y [, holeDia]
    proto = subtractHole([rectRing(params[0], params[1])], params[2]);
  } else if (template === 'O') {
    // O, x, y [, holeDia]
    proto = subtractHole(obroundRings(params[0], params[1]), params[2]);
  } else if (template === 'P') {
    // P, diameter, vertices [, rotation [, holeDia]]
    const dia = params[0];
    const verts = Math.max(3, Math.round(params[1]));
    const rot = params[2] || 0;
    proto = subtractHole(regularPolygonRings(dia, rot, verts), params[3]);
  } else {
    const macro = macros.get(template);
    if (!macro) {
      throw new Error(`Unknown aperture template or macro: ${template}`);
    }
    // Macro args are 1-indexed ($1 == params[0]).
    proto = macro.render([0, ...params]);
  }

  const aperture = {
    code: def.code,
    template,
    params,
    proto,
    // Diameter estimate is only meaningful for round apertures; used by the
    // trace-stroke path (D01 draws use the aperture as a circular pen).
    diameter: template === 'C' ? params[0] : Math.min(...bboxSize(proto)),
    isCircle: template === 'C',
    flash(cx, cy) {
      return proto.map((ring) => ring.map(([x, y]) => [x + cx, y + cy]));
    },
  };
  return aperture;
}

function bboxSize(rings) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [maxX - minX, maxY - minY];
}
