// Isolation milling toolpaths.
//
// Given the copper polygon set (the copper we KEEP), we offset it outward by
// increasing amounts. Each offset ring is a path the tool centre follows so its
// inner flank grazes the copper boundary and clears a channel around every
// conductor. Multiple passes widen that channel.

import { offsetClosed } from '../geometry/clipper.js';
import { isolationToolWidth } from '../config.js';

export function generateIsolation(copperPolys, iso) {
  const width = isolationToolWidth(iso);
  const radius = width / 2;
  const stepover = Math.max(0.01, width * (1 - iso.overlap));

  const passes = [];
  for (let k = 0; k < iso.passes; k++) {
    const delta = radius + k * stepover;
    const rings = offsetClosed(copperPolys, delta).filter((r) => r.length >= 2);
    passes.push({ index: k, offset: delta, rings });
  }

  return {
    toolWidth: width,
    stepover,
    passes,
    ringCount: passes.reduce((a, p) => a + p.rings.length, 0),
  };
}
