// Copper-area clearing (background pour removal) toolpaths.
//
// Isolation milling only cuts a thin channel around every conductor. Clearing
// mills AWAY all the remaining background copper so only the traces remain
// (like a fully etched board), using a flat endmill / corn bit.
//
// Strategy: build the board rectangle (inset by a safety margin), subtract a
// no-go halo around the copper we KEEP, then fill the resulting region with a
// concentric-offset pocket — repeatedly offsetting the region inward by the
// tool stepover until nothing is left.

import { union, offsetClosed, difference } from '../geometry/clipper.js';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// copperPolys: the copper we KEEP (traces/pads). boardBounds: {minX,minY,maxX,maxY}
// in absolute board coords. isoWidth: effective isolation channel width (mm).
export function generateClearing(copperPolys, boardBounds, cfg, isoWidth) {
  const c = cfg.clearing;
  const r = c.toolDiameter / 2;
  const stepover = Math.max(0.05, c.toolDiameter * (1 - clamp(c.stepoverFrac, 0, 0.95)));
  // No-go halo around the traces: covers the isolation channel (half its width)
  // plus the tool radius (so the flat tool never nicks a conductor) plus gap.
  const keepGap = isoWidth / 2 + r + c.gap;

  // Board rectangle inset by the margin (a single closed ring).
  const rect = [
    [boardBounds.minX + c.margin, boardBounds.minY + c.margin],
    [boardBounds.maxX - c.margin, boardBounds.minY + c.margin],
    [boardBounds.maxX - c.margin, boardBounds.maxY - c.margin],
    [boardBounds.minX + c.margin, boardBounds.maxY - c.margin],
  ];

  const keep = offsetClosed(union(copperPolys), keepGap);
  // The area to clear: the inset board minus the trace halo (holes where copper is).
  const region = difference([rect], keep);
  if (!region.length) {
    return { paths: [], toolDiameter: c.toolDiameter, stepover, cutDepth: c.cutDepth };
  }

  // Concentric fill: offset the region inward in stepover increments. The first
  // ring sits a tool radius inside the region boundary so the tool stays clear.
  const paths = [];
  let delta = -r;
  const MAX_ITERATIONS = 5000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const rings = offsetClosed(region, delta).filter((ring) => ring.length >= 3);
    if (!rings.length) break;
    for (const ring of rings) paths.push(ring);
    delta -= stepover;
  }

  return { paths, toolDiameter: c.toolDiameter, stepover, cutDepth: c.cutDepth };
}
