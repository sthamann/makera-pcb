// End-to-end pipeline: gerber/drill text + config -> G-code files, report,
// checks and preview geometry.

import { parseGerber, toFilledPolygons } from './gerber/parser.js';
import { parseExcellon } from './excellon/parser.js';
import { generateIsolation } from './cam/isolation.js';
import { generateClearing } from './cam/clearing.js';
import { generateMaskRemoval } from './cam/mask.js';
import { generateDrill } from './cam/drill.js';
import { generateOutline } from './cam/outline.js';
import { isolationGcode, clearingGcode, maskGcode, drillGcode, outlineGcode, combinedGcode, laserGcode } from './cam/gcode.js';
import { runChecks } from './cam/checks.js';
import { buildReport } from './report.js';
import {
  defaultConfig, mergeConfig, isolationToolWidth, DEFAULT_TOOL_NUMBER,
  SOLDER_MASK_REMOVER_DIAMETER, SOLDER_MASK_REMOVER_RPM, LASER_SPOT_DIAMETER,
} from './config.js';
import { boundingBox } from './geometry/clipper.js';

export function runPipeline({ copper, edge, drill, silk, config = {} } = {}) {
  const cfg = mergeConfig(defaultConfig, config);
  const warnings = [];

  if (!copper) throw new Error('No copper layer (F.Cu) provided.');

  const copperParsed = parseGerber(copper);
  warnings.push(...copperParsed.warnings.map((w) => `[copper] ${w}`));
  const copperPolys = toFilledPolygons(copperParsed);
  if (!copperPolys.length) throw new Error('Copper layer produced no geometry — check the file.');

  let silkPolys = [];
  let silkStrokes = [];
  if (silk) {
    try {
      const silkParsed = parseGerber(silk);
      warnings.push(...silkParsed.warnings.map((w) => `[silk] ${w}`));
      silkPolys = toFilledPolygons(silkParsed);
      // Laser engraving follows the stroke centre lines (plus region outlines).
      silkStrokes = silkParsed.strokes.map((s) => s.points);
      for (const r of silkParsed.regions) silkStrokes.push([...r.ring, r.ring[0]]);
    } catch (err) {
      warnings.push(`[silk] ${err.message}`);
    }
  }

  let outlineStrokes = [];
  let edgeBounds = null;
  if (edge) {
    const edgeParsed = parseGerber(edge);
    warnings.push(...edgeParsed.warnings.map((w) => `[edge] ${w}`));
    outlineStrokes = edgeParsed.strokes;
    // Bounds from edge strokes (their centre lines define the true board edge).
    const pts = outlineStrokes.flatMap((s) => s.points);
    if (pts.length) {
      edgeBounds = boundingBox([pts]);
    }
  } else {
    warnings.push('No Edge.Cuts layer provided — outline step skipped.');
  }

  const copperBounds = boundingBox(copperPolys);
  const boardBounds = edgeBounds || copperBounds;
  const origin = { x: boardBounds.minX, y: boardBounds.minY };
  const board = {
    width: boardBounds.maxX - boardBounds.minX,
    height: boardBounds.maxY - boardBounds.minY,
  };

  // Board placement offset on the blank (drag & drop in the Material tab).
  // THE single insertion point for the whole pipeline: the G-code emitters map
  // board coordinates with `p - origin`, so shifting the work origin by
  // -offset moves EVERY operation (isolation, clearing, drills, outline,
  // laser) to work (offset.x, offset.y) — the work origin itself stays at the
  // blank corner (anchor 1, no extra offset). Geometry generation and the
  // preview remain board-local and untouched.
  const placement = {
    x: Math.max(0, Number(cfg.placement?.offsetX) || 0),
    y: Math.max(0, Number(cfg.placement?.offsetY) || 0),
  };
  const gcodeOrigin = { x: origin.x - placement.x, y: origin.y - placement.y };

  const iso = generateIsolation(copperPolys, cfg.isolation);

  // Optional copper-area clearing (background pour removal). Mills away the
  // remaining background copper; the halo keeps the tool clear of every trace.
  let clearing = { paths: [] };
  if (cfg.clearing.enable) {
    clearing = generateClearing(copperPolys, boardBounds, cfg, isolationToolWidth(cfg.isolation));
  }

  let drillResult = { drills: [] };
  let drillGen = { groups: [], warnings: [] };
  if (drill) {
    drillResult = parseExcellon(drill);
    warnings.push(...drillResult.warnings.map((w) => `[drill] ${w}`));
    drillGen = generateDrill(drillResult.drills, cfg);
  } else {
    warnings.push('No drill file provided — drilling step skipped.');
  }

  // Optional solder-mask removal: derive the pad areas from copper + drills and
  // pocket-clear the cured UV mask off them with the removal bit (own program,
  // runs AFTER the manual apply/cure steps — never part of the combined job).
  let maskGen = { paths: [], plunges: [], toolDiameter: SOLDER_MASK_REMOVER_DIAMETER };
  if (cfg.solderMask?.enable) {
    maskGen = generateMaskRemoval(copperPolys, drillGen.groups, cfg, SOLDER_MASK_REMOVER_DIAMETER);
    if (!maskGen.paths.length && !maskGen.plunges.length) {
      warnings.push('Lötstopplack aktiviert, aber keine Pad-Flächen ableitbar (Kupfer/Bohrungen prüfen).');
    }
  }

  let outlineGen = { loops: [], warnings: [], cutterDiameter: cfg.outline.cutterDiameter };
  if (outlineStrokes.length) {
    outlineGen = generateOutline(outlineStrokes, cfg);
    warnings.push(...outlineGen.warnings.map((w) => `[outline] ${w}`));
  }

  // Tool assignment + per-tool feeds/speeds. Each operation uses the assigned
  // tool's feedXY/plungeFeed/rpm (and peck for drills) where provided; geometry
  // stays driven by the config. This makes the tool library actually drive the job.
  const assignment = config.toolAssignment || {};
  const tools = new Map((config.tools || []).map((t) => [String(t.number), t]));
  const toolForOp = (opId) => {
    const num = assignment[opId];
    return num != null ? tools.get(String(num)) : null;
  };
  const resolveFileTool = (opId, rpm, fallbackNumber) => {
    const t = toolForOp(opId);
    if (t) return { number: t.number, label: t.label || '', rpm: t.rpm ?? rpm };
    return { number: fallbackNumber, label: '', rpm };
  };
  const withTool = (section, opId) => {
    const t = toolForOp(opId);
    const c = structuredClone(cfg);
    if (t) {
      if (t.feedXY != null && c[section]) c[section].feedXY = t.feedXY;
      if (t.plungeFeed != null && c[section]) c[section].plungeFeed = t.plungeFeed;
      if (t.rpm != null && c[section]) c[section].rpm = t.rpm;
      if (section === 'drill' && t.peck != null) c.drill.peck = t.peck;
    }
    return c;
  };

  // --- G-code files ---
  const fileNames = { isolation: '1_isolation.nc', drill: {}, outline: null };
  const files = {};
  files[fileNames.isolation] = isolationGcode(
    iso,
    withTool('isolation', 'isolation'),
    gcodeOrigin,
    resolveFileTool('isolation', cfg.isolation.rpm, DEFAULT_TOOL_NUMBER.isolation),
  );

  if (cfg.clearing.enable && clearing.paths.length) {
    const name = '1b_clearing.nc';
    fileNames.clearing = name;
    files[name] = clearingGcode(
      clearing,
      withTool('clearing', 'clearing'),
      gcodeOrigin,
      resolveFileTool('clearing', cfg.clearing.rpm, DEFAULT_TOOL_NUMBER.clearing),
    );
  }

  if (cfg.solderMask?.enable && (maskGen.paths.length || maskGen.plunges.length)) {
    const name = '1c_soldermask_removal.nc';
    fileNames.maskRemove = name;
    files[name] = maskGcode(
      maskGen,
      withTool('solderMask', 'maskRemove'),
      gcodeOrigin,
      resolveFileTool('maskRemove', cfg.solderMask.rpm, DEFAULT_TOOL_NUMBER.maskRemove),
    );
  }

  let idx = 2;
  let drillFallback = DEFAULT_TOOL_NUMBER.drillBase;
  const drillGroupsSorted = drillGen.groups.slice().sort((a, b) => a.bitDiameter - b.bitDiameter);
  for (const g of drillGroupsSorted) {
    const opId = `drill:${g.bitDiameter.toFixed(2)}`;
    const name = `${idx}_drill_${g.bitDiameter.toFixed(2)}mm.nc`;
    fileNames.drill[g.tool] = name;
    files[name] = drillGcode(
      g,
      withTool('drill', opId),
      gcodeOrigin,
      resolveFileTool(opId, cfg.drill.rpm, drillFallback++),
    );
    idx++;
  }

  if (outlineGen.loops.length) {
    const name = `${idx}_outline.nc`;
    fileNames.outline = name;
    files[name] = outlineGcode(
      outlineGen,
      withTool('outline', 'outline'),
      gcodeOrigin,
      resolveFileTool('outline', cfg.outline.rpm, DEFAULT_TOOL_NUMBER.outline),
    );
    idx++;
  }

  // Optional laser silkscreen engraving (separate program: laser mode drops
  // the tool, so it is not part of the M6 combined job).
  const laserOn = cfg.laser?.enable && silkStrokes.length > 0;
  if (laserOn) {
    const name = `${idx}_silkscreen_laser.nc`;
    fileNames.laser = name;
    files[name] = laserGcode(silkStrokes, cfg, gcodeOrigin);
    idx++;
  } else if (cfg.laser?.enable && !silkStrokes.length) {
    warnings.push('Laser aktiviert, aber keine Silkscreen-Geometrie vorhanden.');
  }

  // Operations that need a tool assigned (drives the tool-library UI). The
  // list mirrors the fabrication order and covers EVERY enabled step:
  // isolation → clearing → solder-mask removal → drills → outline → laser.
  // `separate: true` marks steps that run OUTSIDE the combined M6 spindle job
  // (laser mode drops the tool; mask removal is a guided manual step).
  const operations = [
    {
      id: 'isolation',
      title: 'Isolation',
      toolType: cfg.isolation.tool === 'endmill' ? 'endmill' : 'vbit',
      diameter: isolationToolWidth(cfg.isolation),
      rpm: cfg.isolation.rpm,
    },
  ];
  if (cfg.clearing.enable && clearing.paths.length) {
    operations.push({
      id: 'clearing',
      title: 'Kupfer-Clearing',
      toolType: 'endmill',
      diameter: cfg.clearing.toolDiameter,
      rpm: cfg.clearing.rpm,
    });
  }
  if (cfg.solderMask?.enable) {
    operations.push({
      id: 'maskRemove',
      title: 'Lötstopplack von den Pads entfernen',
      toolType: 'vbit', // PCB pack: 30° engraving bit (tip size = diameter)
      diameter: SOLDER_MASK_REMOVER_DIAMETER,
      rpm: SOLDER_MASK_REMOVER_RPM,
      separate: true, // guided manual step — never part of 0_full_job.nc
    });
  }
  operations.push(...drillGroupsSorted.map((g) => ({
    id: `drill:${g.bitDiameter.toFixed(2)}`,
    title: `Bohren ${g.bitDiameter.toFixed(2)} mm`,
    toolType: 'drill',
    diameter: g.bitDiameter,
    rpm: cfg.drill.rpm,
  })));
  if (outlineGen.loops.length) {
    operations.push({
      id: 'outline',
      title: 'Außenkontur',
      toolType: 'endmill',
      diameter: cfg.outline.cutterDiameter,
      rpm: cfg.outline.rpm,
    });
  }
  if (laserOn) {
    operations.push({
      id: 'laser',
      title: 'Laser-Silkscreen',
      toolType: 'laser',
      diameter: LASER_SPOT_DIAMETER,
      rpm: 0,
      separate: true, // own program (M321/M322) — laser mode drops the tool
    });
  }

  // Combined single program with M6 tool changes (if the caller assigned
  // tools). Only SPINDLE operations belong in it — laser (M321 drops the tool)
  // and the manual mask-removal step run separately by design.
  const spindleOps = operations.filter((op) => !op.separate);
  const steps = [];
  let combinedOk = spindleOps.length > 0;
  const resolveTool = (opId, rpm) => {
    const t = toolForOp(opId);
    if (!t) { combinedOk = false; return null; }
    return { number: t.number, label: t.label || '', collet: t.collet, rpm: t.rpm || rpm };
  };
  {
    const t = resolveTool('isolation', cfg.isolation.rpm);
    if (t) steps.push({ kind: 'isolation', title: 'Isolation', iso, tool: t, cfg: withTool('isolation', 'isolation') });
  }
  if (cfg.clearing.enable && clearing.paths.length) {
    const t = resolveTool('clearing', cfg.clearing.rpm);
    if (t) steps.push({ kind: 'clearing', title: 'Kupfer-Clearing', clearing, tool: t, cfg: withTool('clearing', 'clearing') });
  }
  for (const g of drillGroupsSorted) {
    const opId = `drill:${g.bitDiameter.toFixed(2)}`;
    const t = resolveTool(opId, cfg.drill.rpm);
    if (t) steps.push({ kind: 'drill', title: `Bohren ${g.bitDiameter.toFixed(2)} mm`, group: g, tool: t, cfg: withTool('drill', opId) });
  }
  if (outlineGen.loops.length) {
    const t = resolveTool('outline', cfg.outline.rpm);
    if (t) steps.push({ kind: 'outline', title: 'Außenkontur', outline: outlineGen, tool: t, cfg: withTool('outline', 'outline') });
  }
  if (combinedOk && steps.length === spindleOps.length) {
    files['0_full_job.nc'] = combinedGcode(steps, cfg, gcodeOrigin);
    fileNames.combined = '0_full_job.nc';
  }

  // Rough machining-time estimates per operation (for the live fabrication view).
  const times = estimateTimes({ iso, clearing, maskGen, drillGroupsSorted, outlineGen, silkStrokes, laserOn, cfg, withTool });

  const checks = runChecks({
    copperPolys,
    drill: drillGen,
    outline: outlineGen,
    cfg,
    boardBounds,
  });

  const report = buildReport({
    cfg,
    board,
    iso,
    drill: drillGen,
    outline: outlineGen,
    checks,
    files: fileNames,
    warnings,
    assignment,
    tools,
    toolForOp,
    laserOn,
    clearingOn: cfg.clearing.enable && clearing.paths.length > 0,
    silkPresent: silkStrokes.length > 0,
    placement,
  });

  const preview = buildPreview({
    origin, board, copperPolys, silkPolys, iso, drillGen, outlineGen, cfg,
    laserStrokes: laserOn ? silkStrokes : [],
    clearingPaths: cfg.clearing.enable ? clearing.paths : [],
    maskPaths: cfg.solderMask?.enable ? maskGen.paths : [],
    maskPlunges: cfg.solderMask?.enable ? maskGen.plunges : [],
    maskToolDiameter: maskGen.toolDiameter,
  });

  return {
    cfg,
    board,
    origin,
    placement,
    files,
    fileNames,
    report,
    checks,
    warnings,
    operations,
    times,
    stats: {
      isolationRings: iso.ringCount,
      clearingRings: clearing.paths.length,
      drillGroups: drillGen.groups.map((g) => ({ diameter: g.bitDiameter, holes: g.holes.length })),
      minCopperGap: checks.minCopperGap,
      totalSeconds: times.total,
    },
    preview,
  };
}

