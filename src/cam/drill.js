// Drilling toolpaths. Groups holes by (optionally remapped) diameter and
// orders each group with a simple nearest-neighbour tour to shorten travel.

export function generateDrill(drills, cfg) {
  const material = cfg.material.thickness;
  const depth = material + cfg.drill.throughMargin;
  const remap = new Map((cfg.drill.remap || []).map((r) => [round3(r.from), r.to]));

  const groups = [];
  const slotWarnings = [];

  for (const d of drills) {
    const effDia = remap.get(round3(d.diameter)) ?? d.diameter;
    const holes = orderNearest(d.holes.map((h) => [h.x, h.y]));
    if (d.slots && d.slots.length) {
      slotWarnings.push(
        `Tool ${d.tool} (${d.diameter.toFixed(2)} mm) has ${d.slots.length} slot(s); slots are not drilled and must be routed separately.`,
      );
    }
    if (!holes.length) continue;
    groups.push({
      tool: d.tool,
      nominalDiameter: d.diameter,
      bitDiameter: effDia,
      depth,
      holes,
    });
  }

  return { groups, depth, warnings: slotWarnings };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function orderNearest(points) {
  if (points.length <= 2) return points;
  const remaining = points.slice();
  const path = [remaining.shift()];
  while (remaining.length) {
    const last = path[path.length - 1];
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const dx = remaining[i][0] - last[0];
      const dy = remaining[i][1] - last[1];
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    path.push(remaining.splice(best, 1)[0]);
  }
  return path;
}
