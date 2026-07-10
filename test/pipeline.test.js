import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/pipeline.js';

// Example board: prefer the sibling ../platine checkout, fall back to the
// bundled copy in ./gerbers (same files the "Load example board" button uses).
const gerberDir = [
  fileURLToPath(new URL('../../platine/gerbers/', import.meta.url)),
  fileURLToPath(new URL('../gerbers/', import.meta.url)),
].find((d) => fs.existsSync(d + 'i2c_bus_board-F_Cu.gbr')) || '';
const files = {
  copper: gerberDir + 'i2c_bus_board-F_Cu.gbr',
  edge: gerberDir + 'i2c_bus_board-Edge_Cuts.gbr',
  drill: gerberDir + 'i2c_bus_board.drl',
};
const havePlatine = !!gerberDir;

test('end-to-end on the real i2c board', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    config: { stock: { sizeX: 200, sizeY: 150 } },
  });

  assert.ok(Math.abs(result.board.width - 138.5) < 0.2, `width ${result.board.width}`);
  assert.ok(Math.abs(result.board.height - 30) < 0.2, `height ${result.board.height}`);

  // Two drill diameters: 1.0 mm and 1.3 mm.
  assert.equal(result.stats.drillGroups.length, 2);
  const diams = result.stats.drillGroups.map((g) => Math.round(g.diameter * 10) / 10).sort();
  assert.deepEqual(diams, [1, 1.3]);
  const totalHoles = result.stats.drillGroups.reduce((a, g) => a + g.holes, 0);
  assert.equal(totalHoles, 54);

  // Millable gap and no hard errors.
  assert.ok(result.stats.minCopperGap > 0.18, `gap ${result.stats.minCopperGap}`);
  assert.equal(result.checks.messages.filter((m) => m.level === 'error').length, 0);

  // Files produced and syntactically sane.
  assert.ok(result.files['1_isolation.nc']);
  assert.ok(result.fileNames.outline);
  for (const [name, gcode] of Object.entries(result.files)) {
    assert.ok(gcode.startsWith('; makera-pcb'), `${name} header`);
    assert.match(gcode, /\nG21\n/, `${name} sets mm`);
    if (!name.includes('silkscreen_laser')) {
      assert.match(gcode, /M6 T\d+/, `${name} has M6 tool change`);
    }
    assert.match(gcode, /M3 S\d+/, `${name} spindle on`);
    assert.match(gcode, /\nM5\n/, `${name} spindle off`);
    assert.ok(!/NaN|Infinity/.test(gcode), `${name} has no NaN/Infinity`);
  }
});

test('builds a combined M6 program when tools are assigned', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const tools = [
    { number: 1, type: 'vbit', diameter: 0.1, label: 'V-Bit 30°' },
    { number: 2, type: 'drill', diameter: 1.0 },
    { number: 3, type: 'drill', diameter: 1.3 },
    { number: 4, type: 'endmill', diameter: 1.0 },
  ];
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    config: {
      tools,
      toolAssignment: { isolation: 1, 'drill:1.00': 2, 'drill:1.30': 3, outline: 4 },
    },
  });
  const combined = result.files['0_full_job.nc'];
  assert.ok(combined, 'combined program produced');
  // tool changes present in the isolation -> drill -> outline order
  const order = [...combined.matchAll(/M6 T(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.match(combined, /\nM30\n$/);
});

test('operations are reported for tool assignment', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({ copper: read(files.copper), edge: read(files.edge), drill: read(files.drill) });
  const ids = result.operations.map((o) => o.id);
  assert.ok(ids.includes('isolation'));
  assert.ok(ids.includes('outline'));
  assert.ok(ids.some((i) => i.startsWith('drill:')));
});

test('laser engraving file is produced when enabled with silkscreen', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const silkPath = gerberDir + 'i2c_bus_board-F_Silkscreen.gbr';
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    silk: read(silkPath),
    config: { laser: { enable: true, power: 0.6, feedXY: 600, passes: 1 } },
  });
  assert.ok(result.fileNames.laser, 'laser file name set');
  const lf = result.files[result.fileNames.laser];
  assert.match(lf, /M321[\s\S]*M322/);
  assert.ok(result.preview.laser.length > 0, 'preview has laser paths');
});

test('per-tool feed/speed overrides drive the generated g-code', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    config: {
      tools: [{ number: 1, type: 'vbit', diameter: 0.1, feedXY: 321, rpm: 9111 }],
      toolAssignment: { isolation: 1 },
    },
  });
  const iso = result.files['1_isolation.nc'];
  assert.match(iso, /F321\b/, 'isolation uses the tool feed');
  assert.match(iso, /M3 S9111\b/, 'isolation uses the tool rpm');
});