// Rough time model: cutting distance / feed + per-feature plunge/travel overhead.
function estimateTimes({ iso, clearing, maskGen, drillGroupsSorted, outlineGen, silkStrokes, laserOn, cfg, withTool }) {
  const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ringLen = (r) => { let L = 0; for (let i = 1; i < r.length; i++) L += segLen(r[i - 1], r[i]); if (r.length > 1) L += segLen(r[r.length - 1], r[0]); return L; };
  const byOp = {};

  // isolation
  {
    const c = withTool('isolation', 'isolation').isolation;
    let L = 0;
    let rings = 0;
    for (const pass of iso.passes) for (const r of pass.rings) { L += ringLen(r); rings++; }
    byOp.isolation = (L / Math.max(1, c.feedXY)) * 60 + rings * 1.5;
  }
  // clearing
  if (clearing && clearing.paths.length) {
    const c = withTool('clearing', 'clearing').clearing;
    let L = 0;
    let rings = 0;
    for (const r of clearing.paths) { L += ringLen(r); rings++; }
    byOp.clearing = (L / Math.max(1, c.feedXY)) * 60 + rings * 1.0;
  }
  // solder-mask removal (× passes — the whole pad set is traced repeatedly)
  if (maskGen && (maskGen.paths.length || (maskGen.plunges || []).length)) {
    const c = withTool('solderMask', 'maskRemove').solderMask;
    const passes = Math.max(1, Math.round(c.passes ?? 1));
    let L = 0;
    for (const r of maskGen.paths) L += ringLen(r);
    byOp.maskRemove = passes * ((L / Math.max(1, c.feedXY)) * 60 + maskGen.paths.length * 0.5 + (maskGen.plunges || []).length * 1);
  }
  // drilling
  for (const g of drillGroupsSorted) {
    const c = withTool('drill', `drill:${g.bitDiameter.toFixed(2)}`).drill;
    const pecks = Math.max(1, Math.ceil(g.depth / Math.max(0.05, c.peck)));
    const perHole = 2 + pecks * ((g.depth / Math.max(1, c.plungeFeed)) * 60);
    byOp[`drill:${g.bitDiameter.toFixed(2)}`] = g.holes.length * perHole;
  }
  // outline
  if (outlineGen.loops.length) {
    const c = withTool('outline', 'outline').outline;
    const margin = c.throughMargin ?? cfg.drill.throughMargin ?? 0.2;
    const passes = Math.max(1, Math.ceil((cfg.material.thickness + margin) / Math.max(0.05, c.depthPerPass)));
    let L = 0;
    for (const loop of outlineGen.loops) { for (let i = 1; i < loop.pts.length; i++) L += Math.hypot(loop.pts[i].x - loop.pts[i - 1].x, loop.pts[i].y - loop.pts[i - 1].y); }
    byOp.outline = (L * passes / Math.max(1, c.feedXY)) * 60 + outlineGen.loops.length * passes * 2;
  }
  // laser
  if (laserOn) {
    let L = 0;
    for (const line of silkStrokes) for (let i = 1; i < line.length; i++) L += segLen(line[i - 1], line[i]);
    byOp.laser = (L * Math.max(1, cfg.laser.passes) / Math.max(1, cfg.laser.feedXY)) * 60;
  }
  const total = Object.values(byOp).reduce((a, b) => a + b, 0);
  return { byOp, total };
}

