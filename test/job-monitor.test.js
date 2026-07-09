import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus } from '../src/machine.js';
import {
  JobMonitor,
  JOB_STATE,
  RESUME_TOOL_CHANGE_COMMAND,
  ABORT_JOB_COMMANDS,
  isToolChangeWait,
  toolChangeTarget,
  planVacuumForTransition,
} from '../web/public/job-monitor.js';
import { VACUUM_ON_COMMAND, VACUUM_OFF_COMMAND } from '../web/public/machine-commands.js';

// Build a status like the Carvera Air (manual tool change) sends:
// pipe format, T carries active,tlo,target — P carries lines,percent,secs.
const st = (state, { tool, play } = {}) => parseStatus(
  `<${state}|MPos:-100.0,-100.0,-3.0|WPos:0.0,0.0,17.0|F:0,0,100`
  + (tool ? `|T:${tool}` : '')
  + (play ? `|P:${play}` : '')
  + '>',
);

function makeMonitor(mode = 'play') {
  let t = 0;
  const mon = new JobMonitor({ mode, now: () => t, startTimeoutMs: 30000, quickDoneMs: 4000 });
  return { mon, tick: (ms) => { t += ms; } };
}

test('resume/abort commands match the verified firmware semantics', () => {
  // M490.2 exits the manual tool-change wait (ATCHandler.cpp:2033-2037);
  // the community controller's tool-change popup sends exactly this.
  assert.equal(RESUME_TOOL_CHANGE_COMMAND, 'M490.2');
  assert.deepEqual(ABORT_JOB_COMMANDS, ['abort', 'M490.2']);
});

test('happy path: starting → running → done via "Done printing file"', () => {
  const { mon } = makeMonitor();
  mon.start('1_isolation.nc');
  assert.equal(mon.state, JOB_STATE.STARTING);

  mon.update({ connected: true, status: st('Idle'), log: ['Playing /sd/gcodes/1_isolation.nc'] });
  mon.update({ connected: true, status: st('Run', { play: '10,3,5' }), log: [] });
  assert.equal(mon.state, JOB_STATE.RUNNING);

  const ev = mon.update({ connected: true, status: st('Idle'), log: ['Done printing file'] });
  assert.equal(mon.state, JOB_STATE.DONE);
  assert.ok(ev.some((e) => e.type === 'state' && e.state === JOB_STATE.DONE));
});

test('run → idle with the play field gone counts as done (no log line needed)', () => {
  const { mon } = makeMonitor();
  mon.start('4_outline.nc');
  mon.update({ connected: true, status: st('Run', { play: '10,50,60' }), log: [] });
  mon.update({ connected: true, status: st('Idle'), log: [] }); // P field vanished
  assert.equal(mon.state, JOB_STATE.DONE);
});

test('single Idle sample between deferred moves does NOT finish a command job', () => {
  const { mon } = makeMonitor('command');
  mon.start('M496.3');
  mon.update({ connected: true, status: st('Run'), log: [] });
  mon.update({ connected: true, status: st('Idle'), log: [] });
  assert.equal(mon.state, JOB_STATE.RUNNING); // needs an Idle streak
  mon.update({ connected: true, status: st('Idle'), log: [] });
  assert.equal(mon.state, JOB_STATE.DONE);
});

test('motionless command (M493.2 T0) becomes done after the quick-done window', () => {
  const { mon, tick } = makeMonitor('command');
  mon.start('M493.2 T0');
  mon.update({ connected: true, status: st('Idle'), log: [] });
  assert.equal(mon.state, JOB_STATE.STARTING);
  tick(4500);
  mon.update({ connected: true, status: st('Idle'), log: ['ok'] });
  assert.equal(mon.state, JOB_STATE.DONE);
});

test('play that never starts fails after the start timeout', () => {
  const { mon, tick } = makeMonitor('play');
  mon.start('1_isolation.nc');
  tick(31000);
  mon.update({ connected: true, status: st('Idle'), log: [] });
  assert.equal(mon.state, JOB_STATE.FAILED);
  assert.equal(mon.failure.reason, 'not-started');
});

