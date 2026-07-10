// G-code emitter for the Makera Carvera / Carvera Air (Smoothieware / GRBL-style
// dialect: mm, absolute, feed in mm/min, M3/M5 spindle, M6 Tn tool change).
//
// Motion is separated from the file header/footer so the same routines feed both
// the per-tool files and the single combined program (one file, M6 tool changes,
// "load & run").

import { VACUUM_ON_COMMAND, VACUUM_OFF_COMMAND, VACUUM_LINGER_DEFAULT_S } from '../../web/public/machine-commands.js';

const PECK_DEPTH_EPSILON = 1e-4; // mm — avoids a redundant final peck from float noise

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

// --- external vacuum / air cleaner automation (Carvera Air) -----------------
// M851/M852 switch the Air's external control port (switch.extendout,
// firmware config2.default:173-177) the vacuum/air cleaner hangs on. The
// commands are emitted EXPLICITLY (not via the M331.3 follow-spindle mode) so
// the run-on and the tool-change behaviour stay under our control — and the
// automation works standalone, even when the file runs without the app.
function vacuumEnabled(cfg) {
  return !!cfg.vacuum?.enable;
}

function vacuumOn(e, cfg) {
  if (!vacuumEnabled(cfg)) return;
  e.raw(VACUUM_ON_COMMAND); // external port on — vacuum runs while cutting
}

// Program-end run-on: park first (M5 + safe Z + origin), then dwell so the
// vacuum keeps clearing dust, then switch the port off. G4 P is DECIMAL
// SECONDS on the Carvera (grbl_mode, Robot.cpp:542-546 + Kernel.cpp:160).
function vacuumOffWithLinger(e, cfg) {
  if (!vacuumEnabled(cfg)) return;
  const linger = Math.max(0, Number(cfg.vacuum?.lingerSec ?? VACUUM_LINGER_DEFAULT_S));
  e.comment(`vacuum run-on ${fmt(linger)} s, then external port off`);
  if (linger > 0) e.raw(`G4 P${fmt(linger)}`);
  e.raw(VACUUM_OFF_COMMAND);
}

// Firmware requires spindle off before M6; each M6 pauses for the swap and runs
// automatic tool-length measurement on the Carvera Air.
function emitToolChange(e, tool) {
  if (!tool || tool.number == null) return;
  e.raw('M5');
  e.comment(
    `Tool change T${tool.number}${tool.label ? ' (' + tool.label + ')' : ''} — pause, insert tool, resume for auto length measurement`,
  );
  e.raw(`M6 T${tool.number}`);
}

function outlineTotalDepth(cfg) {
  const margin = cfg.outline.throughMargin ?? cfg.drill.throughMargin ?? 0.2;
  return cfg.material.thickness + margin;
}

function outlineTabFloor(cfg) {
  return -(cfg.material.thickness - cfg.outline.tabHeight);
}

function footer(e, cfg) {
  e.raw('M5');
  e.g0(null, null, cfg.safeZ);
  e.g0(0, 0, null);
  vacuumOffWithLinger(e, cfg); // machine is parked — dwell, then port off
  e.raw('M30');
}

// --- motion (no header/footer/spindle) -------------------------------------

export function emitIsolationMotion(e, iso, cfg, origin, opts = {}) {
  const tx = makeTransform(origin);
  const z = -Math.abs(cfg.isolation.cutDepth);
  let useSafeApproach = opts.safeFirstApproach !== false;
  for (const pass of iso.passes) {
    e.comment(`isolation pass ${pass.index + 1} @ offset ${pass.offset.toFixed(3)} mm`);
    for (const ring of pass.rings) {
      if (ring.length < 2) continue;
      const [sx, sy] = tx(ring[0][0], ring[0][1]);
      const approachZ = useSafeApproach ? cfg.safeZ : cfg.travelZ;
      e.g0(null, null, approachZ);
      e.g0(sx, sy, null);
      e.g1(null, null, z, cfg.isolation.plungeFeed);
      for (let i = 1; i < ring.length; i++) {
        const [px, py] = tx(ring[i][0], ring[i][1]);
        e.g1(px, py, null, cfg.isolation.feedXY);
      }
      e.g1(sx, sy, null, cfg.isolation.feedXY);
      e.g0(null, null, cfg.travelZ);
      useSafeApproach = false;
    }
  }
}

