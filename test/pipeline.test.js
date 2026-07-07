import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/pipeline.js';

const gerberDir = fileURLToPath(new URL('../../platine/gerbers/', import.meta.url));
const files = {
  copper: gerberDir + 'i2c_bus_board-F_Cu.gbr',
  edge: gerberDir + 'i2c_bus_board-Edge_Cuts.gbr',
  drill: gerberDir + 'i2c_bus_board.drl',
};
const havePlatine = fs.existsSync(files.copper);

test('end-to-end on the real i2c board', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const result = runPipeline({
    copper: read(files.copper),
    edge: read(files.edge),
    drill: read(files.drill),
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
  assert.match(combined, /M2\n$/);
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

test('stock fit check flags a board that is too large for the blank', { skip: !havePlatine }, () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const tooSmall = runPipeline({
    copper: read(files.copper), edge: read(files.edge), drill: read(files.drill),
    config: { stock: { sizeX: 100, sizeY: 50 } }, // 138.5mm board does not fit
  });
  assert.ok(tooSmall.checks.messages.some((m) => m.level === 'error' && /passt NICHT/i.test(m.text)));

  const fits = runPipeline({
    copper: read(files.copper), edge: read(files.edge), drill: read(files.drill),
    config: { stock: { sizeX: 150, sizeY: 100 } },
  });
  assert.ok(fits.checks.messages.some((m) => /passt auf den Rohling/i.test(m.text)));
});

test('throws without a copper layer', () => {
  assert.throws(() => runPipeline({ copper: null }), /copper/i);
});
