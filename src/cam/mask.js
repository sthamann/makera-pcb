// Solder-mask removal toolpaths — expose the pads for soldering.
//
// After the whole board is painted with UV solder mask and cured, the mask has
// to be milled off ONLY over the pads. There is no solder-mask/paste Gerber in
// this pipeline, so the pad areas are DERIVED from the copper + drill data
// (heuristic — "less exact" by design):
//
//   * pad-sized copper islands: a morphological OPENING of the copper (offset
//     inward then back out) makes thin traces vanish and keeps the wider blobs;
//     islands small enough to be a pad (not a ground pour) are kept, and
//   * a disc around every drilled hole (the through-hole annular ring),
//
//   both intersected with the copper so we only ever clear mask that actually
//   sits ON copper. Each pad region is then pocket-cleared (concentric offsets)
//   with the spring-loaded removal bit — same fill strategy as clearing.

import { union, intersection, offsetClosed, circleRing, ringArea } from '../geometry/clipper.js';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Morphological opening: shrink by r then grow back by r. Regions narrower than
// 2·r disappear (thin traces), wider ones (pads/pours) survive.
function opening(polys, r) {
  return r > 0 ? offsetClosed(offsetClosed(polys, -r), r) : polys;
}

function centroid(ring) {
  if (!ring.length) return null;
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) { x += px; y += py; }
  return [x / ring.length, y / ring.length];
}

// Sign of the OUTER contours in a polygon set. Clipper does not guarantee a
// fixed winding, so we take the largest-area ring (always an outer) as the
// reference — holes then have the opposite sign.
function outerSign(polys) {
  let maxAbs = -Infinity;
  let sign = 1;
  for (const ring of polys) {
    const a = ringArea(ring);
    if (Math.abs(a) > maxAbs) { maxAbs = Math.abs(a); sign = a < 0 ? -1 : 1; }
  }
  return sign;
}

// copperPolys: filled copper polygons (mm). drillGroups: [{ bitDiameter, holes:[[x,y]] }].
// toolDiameter: removal-bit diameter (mm). Returns pocket-fill rings + plunge
// points for pads smaller than the bit, plus the cut depth to use.
export function generateMaskRemoval(copperPolys, drillGroups, cfg, toolDiameter) {
  const c = cfg.solderMask || {};
  const r = toolDiameter / 2;
  const detectR = Math.max(0.05, c.padDetectRadius ?? 0.3);
  const maxArea = Math.max(0.1, c.padMaxAreaMm2 ?? 12);
  const padRing = Math.max(0, c.padRing ?? 0.3);
  const stepover = Math.max(0.05, toolDiameter * (1 - clamp(c.stepoverFrac ?? 0.4, 0, 0.95)));
  const cutDepth = Math.abs(c.cutDepth ?? 0.05);
  const empty = { paths: [], plunges: [], toolDiameter, stepover, cutDepth };

  const copperU = union(copperPolys || []);
  if (!copperU.length) return empty;

  // Pad-sized copper islands: wide enough to survive the opening, small enough
  // not to be a ground pour (area cutoff). Keep OUTER contours only (winding is
  // build-dependent, so compare against the set's outer sign) below the cutoff.
  const wide = opening(copperU, detectR);
  const sign = outerSign(wide);
  const smdPads = wide.filter((ring) => {
    const a = ringArea(ring);
    const isOuter = (a < 0 ? -1 : 1) === sign;
    const area = Math.abs(a);
    return isOuter && area > 1e-6 && area <= maxArea;
  });

  // Through-hole pads: a disc per drilled hole (drill + annular ring exposure).
  const drillDiscs = [];
  for (const g of (drillGroups || [])) {
    const discR = g.bitDiameter / 2 + padRing;
    for (const [x, y] of (g.holes || [])) drillDiscs.push(circleRing(x, y, discR));
  }

  const candidates = union([...smdPads, ...drillDiscs]);
  if (!candidates.length) return empty;
  // Only clear mask where there is actually copper underneath.
  const padRegions = intersection(candidates, copperU);
  if (!padRegions.length) return empty;

  // Concentric-offset pocket fill of every pad region (like clearing): the first
  // ring sits a tool radius inside the boundary so the bit stays on the pad.
  const paths = [];
  let delta = -r;
  const MAX_ITERATIONS = 5000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const rings = offsetClosed(padRegions, delta).filter((ring) => ring.length >= 3);
    if (!rings.length) break;
    for (const ring of rings) paths.push(ring);
    delta -= stepover;
  }

  // Pads smaller than the tool footprint never yield a ring — give them at
  // least a single centre plunge so the mask over them still gets opened.
  // Winding-independent: any non-degenerate region whose inward offset is empty
  // is smaller than the bit and gets a plunge.
  const plunges = [];
  for (const ring of padRegions) {
    if (Math.abs(ringArea(ring)) < 1e-6) continue; // degenerate sliver
    if (offsetClosed([ring], -r).length) continue; // big enough → covered by paths
    const cpt = centroid(ring);
    if (cpt) plunges.push(cpt);
  }

  return { paths, plunges, toolDiameter, stepover, cutDepth };
}
