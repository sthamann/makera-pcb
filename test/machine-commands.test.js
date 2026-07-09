import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus } from '../src/machine.js';
import {
  ANCHOR1_OFFSET,
  SAFE_Z_MACHINE,
  gotoWorkXYCommands,
  gotoWorkOriginCommands,
  gotoAnchor1Command,
  setOriginAtAnchorOffsetCommands,
  anchor1Readiness,
  workCoordOffset,
  originIsSet,
  levelingGrid,
  zProbeCommand,
  scanMarginCommand,
  autoLevelCommand,
  configAndRunCommand,
  insertProbeCommand,
  notHomedFromStatus,
  LEVELING_GRID_MIN,
  LEVELING_GRID_MAX,
  VACUUM_ON_COMMAND,
  VACUUM_OFF_COMMAND,
  VACUUM_LINGER_DEFAULT_S,
} from '../web/public/machine-commands.js';

test('gotoWorkXYCommands raises Z in machine coords first, then moves absolute in the WCS', () => {
  assert.deepEqual(gotoWorkXYCommands(10, 15), [
    `G53 G0 Z${SAFE_Z_MACHINE}`,
    'G90 G0 X10 Y15',
  ]);
});

test('gotoWorkXYCommands accepts a single axis and rounds to 3 decimals', () => {
  assert.deepEqual(gotoWorkXYCommands(NaN, 15.00049), [
    `G53 G0 Z${SAFE_Z_MACHINE}`,
    'G90 G0 Y15',
  ]);
  assert.deepEqual(gotoWorkXYCommands(1.23456, undefined), [
    `G53 G0 Z${SAFE_Z_MACHINE}`,
    'G90 G0 X1.235',
  ]);
});

test('gotoWorkXYCommands returns no commands without a finite axis', () => {
  assert.deepEqual(gotoWorkXYCommands(NaN, NaN), []);
  assert.deepEqual(gotoWorkXYCommands(undefined, undefined), []);
});

test('gotoWorkOriginCommands targets work X0/Y0 (not machine coordinates)', () => {
  assert.deepEqual(gotoWorkOriginCommands(), [
    `G53 G0 Z${SAFE_Z_MACHINE}`,
    'G90 G0 X0 Y0',
  ]);
});

test('anchor-1 origin: phase 1 is the firmware anchor move (M496.3) alone', () => {
  // Verified on a real machine: the board corner sits ON anchor 1, so the work
  // origin is set AT anchor 1 with NO extra offset (a former X15/Y10 shifted
  // every job 15/10 onto the board).
  assert.deepEqual(ANCHOR1_OFFSET, { x: 0, y: 0 });
  // NOTHING may follow M496.3 in the same batch: the firmware executes the
  // move deferred on its main loop, so any immediate follow-up motion races
  // it (the old G91 X15 Y10 tripped "Soft Endstop X was exceeded").
  assert.equal(gotoAnchor1Command(), 'M496.3');
});

test('anchor-1 origin: phase 2 sets the origin via G10 L20 without any motion', () => {
  // "Current position (= anchor 1) is work 0/0" → WPos 0/0 lands ON anchor 1 =
  // the blank/board corner. No G0/G91 involved, so no soft-endstop risk.
  assert.deepEqual(setOriginAtAnchorOffsetCommands(), [
    'G90',
    'G10 L20 P0 X0 Y0',
  ]);
  // Still parameterisable for a custom fixture offset.
  assert.deepEqual(setOriginAtAnchorOffsetCommands({ x: 20, y: 5 }), [
    'G90',
    'G10 L20 P0 X-20 Y-5',
  ]);
});

test('anchor-1 readiness blocks alarm / homing / busy / disconnected states', () => {
  const st = (state) => parseStatus(`<${state},MPos:-10.000,-20.000,-3.000,WPos:-10.000,-20.000,-3.000,F:0,0,100>`);
  assert.deepEqual(anchor1Readiness(st('Idle')), { ok: true, reason: null });
  assert.deepEqual(anchor1Readiness(st('Alarm')), { ok: false, reason: 'alarm' });
  assert.deepEqual(anchor1Readiness(st('Halt')), { ok: false, reason: 'alarm' });
  assert.deepEqual(anchor1Readiness(st('Home')), { ok: false, reason: 'homing' });
  assert.deepEqual(anchor1Readiness(st('Run')), { ok: false, reason: 'busy' });
  assert.deepEqual(anchor1Readiness(st('Hold')), { ok: false, reason: 'busy' });
  assert.deepEqual(anchor1Readiness(st('Idle'), false), { ok: false, reason: 'not-connected' });
  assert.deepEqual(anchor1Readiness(null), { ok: false, reason: 'no-status' });
});

test('workCoordOffset derives WCO = MPos - WPos from a parsed status', () => {
  const s = parseStatus('<Idle,MPos:-345.000,-190.000,-3.000,WPos:0.000,0.000,17.000,F:0,0,100>');
  assert.deepEqual(workCoordOffset(s), { x: -345, y: -190, z: -20 });
});

test('originIsSet is true once WPos and MPos diverge (origin was set)', () => {
  const s = parseStatus('<Idle,MPos:-345.000,-190.000,-3.000,WPos:0.000,0.000,0.000,F:0,0,100>');
  assert.equal(originIsSet(s), true);
});

