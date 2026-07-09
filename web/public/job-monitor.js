// Live execution monitor for machine jobs — a pure, unit-testable state
// machine in the style of machine-commands.js (no DOM, no network). The UI
// feeds it /api/machine/status snapshots; it answers with the job state.
//
// Firmware semantics it encodes (verified in MakeraInc/CarveraFirmware):
//
//   * Machine states (src/libs/Kernel.cpp get_state()/get_query_string():
//     lines 228–286): Idle / Run / Home / Hold ('!' feed hold) /
//     Pause (suspend) / Wait / Tool / Alarm / Sleep.
//   * M6 T<n> on the Carvera Air (no ATC → "Manual Tool Change" branch,
//     src/modules/tools/atc/ATCHandler.cpp:1925–1951): prints "Please change
//     the tool to: T<n>", queues fill_change_scripts() (ATCHandler.cpp:126) —
//     G53 G0 Z<clearance> · G53 G0 X/Y<change position> · M497.2 · M490.1.
//     M490.1 (manual branch, ATCHandler.cpp:2027–2032) enters the TOOL wait
//     state (Kernel set_tool_waiting(true)) and starts the beeper. The status
//     string is then "<Tool|...>" and the T field carries the TARGET tool as
//     3rd value (Kernel.cpp:410, manual branch: "T:<active>,<tlo>,<target>").
//   * Resume = leave the TOOL wait: the machine's main button
//     (MainButton.cpp:288–291) or M490.2 (manual branch, ATCHandler.cpp:
//     2033–2037 → set_tool_waiting(false)) — the community controller's
//     tool-change popup sends exactly M490.2 (Controller.py change()).
//     Afterwards the queued scripts continue: M493.2 T<n> (set tool number)
//     + TLO calibration, then "Done ATC" and the file playback resumes.
//   * End of a played file: Player prints "Done printing file"
//     (src/modules/utils/player/Player.cpp:749) and the state returns to
//     Idle; the "P:" progress field disappears from the status (Player
//     on_get_public_data only reports progress while playing_file is true).
import { VACUUM_ON_COMMAND, VACUUM_OFF_COMMAND, VACUUM_LINGER_DEFAULT_S } from './machine-commands.js';

export const RESUME_TOOL_CHANGE_COMMAND = 'M490.2';

// Controlled job stop from the TOOL wait: abort the file playback (console
// command, Player.cpp abort_command) and clear the tool-wait state.
export const ABORT_JOB_COMMANDS = ['abort', RESUME_TOOL_CHANGE_COMMAND];

export const JOB_STATE = {
  IDLE: 'idle', // no job being monitored
  STARTING: 'starting', // play/command sent, waiting for the machine to pick it up
  RUNNING: 'running',
  WAITING_TOOL: 'waitingToolChange', // machine at the change position, beeping
  PAUSED: 'paused', // Hold / Pause (suspend) / Wait
  DONE: 'done',
  FAILED: 'failed',
};

// How long a monitored command may stay Idle before we call it done ('command'
// mode: e.g. M493.2 causes no motion at all) or failed ('play' mode: the file
// never started).
const QUICK_DONE_MS = 4000;
const START_TIMEOUT_MS = 30000;
// Consecutive Idle samples required before "Run → Idle" counts as finished
// (bridges single Idle samples between deferred firmware moves).
const IDLE_DONE_STREAK = 2;

const DONE_PRINTING_RE = /done printing file/i;
const PLAYING_RE = /^playing\s/i;
const CHANGE_TOOL_RE = /please change the tool to:\s*T(-?\d+)/i;
const ALARM_LINE_RE = /^(error|alarm|halt)\b|ALARM:|error:|Reset to continue|limit|soft ?limit|hard ?limit|Probe fail|Emergency/i;