test('M6 wait: Tool state → waitingToolChange with the target tool from T[2]', () => {
  const { mon } = makeMonitor();
  mon.start('1_isolation.nc');
  // real sequence from the user's machine log: Playing …, G53 moves, M497.2, M490.1
  mon.update({
    connected: true,
    status: st('Run', { play: '3,0,1' }),
    log: ['Playing /sd/gcodes/1_isolation.nc', 'G53 G0 Z-3.000', 'ok'],
  });
  const ev = mon.update({
    connected: true,
    status: st('Tool', { tool: '6,12.5,1', play: '5,0,2' }),
    log: ['G53 G0 X-30.310 Y-4.643', 'ok', 'M497.2', 'ok', 'M490.1', 'ok'],
  });
  assert.equal(mon.state, JOB_STATE.WAITING_TOOL);
  assert.equal(mon.targetTool, 1);
  assert.ok(ev.some((e) => e.state === JOB_STATE.WAITING_TOOL && e.targetTool === 1));
});

test('M6 wait: target tool falls back to the "Please change the tool to: T…" log line', () => {
  const { mon } = makeMonitor();
  mon.start('0_full_job.nc');
  mon.update({ connected: true, status: st('Run', { play: '2,0,1' }), log: ['Please change the tool to: T7'] });
  mon.update({ connected: true, status: st('Tool', { tool: '1,10.0' }), log: [] });
  assert.equal(mon.state, JOB_STATE.WAITING_TOOL);
  assert.equal(mon.targetTool, 7);
});

test('after the tool-change confirm the job keeps running and finishes normally', () => {
  const { mon } = makeMonitor();
  mon.start('0_full_job.nc');
  mon.update({ connected: true, status: st('Run', { play: '2,0,1' }), log: ['Playing /sd/gcodes/0_full_job.nc'] });
  mon.update({ connected: true, status: st('Tool', { tool: '1,10.0,7' }), log: ['M490.1', 'ok'] });
  assert.equal(mon.state, JOB_STATE.WAITING_TOOL);
  // user confirms → TLO measurement runs (Run), then milling continues
  mon.update({ connected: true, status: st('Run', { play: '6,10,30' }), log: ['M493.2 T7', 'Done ATC'] });
  assert.equal(mon.state, JOB_STATE.RUNNING);
  // second M6 later in the combined job → overlay again with the NEW tool
  mon.update({ connected: true, status: st('Tool', { tool: '7,9.1,3' }), log: ['Please change the tool to: T3'] });
  assert.equal(mon.state, JOB_STATE.WAITING_TOOL);
  assert.equal(mon.targetTool, 3);
  mon.update({ connected: true, status: st('Run', { play: '80,90,600' }), log: ['Done ATC'] });
  mon.update({ connected: true, status: st('Idle'), log: ['Done printing file'] });
  assert.equal(mon.state, JOB_STATE.DONE);
});

test('alarm during a run fails the job with the alarm line as message', () => {
  const { mon } = makeMonitor();
  mon.start('1_isolation.nc');
  mon.update({ connected: true, status: st('Run', { play: '2,0,1' }), log: [] });
  const ev = mon.update({ connected: true, status: st('Alarm'), log: ['ALARM: Soft Endstop X was exceeded'] });
  assert.equal(mon.state, JOB_STATE.FAILED);
  assert.equal(mon.failure.reason, 'alarm');
  assert.match(mon.failure.message, /Soft Endstop/);
  assert.ok(ev.some((e) => e.state === JOB_STATE.FAILED));
});

test('pause (Hold) is reported but does not end the job', () => {
  const { mon } = makeMonitor();
  mon.start('1_isolation.nc');
  mon.update({ connected: true, status: st('Run', { play: '2,0,1' }), log: [] });
  mon.update({ connected: true, status: st('Hold'), log: [] });
  assert.equal(mon.state, JOB_STATE.PAUSED);
  mon.update({ connected: true, status: st('Run', { play: '5,20,60' }), log: [] });
  assert.equal(mon.state, JOB_STATE.RUNNING);
});

test('connection loss fails the job', () => {
  const { mon } = makeMonitor();
  mon.start('1_isolation.nc');
  mon.update({ connected: true, status: st('Run', { play: '2,0,1' }), log: [] });
  mon.update({ connected: false, status: null, log: [] });
  assert.equal(mon.state, JOB_STATE.FAILED);
  assert.equal(mon.failure.reason, 'disconnected');
});