test('guided report includes solder-mask and laser steps when enabled', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    silk: read(gerberDir + 'i2c_bus_board-F_Silkscreen.gbr'),
    config: { solderMask: { enable: true }, laser: { enable: true } },
  });
  assert.match(result.report, /Lötstopplack auftragen/i);
  assert.match(result.report, /Pads entfernen/i);
  assert.match(result.report, /Silkscreen mit Laser/i);
  assert.match(result.report, /Werkzeug/); // tool-change callouts present
});

test('operations cover every enabled step (clearing, mask removal, laser) in fab order', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    silk: read(gerberDir + 'i2c_bus_board-F_Silkscreen.gbr'),
    config: {
      clearing: { enable: true },
      laser: { enable: true },
      solderMask: { enable: true },
    },
  });
  const ids = result.operations.map((o) => o.id);
  // fabrication order: isolation → clearing → mask removal → drills → outline → laser
  assert.equal(ids[0], 'isolation');
  assert.equal(ids[1], 'clearing');
  assert.equal(ids[2], 'maskRemove');
  assert.ok(ids.indexOf('maskRemove') < ids.findIndex((i) => i.startsWith('drill:')));
  assert.equal(ids[ids.length - 2], 'outline');
  assert.equal(ids[ids.length - 1], 'laser');
  // laser + mask removal are flagged as separate (not part of the spindle job)
  const byId = Object.fromEntries(result.operations.map((o) => [o.id, o]));
  assert.equal(byId.laser.separate, true);
  assert.equal(byId.laser.toolType, 'laser');
  assert.equal(byId.maskRemove.separate, true);
  assert.equal(byId.clearing.separate, undefined);
});

test('solder-mask removal produces a shallow pad-clearing program + preview', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    config: { solderMask: { enable: true } },
  });
  const name = result.fileNames.maskRemove;
  assert.ok(name && /soldermask/i.test(name), 'a solder-mask removal file is named');
  const nc = result.files[name];
  assert.match(nc, /solder-mask removal/i);
  // Matches Makera's LED reference (CopperCAM PCB-UV-MASK PART2): normal M6 tool
  // change WITH auto length measurement, single shallow pass at Z-0.2.
  assert.match(nc, /M6 T\d/);
  assert.doesNotMatch(nc, /M493\.2 T\d/);
  assert.match(nc, /G1 .*Z-0\.2\b/); // shallow cut, Makera's exact depth
  assert.ok(result.preview.maskRemoval.length > 0, 'preview carries the pad toolpaths');
});

test('operations shrink again when clearing/laser/solder mask are disabled', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
  });
  const ids = result.operations.map((o) => o.id);
  assert.ok(!ids.includes('clearing'));
  assert.ok(!ids.includes('maskRemove'));
  assert.ok(!ids.includes('laser'));
});

test('combined job includes clearing but never laser/mask steps', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const tools = [
    { number: 1, type: 'vbit', diameter: 0.1, label: 'V-Bit 30°' },
    { number: 2, type: 'drill', diameter: 1.0 },
    { number: 3, type: 'drill', diameter: 1.3 },
    { number: 4, type: 'endmill', diameter: 1.0 },
    { number: 6, type: 'endmill', diameter: 0.8, label: 'Corn-Bit' },
    { number: 10, type: 'endmill', diameter: 0.9, label: 'Lötstopplack-Entferner' },
    { number: 11, type: 'laser', diameter: 0.1, label: 'Laser 5W' },
  ];
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    silk: read(gerberDir + 'i2c_bus_board-F_Silkscreen.gbr'),
    config: {
      clearing: { enable: true },
      laser: { enable: true },
      solderMask: { enable: true },
      tools,
      toolAssignment: {
        isolation: 1, clearing: 6, 'drill:1.00': 2, 'drill:1.30': 3, outline: 4,
        maskRemove: 10, laser: 11,
      },
    },
  });
  const combined = result.files['0_full_job.nc'];
  assert.ok(combined, 'combined program produced despite separate laser/mask ops');
  const order = [...combined.matchAll(/M6 T(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [1, 6, 2, 3, 4], 'isolation → clearing → drills → outline');
  assert.ok(!combined.includes('M321'), 'no laser mode in the spindle job');
  assert.ok(!order.includes(10), 'mask-removal tool not part of the spindle job');
  assert.ok(!order.includes(11), 'laser tool not part of the spindle job');
});