export class JobMonitor {
  // mode: 'play' (uploaded .nc file started with `play`) or 'command'
  // (a machine action like M495 Config & Run / M496.3 / M493.2).
  constructor({ mode = 'play', now = () => Date.now(), startTimeoutMs = START_TIMEOUT_MS, quickDoneMs = QUICK_DONE_MS } = {}) {
    this.mode = mode;
    this.now = now;
    this.startTimeoutMs = startTimeoutMs;
    this.quickDoneMs = quickDoneMs;
    this.state = JOB_STATE.IDLE;
    this.targetTool = null;
    this.failure = null; // { reason, message }
    this.name = null;
    this._startedAt = 0;
    this._sawRun = false;
    this._sawPlayField = false;
    this._idleStreak = 0;
    this._prevLog = [];
  }

  get active() {
    return this.state === JOB_STATE.STARTING || this.state === JOB_STATE.RUNNING
      || this.state === JOB_STATE.WAITING_TOOL || this.state === JOB_STATE.PAUSED;
  }

  start(name = null) {
    this.state = JOB_STATE.STARTING;
    this.name = name;
    this.targetTool = null;
    this.failure = null;
    this._startedAt = this.now();
    this._sawRun = false;
    this._sawPlayField = false;
    this._idleStreak = 0;
    return [{ type: 'state', state: this.state, prev: JOB_STATE.IDLE }];
  }

  // Deliberate user abort (e.g. from the tool-change overlay): the machine
  // will return to Idle after `abort`, which must NOT count as "done".
  cancel() {
    if (!this.active) return [];
    const prev = this.state;
    this.failure = { reason: 'cancelled', message: null };
    this.state = JOB_STATE.FAILED;
    return [{ type: 'state', state: this.state, prev, failure: this.failure }];
  }

  // Only NEW lines matter; the server log is a sliding window, so diff by
  // locating the previously-last line (same approach the desktop toast
  // surfacing uses).
  _newLines(log) {
    const lines = Array.isArray(log) ? log : [];
    const prev = this._prevLog;
    this._prevLog = lines.slice();
    if (!prev.length) return lines;
    const lastPrev = prev[prev.length - 1];
    const idx = lines.lastIndexOf(lastPrev);
    return idx >= 0 ? lines.slice(idx + 1) : lines;
  }

  _transition(next, events, info) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    events.push({ type: 'state', state: next, prev, ...(info || {}) });
  }

  // snapshot: { connected, status, log } — status is the parsed machine
  // status (state / tool / play arrays), log the rolling log line array.
  update(snapshot = {}) {
    const events = [];
    const newLines = this._newLines(snapshot.log);
    if (!this.active) return events;

    const { connected = true, status = null } = snapshot;
    const st = status?.state || null;

    // Target tool: manual-tool-change status carries it as T[2]; the log line
    // "Please change the tool to: T<n>" is the fallback (and arrives first).
    for (const line of newLines) {
      const m = CHANGE_TOOL_RE.exec(line);
      if (m) this.targetTool = Number(m[1]);
    }
    if (st === 'Tool' && status?.tool && status.tool.length > 2 && Number.isFinite(status.tool[2])) {
      this.targetTool = status.tool[2];
    }

    const alarmLine = newLines.find((l) => ALARM_LINE_RE.test(String(l).trim()));
    const donePrinting = newLines.some((l) => DONE_PRINTING_RE.test(l));
    if (newLines.some((l) => PLAYING_RE.test(String(l).trim()))) this._sawRun = true;
    if (status?.play && status.play.length) this._sawPlayField = true;

    if (!connected) {
      this.failure = { reason: 'disconnected', message: null };
      this._transition(JOB_STATE.FAILED, events, { failure: this.failure });
      return events;
    }
    if (st === 'Alarm' || st === 'Halt' || st === 'Sleep') {
      this.failure = { reason: 'alarm', message: alarmLine || null };
      this._transition(JOB_STATE.FAILED, events, { failure: this.failure });
      return events;
    }

    // "Done printing file" is authoritative — the play finished, whatever the
    // momentary state sample says (Player.cpp:749).
    if (this.mode === 'play' && donePrinting) {
      this._transition(JOB_STATE.DONE, events);
      return events;
    }

    if (st === 'Tool') {
      this._sawRun = true;
      this._idleStreak = 0;
      this._transition(JOB_STATE.WAITING_TOOL, events, { targetTool: this.targetTool });
      return events;
    }
    if (st === 'Hold' || st === 'Pause' || st === 'Wait') {
      this._sawRun = true;
      this._idleStreak = 0;
      this._transition(JOB_STATE.PAUSED, events);
      return events;
    }
    if (st === 'Run' || st === 'Home') {
      this._sawRun = true;
      this._idleStreak = 0;
      this._transition(JOB_STATE.RUNNING, events);
      return events;
    }

    if (st === 'Idle') {
      this._idleStreak++;
      const elapsed = this.now() - this._startedAt;
      if (this._sawRun) {
        // Play mode: the P (progress) field vanishing is the robust "file no
        // longer playing" signal; require an Idle streak otherwise so single
        // Idle samples between deferred moves don't end the job early.
        const playFieldGone = this._sawPlayField && !(status?.play && status.play.length);
        if (playFieldGone || this._idleStreak >= IDLE_DONE_STREAK) {
          this._transition(JOB_STATE.DONE, events);
        }
      } else if (this.mode === 'command' && elapsed >= this.quickDoneMs) {
        // command without visible motion (e.g. M493.2 T0) — accepted as done
        this._transition(JOB_STATE.DONE, events);
      } else if (this.mode === 'play' && elapsed >= this.startTimeoutMs) {
        this.failure = { reason: 'not-started', message: null };
        this._transition(JOB_STATE.FAILED, events, { failure: this.failure });
      }
      return events;
    }

    return events;
  }
}