test('originIsSet is false when WPos equals MPos (no workpiece origin, machine corner rules)', () => {
  const s = parseStatus('<Idle,MPos:-10.000,-20.000,-3.000,WPos:-10.000,-20.000,-3.000,F:0,0,100>');
  assert.equal(originIsSet(s), false);
});

test('originIsSet is null when the status carries no usable positions', () => {
  assert.equal(originIsSet(null), null);
  assert.equal(originIsSet({}), null);
  assert.equal(originIsSet(parseStatus('<Idle,MPos:-1.000,-2.000,-3.000>')), null);
});

// --- M495 automation builders ------------------------------------------------

test('REGRESSION: the workpiece Z probe always carries O AND F', () => {
  // Firmware 1.0.6 (ATCHandler.cpp:2441-2449): `O` WITHOUT `F` selects the
  // 4th-axis ABSOLUTE probe, which sets work Z0 ~23 mm BELOW the touched
  // surface (rotation_offset_z) — this exact omission once milled straight
  // through a 1.5 mm PCB. O0 F0 = probe at the work origin ON the board.
  assert.equal(zProbeCommand(), 'M495 X0 Y0 O0 F0 P1');
  assert.match(configAndRunCommand(100, 50), /\bO0 F0\b/);
  assert.doesNotMatch(configAndRunCommand(100, 50), /\bO0 (?!F)/);
});

test('configAndRunCommand builds the full Makera Config & Run', () => {
  assert.equal(
    configAndRunCommand(138.5, 30),
    'M495 X0 Y0 C138.5 D30 O0 F0 A138.5 B30 I9 J5 H2 P1',
  );
});

test('M495 builders shift onto the board area for a placement offset', () => {
  const off = { x: 20, y: 10.5 };
  // Z probe: the offset moves the probe point via X/Y; O0 F0 stays — BOTH
  // letters keep the firmware in the workpiece-probe branch.
  assert.equal(zProbeCommand(off), 'M495 X20 Y10.5 O0 F0 P1');
  // Margin: X/Y = start corner, C/D = ABSOLUTE max corner (fill_margin_scripts
  // x_pos_max/y_pos_max) → offset + board size, not just the size.
  assert.equal(scanMarginCommand(138.5, 30, off), 'M495 X20 Y10.5 C158.5 D40.5');
  // Leveling: the grid starts at X/Y (G32 R1 uses the current position,
  // CartGridStrategy.cpp:527-547), A/B stay the SIZE of the area.
  assert.equal(autoLevelCommand(138.5, 30, { i: 9, j: 5 }, off), 'M495 X20 Y10.5 A138.5 B30 I9 J5 H2');
  // Config & Run combines everything — offset in X/Y/C/D, O0 F0 untouched.
  assert.equal(
    configAndRunCommand(138.5, 30, { i: 9, j: 5 }, off),
    'M495 X20 Y10.5 C158.5 D40.5 O0 F0 A138.5 B30 I9 J5 H2 P1',
  );
});

test('vacuum commands match the Air external-output switch (firmware-verified)', () => {
  // switch.extendout = external control port, pin 2.2 hwpwm — M851 on /
  // M852 off (MakeraInc/CarveraFirmware src/config2.default:173-177). The
  // Air's internal-vacuum switch (M801/M802) has output_pin nc — useless for
  // an external air cleaner.
  assert.equal(VACUUM_ON_COMMAND, 'M851');
  assert.equal(VACUUM_OFF_COMMAND, 'M852');
  assert.ok(VACUUM_LINGER_DEFAULT_S > 0, 'default run-on is a positive number of seconds');
});

test('levelingGrid clamps to the firmware limits (>= 5x5, <= 9x9)', () => {
  assert.deepEqual(levelingGrid(138.5, 30), { i: 9, j: 5 }); // the real board
  assert.deepEqual(levelingGrid(10, 10), { i: LEVELING_GRID_MIN, j: LEVELING_GRID_MIN });
  assert.deepEqual(levelingGrid(500, 500), { i: LEVELING_GRID_MAX, j: LEVELING_GRID_MAX });
});

test('notHomedFromStatus flags positive MPos (reset without homing, incident screenshot)', () => {
  // homed machines sit at/below the -1 mm soft-endstop maximum (Robot.cpp:345)
  const homed = parseStatus('<Idle|MPos:-273.3100,-190.6400,-85.4500,0.0000,0.0000|WPos:0.0000,0.0000,0.0000,0.0000,0.0000|F:0,0,100>');
  assert.equal(notHomedFromStatus(homed), false);
  // the real post-incident state: MPos 0 / 116 / 63 with absurd WPos
  const unhomed = parseStatus('<Idle|MPos:0.0000,116.0000,63.0000,0.0000,0.0000|WPos:280.3100,300.6430,171.4500,-30.0000,0.0000|F:0,0,100>');
  assert.equal(notHomedFromStatus(unhomed), true);
  assert.equal(notHomedFromStatus(null), null);
  assert.equal(notHomedFromStatus({}), null);
});

test('insertProbeCommand: real M6 T0 change (with TLO calibration), M491 when already T0', () => {
  // M6 T0 runs fill_change_scripts + fill_cali_scripts(is_probe) — the probe
  // MUST be measured so ref_tool_mz is valid for the next tool's TLO.
  assert.equal(insertProbeCommand(1), 'M6 T0');
  assert.equal(insertProbeCommand(null), 'M6 T0');
  // M6 T0 with active_tool == 0 is a no-op in the firmware → recalibrate.
  assert.equal(insertProbeCommand(0), 'M491');
});