export function emitClearingMotion(e, clearing, cfg, origin, opts = {}) {
  const tx = makeTransform(origin);
  const z = -Math.abs(cfg.clearing.cutDepth);
  let useSafeApproach = opts.safeFirstApproach !== false;
  for (const ring of clearing.paths) {
    if (ring.length < 3) continue;
    const [sx, sy] = tx(ring[0][0], ring[0][1]);
    const approachZ = useSafeApproach ? cfg.safeZ : cfg.travelZ;
    e.g0(null, null, approachZ);
    e.g0(sx, sy, null);
    e.g1(null, null, z, cfg.clearing.plungeFeed);
    for (let i = 1; i < ring.length; i++) {
      const [px, py] = tx(ring[i][0], ring[i][1]);
      e.g1(px, py, null, cfg.clearing.feedXY);
    }
    e.g1(sx, sy, null, cfg.clearing.feedXY);
    e.g0(null, null, cfg.travelZ);
    useSafeApproach = false;
  }
}

// Solder-mask removal: pocket-clear each pad region at a shallow depth (through
// the thin mask to the copper), plus a plunge for pads smaller than the bit.
// The whole pad set is traced `passes` times in one program — the cured mask
// is uneven, so a single pass often leaves residue (this replaces re-running
// the job by hand). Each pad is re-plunged and re-traced every pass.
export function emitMaskMotion(e, mask, cfg, origin, opts = {}) {
  const tx = makeTransform(origin);
  const sm = cfg.solderMask || {};
  const z = -Math.abs(mask.cutDepth ?? sm.cutDepth ?? 0.05);
  const feedXY = sm.feedXY ?? 200;
  const plungeFeed = sm.plungeFeed ?? 60;
  const passes = Math.max(1, Math.round(sm.passes ?? 1));
  let useSafeApproach = opts.safeFirstApproach !== false;
  for (let pass = 0; pass < passes; pass++) {
    if (passes > 1) e.comment(`mask pass ${pass + 1} / ${passes}`);
    for (const ring of mask.paths) {
      if (ring.length < 3) continue;
      const [sx, sy] = tx(ring[0][0], ring[0][1]);
      e.g0(null, null, useSafeApproach ? cfg.safeZ : cfg.travelZ);
      e.g0(sx, sy, null);
      e.g1(null, null, z, plungeFeed);
      for (let i = 1; i < ring.length; i++) {
        const [px, py] = tx(ring[i][0], ring[i][1]);
        e.g1(px, py, null, feedXY);
      }
      e.g1(sx, sy, null, feedXY);
      e.g0(null, null, cfg.travelZ);
      useSafeApproach = false;
    }
    for (const [px0, py0] of (mask.plunges || [])) {
      const [x, y] = tx(px0, py0);
      e.g0(null, null, useSafeApproach ? cfg.safeZ : cfg.travelZ);
      e.g0(x, y, null);
      e.g1(null, null, z, plungeFeed);
      e.g0(null, null, cfg.travelZ);
      useSafeApproach = false;
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
    while (z > -depth + PECK_DEPTH_EPSILON) {
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
  const totalDepth = outlineTotalDepth(cfg);
  const tabFloor = outlineTabFloor(cfg);
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

export function isolationGcode(iso, cfg, origin, tool = null) {
  const e = new Emitter();
  fileHeader(e, `isolation (${iso.passes.length} pass, tool width ${iso.toolWidth.toFixed(3)} mm)`);
  e.g0(null, null, cfg.safeZ);
  emitToolChange(e, tool);
  spindleOn(e, tool?.rpm ?? cfg.isolation.rpm);
  vacuumOn(e, cfg);
  emitIsolationMotion(e, iso, cfg, origin, { safeFirstApproach: true });
  footer(e, cfg);
  return e.toString();
}

export function clearingGcode(clearing, cfg, origin, tool = null) {
  const e = new Emitter();
  fileHeader(e, `copper clearing (corn bit ${clearing.toolDiameter.toFixed(2)} mm, ${clearing.paths.length} rings)`);
  e.g0(null, null, cfg.safeZ);
  emitToolChange(e, tool);
  spindleOn(e, tool?.rpm ?? cfg.clearing.rpm);
  vacuumOn(e, cfg);
  emitClearingMotion(e, clearing, cfg, origin, { safeFirstApproach: true });
  footer(e, cfg);
  return e.toString();
}

export function maskGcode(mask, cfg, origin, tool = null) {
  const e = new Emitter();
  const n = mask.paths.length + (mask.plunges?.length || 0);
  const passes = Math.max(1, Math.round(cfg.solderMask?.passes ?? 1));
  fileHeader(e, `solder-mask removal (${mask.toolDiameter.toFixed(2)} mm mask tool, ${n} pads, ${passes}× pass)`);
  // Mirrors Makera's own LED example (CopperCAM "PCB-UV-MASK(PART2)"): the UV
  // solder-mask bit is loaded via a normal M6 tool change WITH automatic tool-
  // length measurement — the reference file does exactly `T5 M06` — then the
  // pad openings are traced once at a shallow depth. Z0 is the copper surface
  // from the isolation step; M6 measures the mask tool against that same zero,
  // so the cut depth is repeatable (no fragile manual paper-zeroing).
  e.comment('Apply & cure the UV mask before running this step.');
  e.g0(null, null, cfg.safeZ);
  emitToolChange(e, tool); // M5 + M6 Tn (pause, insert mask tool, auto length measure)
  spindleOn(e, tool?.rpm ?? cfg.solderMask?.rpm ?? 6000);
  vacuumOn(e, cfg);
  emitMaskMotion(e, mask, cfg, origin, { safeFirstApproach: true });
  footer(e, cfg);
  return e.toString();
}

export function drillGcode(group, cfg, origin, tool = null) {
  const e = new Emitter();
  fileHeader(e, `drill ${group.bitDiameter.toFixed(2)} mm (${group.holes.length} holes)`);
  e.g0(null, null, cfg.safeZ);
  emitToolChange(e, tool);
  spindleOn(e, tool?.rpm ?? cfg.drill.rpm);
  vacuumOn(e, cfg);
  emitDrillMotion(e, group, cfg, origin);
  footer(e, cfg);
  return e.toString();
}

export function outlineGcode(outline, cfg, origin, tool = null) {
  const e = new Emitter();
  fileHeader(e, `outline (cutter ${outline.cutterDiameter.toFixed(2)} mm, ${cfg.outline.tabs} tabs)`);
  e.g0(null, null, cfg.safeZ);
  emitToolChange(e, tool);
  spindleOn(e, tool?.rpm ?? cfg.outline.rpm);
  vacuumOn(e, cfg);
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
  // No spindle in laser mode — the vacuum still collects engraving fumes/dust
  // (own config switch: cfg.vacuum.laser, default on).
  if (vacuumEnabled(cfg) && cfg.vacuum?.laser !== false) e.raw(VACUUM_ON_COMMAND);
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
  if (vacuumEnabled(cfg) && cfg.vacuum?.laser !== false) vacuumOffWithLinger(e, cfg);
  e.raw('M30');
  return e.toString();
}

function fmtN(n) {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

// --- combined single program with M6 tool changes -------------------------

// steps: ordered array of
//   { kind:'isolation', iso, tool, cfg }
//   { kind:'clearing', clearing, tool, cfg }
//   { kind:'drill', group, tool, cfg }
//   { kind:'outline', outline, tool, cfg }
// tool: { number, label, rpm }; cfg: effective per-step config (feeds
// come from the assigned tool where set).
export function combinedGcode(steps, cfg, origin) {
  const e = new Emitter();
  fileHeader(e, 'full job (isolation → drill → outline, M6 tool changes)');
  e.comment('Each M6 pauses for the tool and runs auto tool-length measurement.');
  e.g0(null, null, cfg.safeZ);

  for (const step of steps) {
    const t = step.tool;
    const scfg = step.cfg || cfg;
    e.raw('M5');
    // Optional: switch the vacuum off while the machine waits at the change
    // position (hands near the spindle); back on with the next spindle start.
    if (vacuumEnabled(cfg) && cfg.vacuum?.pauseToolChange) e.raw(VACUUM_OFF_COMMAND);
    e.comment(`--- ${step.title} · Tool T${t.number}${t.label ? ' (' + t.label + ')' : ''} ---`);
    e.raw(`M6 T${t.number}`);
    spindleOn(e, t.rpm);
    vacuumOn(e, cfg);
    const motionOpts = { safeFirstApproach: true };
    if (step.kind === 'isolation') emitIsolationMotion(e, step.iso, scfg, origin, motionOpts);
    else if (step.kind === 'clearing') emitClearingMotion(e, step.clearing, scfg, origin, motionOpts);
    else if (step.kind === 'drill') emitDrillMotion(e, step.group, scfg, origin);
    else if (step.kind === 'outline') emitOutlineMotion(e, step.outline, scfg, origin);
    e.g0(null, null, scfg.safeZ);
  }

  footer(e, cfg);
  return e.toString();
}

// Test helpers — tab plateau Z and outline depth math.
export { outlineTotalDepth, outlineTabFloor, PECK_DEPTH_EPSILON };
