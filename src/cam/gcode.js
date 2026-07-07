// G-code emitter for the Makera Carvera / Carvera Air (Smoothieware / GRBL-style
// dialect: mm, absolute, feed in mm/min, M3/M5 spindle, M6 Tn tool change).
//
// Motion is separated from the file header/footer so the same routines feed both
// the per-tool files and the single combined program (one file, M6 tool changes,
// "load & run").

function fmt(n) {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

class Emitter {
  constructor() {
    this.lines = [];
  }
  raw(s) { this.lines.push(s); return this; }
  comment(s) { this.lines.push(`; ${s}`); return this; }
  g0(x, y, z) { this.lines.push(`G0${coord(x, y, z)}`); return this; }
  g1(x, y, z, f) { this.lines.push(`G1${coord(x, y, z)}${f != null ? ` F${fmt(f)}` : ''}`); return this; }
  toString() { return this.lines.join('\n') + '\n'; }
}

function coord(x, y, z) {
  let s = '';
  if (x != null) s += ` X${fmt(x)}`;
  if (y != null) s += ` Y${fmt(y)}`;
  if (z != null) s += ` Z${fmt(z)}`;
  return s;
}

function makeTransform(origin) {
  return (x, y) => [x - origin.x, y - origin.y];
}

function preamble(e) {
  e.raw('G21');
  e.raw('G90');
  e.raw('G94');
}

function fileHeader(e, title) {
  e.comment(`makera-pcb :: ${title}`);
  e.comment(`generated ${new Date().toISOString()}`);
  e.comment('units: mm | absolute | work origin: bottom-left corner of board');
  preamble(e);
}

function spindleOn(e, rpm) {
  e.raw(`M3 S${Math.round(rpm)}`);
  e.raw('G4 P2');
}

function footer(e, cfg) {
  e.raw('M5');
  e.g0(null, null, cfg.safeZ);
  e.g0(0, 0, null);
  e.raw('M2');
}

// --- motion (no header/footer/spindle) -------------------------------------

export function emitIsolationMotion(e, iso, cfg, origin) {
  const tx = makeTransform(origin);
  const z = -Math.abs(cfg.isolation.cutDepth);
  for (const pass of iso.passes) {
    e.comment(`isolation pass ${pass.index + 1} @ offset ${pass.offset.toFixed(3)} mm`);
    for (const ring of pass.rings) {
      if (ring.length < 2) continue;
      const [sx, sy] = tx(ring[0][0], ring[0][1]);
      e.g0(null, null, cfg.travelZ);
      e.g0(sx, sy, null);
      e.g1(null, null, z, cfg.isolation.plungeFeed);
      for (let i = 1; i < ring.length; i++) {
        const [px, py] = tx(ring[i][0], ring[i][1]);
        e.g1(px, py, null, cfg.isolation.feedXY);
      }
      e.g1(sx, sy, null, cfg.isolation.feedXY);
      e.g0(null, null, cfg.travelZ);
    }
  }
}

export function emitDrillMotion(e, group, cfg, origin) {
  const tx = makeTransform(origin);
  const depth = group.depth;
  const peck = Math.max(0.05, cfg.drill.peck);
  const retract = cfg.travelZ;
  const reengage = 0.2;
  for (const [hx, hy] of group.holes) {
    const [x, y] = tx(hx, hy);
    e.g0(null, null, cfg.safeZ);
    e.g0(x, y, null);
    let z = 0;
    let first = true;
    while (z > -depth) {
      const znext = Math.max(-depth, z - peck);
      e.g0(null, null, first ? retract : z + reengage);
      e.g1(null, null, znext, cfg.drill.plungeFeed);
      e.g0(null, null, retract);
      z = znext;
      first = false;
    }
  }
}

export function emitOutlineMotion(e, outline, cfg, origin) {
  const tx = makeTransform(origin);
  const totalDepth = cfg.material.thickness + 0.2;
  const tabFloor = -(totalDepth - cfg.outline.tabHeight);
  const step = Math.max(0.05, cfg.outline.depthPerPass);

  for (const loop of outline.loops) {
    if (!loop.pts.length) continue;
    const first = loop.pts[0];
    const [fx, fy] = tx(first.x, first.y);
    let zt = -step;
    let done = false;
    while (!done) {
      if (zt <= -totalDepth) { zt = -totalDepth; done = true; }
      e.comment(`outline pass to Z${fmt(zt)}`);
      e.g0(null, null, cfg.safeZ);
      e.g0(fx, fy, null);
      const zStart = first.tab && zt < tabFloor ? tabFloor : zt;
      e.g1(null, null, zStart, cfg.outline.plungeFeed);
      for (let i = 1; i < loop.pts.length; i++) {
        const p = loop.pts[i];
        const [px, py] = tx(p.x, p.y);
        const z = p.tab && zt < tabFloor ? tabFloor : zt;
        e.g1(px, py, z, cfg.outline.feedXY);
      }
      if (loop.closed) {
        const zc = first.tab && zt < tabFloor ? tabFloor : zt;
        e.g1(fx, fy, zc, cfg.outline.feedXY);
      }
      zt -= step;
    }
    e.g0(null, null, cfg.safeZ);
  }
}

// --- per-tool files --------------------------------------------------------

export function isolationGcode(iso, cfg, origin) {
  const e = new Emitter();
  fileHeader(e, `isolation (${iso.passes.length} pass, tool width ${iso.toolWidth.toFixed(3)} mm)`);
  e.g0(null, null, cfg.safeZ);
  spindleOn(e, cfg.isolation.rpm);
  emitIsolationMotion(e, iso, cfg, origin);
  footer(e, cfg);
  return e.toString();
}

export function drillGcode(group, cfg, origin) {
  const e = new Emitter();
  fileHeader(e, `drill ${group.bitDiameter.toFixed(2)} mm (${group.holes.length} holes)`);
  e.g0(null, null, cfg.safeZ);
  spindleOn(e, cfg.drill.rpm);
  emitDrillMotion(e, group, cfg, origin);
  footer(e, cfg);
  return e.toString();
}

export function outlineGcode(outline, cfg, origin) {
  const e = new Emitter();
  fileHeader(e, `outline (cutter ${outline.cutterDiameter.toFixed(2)} mm, ${cfg.outline.tabs} tabs)`);
  e.g0(null, null, cfg.safeZ);
  spindleOn(e, cfg.outline.rpm);
  emitOutlineMotion(e, outline, cfg, origin);
  footer(e, cfg);
  return e.toString();
}

// --- laser silkscreen engraving -------------------------------------------

// strokes: array of polylines (mm) = silkscreen centre lines. Emits Carvera
// laser-mode G-code: M321 (enter, drops tool + calibrates focus), engrave at
// Z0 focus plane with G1 + S power (G0 = laser off travel), M322 (exit).
export function laserGcode(strokes, cfg, origin) {
  const tx = makeTransform(origin);
  const e = new Emitter();
  fileHeader(e, `silkscreen laser (${strokes.length} paths, ${cfg.laser.passes} pass)`);
  e.comment('Wear laser goggles. Laser focus plane is Z0 after M321 calibration.');
  e.g0(null, null, cfg.safeZ);
  e.raw('M321'); // enter laser mode (drops any tool, calibrates focus offset)
  e.raw('G0 Z0'); // move to laser focus plane
  const s = Math.max(0, Math.min(1, cfg.laser.power));
  for (let pass = 0; pass < Math.max(1, cfg.laser.passes); pass++) {
    e.comment(`laser pass ${pass + 1}`);
    for (const line of strokes) {
      if (line.length < 2) continue;
      const [sx, sy] = tx(line[0][0], line[0][1]);
      e.g0(sx, sy, null); // laser OFF travel
      for (let i = 1; i < line.length; i++) {
        const [px, py] = tx(line[i][0], line[i][1]);
        e.raw(`G1 X${fmtN(px)} Y${fmtN(py)} F${fmtN(cfg.laser.feedXY)} S${s}`); // laser ON
      }
    }
  }
  e.raw('M322'); // exit laser mode
  e.g0(null, null, cfg.safeZ);
  e.g0(0, 0, null);
  e.raw('M2');
  return e.toString();
}

function fmtN(n) {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

// --- combined single program with M6 tool changes -------------------------

// steps: ordered array of
//   { kind:'isolation', iso, tool, cfg }
//   { kind:'drill', group, tool, cfg }
//   { kind:'outline', outline, tool, cfg }
// tool: { number, label, collet, rpm }; cfg: effective per-step config (feeds
// come from the assigned tool where set).
export function combinedGcode(steps, cfg, origin, opts = {}) {
  const e = new Emitter();
  fileHeader(e, 'full job (isolation → drill → outline, M6 tool changes)');
  e.comment('Each M6 pauses for the tool and runs auto tool-length measurement.');
  e.g0(null, null, cfg.safeZ);

  for (const step of steps) {
    const t = step.tool;
    const scfg = step.cfg || cfg;
    e.raw('M5');
    e.comment(`--- ${step.title} · Tool T${t.number}${t.label ? ' (' + t.label + ')' : ''} ---`);
    const colletParam = opts.useCollet && t.collet ? ` S${t.collet}` : '';
    e.raw(`M6 T${t.number}${colletParam}`);
    spindleOn(e, t.rpm);
    if (step.kind === 'isolation') emitIsolationMotion(e, step.iso, scfg, origin);
    else if (step.kind === 'drill') emitDrillMotion(e, step.group, scfg, origin);
    else if (step.kind === 'outline') emitOutlineMotion(e, step.outline, scfg, origin);
    e.g0(null, null, scfg.safeZ);
  }

  footer(e, cfg);
  return e.toString();
}