function buildPreview({ origin, board, copperPolys, silkPolys, iso, drillGen, outlineGen, cfg, laserStrokes, clearingPaths, maskPaths, maskPlunges, maskToolDiameter }) {
  const tx = (x, y) => [round(x - origin.x), round(y - origin.y)];
  const copper = copperPolys.map((ring) => ring.map(([x, y]) => tx(x, y)));
  const silk = (silkPolys || []).map((ring) => ring.map(([x, y]) => tx(x, y)));
  const laser = (laserStrokes || []).map((line) => line.map(([x, y]) => tx(x, y)));
  const isolation = iso.passes.map((pass) => pass.rings.map((ring) => ring.map(([x, y]) => tx(x, y))));
  const clearing = (clearingPaths || []).map((ring) => ring.map(([x, y]) => tx(x, y)));
  const maskRemoval = (maskPaths || []).map((ring) => ring.map(([x, y]) => tx(x, y)));
  const maskPlungeDots = (maskPlunges || []).map(([x, y]) => { const [px, py] = tx(x, y); return { x: px, y: py, d: maskToolDiameter || 0.3 }; });
  const drills = [];
  for (const g of drillGen.groups) {
    for (const [x, y] of g.holes) {
      const [px, py] = tx(x, y);
      drills.push({ x: px, y: py, d: g.bitDiameter });
    }
  }
  const outline = outlineGen.loops.map((loop) => ({
    closed: loop.closed,
    pts: loop.pts.map((p) => {
      const [x, y] = tx(p.x, p.y);
      return { x, y, tab: !!p.tab };
    }),
  }));
  return { board, thickness: cfg.material.thickness, copper, silk, laser, isolation, clearing, maskRemoval, maskPlunges: maskPlungeDots, drills, outline };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