test('stock fit check flags a board that is too large for the blank', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const tooSmall = runPipeline({
    copper: read(files.copper), edge: read(files.edge), drill: read(files.drill),
    config: { stock: { sizeX: 100, sizeY: 50 } }, // 138.5 + 4 mm margin > 100 in both orientations
  });
  assert.ok(tooSmall.checks.messages.some((m) => m.level === 'error' && /passt NICHT/i.test(m.text)));

  // The standard Makera 150×100 blank fits the 138.5 mm example board: the
  // work origin sits at anchor 1 = the blank's corner, so the board starts at
  // the corner (verified on the real machine — scan margin ran the full
  // 138.5 mm span on this blank).
  const makeraBlank = runPipeline({
    copper: read(files.copper), edge: read(files.edge), drill: read(files.drill),
    config: { stock: { sizeX: 150, sizeY: 100 } },
  });
  assert.ok(makeraBlank.checks.messages.some((m) => m.level === 'ok' && /passt auf den Rohling/i.test(m.text)));

  const fits = runPipeline({
    copper: read(files.copper), edge: read(files.edge), drill: read(files.drill),
    config: { stock: { sizeX: 200, sizeY: 150 } },
  });
  assert.ok(fits.checks.messages.some((m) => /passt auf den Rohling/i.test(m.text) && /Anker 1/i.test(m.text)));
});

// --- board placement offset (drag & drop) ------------------------------------

// First rapid XY position of a program (the move to the first feature).
function firstXY(gcode) {
  const m = gcode.match(/^G0 X(-?[\d.]+) Y(-?[\d.]+)$/m);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

test('placement offset shifts EVERY operation in the g-code, preview stays board-local', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const input = {
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
    silk: read(gerberDir + 'i2c_bus_board-F_Silkscreen.gbr'),
  };
  const base = runPipeline({ ...input, config: { laser: { enable: true } } });
  const off = { offsetX: 12.5, offsetY: 7 };
  const moved = runPipeline({ ...input, config: { laser: { enable: true }, placement: off } });
  assert.deepEqual(moved.placement, { x: 12.5, y: 7 });

  // every program's first XY move is shifted by exactly the offset
  for (const name of Object.keys(base.files)) {
    const a = firstXY(base.files[name]);
    const b = firstXY(moved.files[name]);
    assert.ok(a && b, `${name} has a first XY rapid`);
    assert.ok(Math.abs(b.x - a.x - off.offsetX) < 1e-6, `${name} X shifted (${a.x} → ${b.x})`);
    assert.ok(Math.abs(b.y - a.y - off.offsetY) < 1e-6, `${name} Y shifted (${a.y} → ${b.y})`);
  }
  // laser cuts (G1 X.. Y.. F.. S..) shift too
  const laserLine = (g) => g.match(/^G1 X(-?[\d.]+) Y(-?[\d.]+) F[\d.]+ S/m);
  const la = laserLine(base.files[base.fileNames.laser]);
  const lb = laserLine(moved.files[moved.fileNames.laser]);
  assert.ok(Math.abs(Number(lb[1]) - Number(la[1]) - off.offsetX) < 1e-6, 'laser X shifted');
  assert.ok(Math.abs(Number(lb[2]) - Number(la[2]) - off.offsetY) < 1e-6, 'laser Y shifted');

  // the footer still parks at the WORK ORIGIN (blank corner), not the board corner
  assert.match(moved.files['1_isolation.nc'], /\nG0 X0 Y0\n/);

  // board geometry + preview are board-local and identical
  assert.deepEqual(moved.board, base.board);
  assert.deepEqual(moved.preview.drills, base.preview.drills);
  assert.deepEqual(moved.preview.copper.length, base.preview.copper.length);

  // report documents the placement
  assert.match(moved.report, /X 12\.5 \/ Y 7 mm/);
});

test('placement offset feeds the stock-fit check (fits at 0, fails displaced)', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const input = { copper: read(files.copper), edge: read(files.edge), drill: read(files.drill) };
  // the 138.5 mm board fits the 150×100 blank at the corner (7.5 mm of play) …
  const atCorner = runPipeline({ ...input, config: { stock: { sizeX: 150, sizeY: 100 } } });
  assert.ok(atCorner.checks.messages.some((m) => m.level === 'ok' && /passt auf den Rohling/i.test(m.text)));
  // … but not when dragged 10 mm to the right
  const displaced = runPipeline({
    ...input,
    config: { stock: { sizeX: 150, sizeY: 100 }, placement: { offsetX: 10, offsetY: 0 } },
  });
  assert.ok(displaced.checks.messages.some((m) => m.level === 'error' && /passt NICHT/i.test(m.text) && /Versatz/i.test(m.text)));
});

test('report mentions the vacuum automation (result tab)', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const input = { copper: read(files.copper), edge: read(files.edge), drill: read(files.drill) };
  const on = runPipeline({ ...input });
  assert.match(on.report, /Absaugung.*M851.*10 s Nachlauf.*M852/s);
  const off = runPipeline({ ...input, config: { vacuum: { enable: false } } });
  assert.doesNotMatch(off.report, /M851/);
});

test('throws without a copper layer', () => {
  assert.throws(() => runPipeline({ copper: null }), /copper/i);
});