test('log diffing only reacts to NEW lines (sliding window)', () => {
  const { mon } = makeMonitor();
  mon.start('2_drill.nc');
  const logA = ['Playing /sd/gcodes/2_drill.nc', 'ok'];
  mon.update({ connected: true, status: st('Run', { play: '2,0,1' }), log: logA });
  // same window again + one alarm line appended → only the alarm is new
  mon.update({ connected: true, status: st('Alarm'), log: [...logA, 'ALARM: Probe fail'] });
  assert.equal(mon.state, JOB_STATE.FAILED);
  assert.match(mon.failure.message, /Probe fail/);
});

test('cancel() fails the job so the following Idle does not count as done', () => {
  const { mon } = makeMonitor();
  mon.start('0_full_job.nc');
  mon.update({ connected: true, status: st('Tool', { tool: '1,10.0,7' }), log: [] });
  assert.equal(mon.state, JOB_STATE.WAITING_TOOL);
  const ev = mon.cancel();
  assert.equal(mon.state, JOB_STATE.FAILED);
  assert.equal(mon.failure.reason, 'cancelled');
  assert.ok(ev.some((e) => e.state === JOB_STATE.FAILED));
  // machine aborts and goes Idle — no further transitions
  assert.deepEqual(mon.update({ connected: true, status: st('Idle'), log: ['Abort from ATC'] }), []);
});

test('isToolChangeWait / toolChangeTarget read the raw status (for the overlay)', () => {
  assert.equal(isToolChangeWait(st('Tool', { tool: '6,12.5,1' })), true);
  assert.equal(isToolChangeWait(st('Run')), false);
  assert.equal(toolChangeTarget(st('Tool', { tool: '6,12.5,1' })), 1);
  assert.equal(toolChangeTarget(st('Tool', { tool: '6,12.5' })), null);
});

// --- app-side vacuum automation plan (M851/M852) ----------------------------

const VAC = { enable: true, lingerSec: 10, pauseToolChange: false, laser: true };

test('vacuum plan: on at job start, delayed off (run-on) at done/failed', () => {
  const start = planVacuumForTransition({ state: JOB_STATE.STARTING, prev: JOB_STATE.IDLE }, VAC, 'mill');
  assert.deepEqual(start, { commands: [VACUUM_ON_COMMAND], delayS: 0 });
  const done = planVacuumForTransition({ state: JOB_STATE.DONE, prev: JOB_STATE.RUNNING }, VAC, 'mill');
  assert.deepEqual(done, { commands: [VACUUM_OFF_COMMAND], delayS: 10 });
  // FAILED/abort must also switch off — the file's own M852 never ran
  const failed = planVacuumForTransition({ state: JOB_STATE.FAILED, prev: JOB_STATE.RUNNING }, { ...VAC, lingerSec: 3 }, 'mill');
  assert.deepEqual(failed, { commands: [VACUUM_OFF_COMMAND], delayS: 3 });
});

test('vacuum plan: tool-change pause is opt-in', () => {
  const wait = { state: JOB_STATE.WAITING_TOOL, prev: JOB_STATE.RUNNING };
  const resume = { state: JOB_STATE.RUNNING, prev: JOB_STATE.WAITING_TOOL };
  assert.equal(planVacuumForTransition(wait, VAC, 'mill'), null);
  assert.equal(planVacuumForTransition(resume, VAC, 'mill'), null);
  const pausing = { ...VAC, pauseToolChange: true };
  assert.deepEqual(planVacuumForTransition(wait, pausing, 'mill'), { commands: [VACUUM_OFF_COMMAND], delayS: 0 });
  assert.deepEqual(planVacuumForTransition(resume, pausing, 'mill'), { commands: [VACUUM_ON_COMMAND], delayS: 0 });
});

test('vacuum plan: command jobs and disabled automation never switch the port', () => {
  const start = { state: JOB_STATE.STARTING, prev: JOB_STATE.IDLE };
  assert.equal(planVacuumForTransition(start, VAC, 'command'), null); // M495 & co
  assert.equal(planVacuumForTransition(start, { ...VAC, enable: false }, 'mill'), null);
  assert.equal(planVacuumForTransition(start, null, 'mill'), null);
});

test('vacuum plan: laser jobs respect the laser switch', () => {
  const start = { state: JOB_STATE.STARTING, prev: JOB_STATE.IDLE };
  assert.deepEqual(planVacuumForTransition(start, VAC, 'laser'), { commands: [VACUUM_ON_COMMAND], delayS: 0 });
  assert.equal(planVacuumForTransition(start, { ...VAC, laser: false }, 'laser'), null);
});