// --- app-side vacuum automation plan (external port, M851/M852) -------------
// The generated G-code switches the external vacuum port itself (preamble /
// footer, src/cam/gcode.js) — this plan is the safety net AROUND the job
// monitor: it turns the port on at job start (also for files generated
// elsewhere), optionally off/on around the M6 tool wait, and — crucially —
// off after DONE/FAILED/abort with the configured run-on, because a failed or
// aborted job never reaches the file's own M852.
//
// Pure function: takes one monitor state event ({ state, prev }), the vacuum
// settings ({ enable, lingerSec, pauseToolChange, laser }) and the job kind
// ('mill' | 'laser' | 'command'). Returns { commands, delayS } or null.
// delayS > 0 = send after the run-on delay (caller schedules the timeout and
// cancels it when a new job starts or the port is switched on again).
export function planVacuumForTransition(event, settings, jobKind = 'mill') {
  if (!settings || !settings.enable) return null;
  if (jobKind === 'command') return null; // M495/M496 etc. — no cutting, no dust
  if (jobKind === 'laser' && settings.laser === false) return null;
  const { state, prev } = event || {};
  const on = { commands: [VACUUM_ON_COMMAND], delayS: 0 };
  if (state === JOB_STATE.STARTING) return on;
  if (state === JOB_STATE.WAITING_TOOL) {
    return settings.pauseToolChange ? { commands: [VACUUM_OFF_COMMAND], delayS: 0 } : null;
  }
  if (state === JOB_STATE.RUNNING && prev === JOB_STATE.WAITING_TOOL) {
    return settings.pauseToolChange ? on : null;
  }
  if (state === JOB_STATE.DONE || state === JOB_STATE.FAILED) {
    const linger = Math.max(0, Number(settings.lingerSec ?? VACUUM_LINGER_DEFAULT_S));
    return { commands: [VACUUM_OFF_COMMAND], delayS: linger };
  }
  return null;
}

// True when the raw machine status says "M6 wartet auf den Werkzeugwechsel" —
// used by the UI overlay independently of a monitored job (a tool change in
// the middle of 0_full_job.nc must pop the overlay too).
export function isToolChangeWait(status) {
  return status?.state === 'Tool';
}

// Target tool number from a manual-tool-change status (T:<active>,<tlo>,<target>).
export function toolChangeTarget(status) {
  const t = status?.tool;
  if (t && t.length > 2 && Number.isFinite(t[2])) return t[2];
  return null;
}
