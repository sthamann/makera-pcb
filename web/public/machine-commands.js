// Pure command builders + coordinate helpers for the Carvera machine control.
//
// Kept free of DOM/network access so the coordinate logic is unit-testable
// (test/machine-commands.test.js). All motion commands follow the semantics of
// the official Makera firmware (MakeraInc/CarveraFirmware) / community
// controller:
//
//   * The machine's BUILT-IN zero (MPos 0/0/0) is the homing reference corner
//     at the TOP RIGHT (X-max/Y-max/Z-max). All machine coordinates are
//     negative from there — the soft-endstop MAXIMUM is -1 mm per axis
//     (Robot.cpp), so any commanded move above that halts the machine with
//     "Soft Endstop … was exceeded".
//   * The WORKPIECE origin (WPos 0/0) only exists after "set origin"
//     (G10 L20 P0). G90 G0 moves run in that active work coordinate system.
//   * M496.x (ATCHandler.cpp) records the request and executes the motion
//     ASYNCHRONOUSLY on the firmware main loop: .1 = goto clearance/park,
//     .2 = goto work origin, .3 = goto anchor 1 (machine-coordinate position
//     from the firmware config), .4 = anchor 2, .5 = goto work X/Y.
//     Because the motion is deferred, a regular G-code line sent right after
//     an M496 is NOT guaranteed to run after the move — it races it. Any
//     follow-up must therefore wait until the machine is Idle again.

import { CARVERA_ANCHOR_OFFSET } from './stock-fit.js';

// Work offset of the PCB blank from anchor 1 (L-bracket corner). VERIFIED to
// be 0/0 on a real machine: the blank's bottom-left corner sits directly on
// anchor 1, so the work origin is set AT anchor 1 (no extra offset). A former
// X15/Y10 value shifted every job 15 mm/10 mm onto the board. Shared with the
// stock-fit check so placement and fit can never disagree.
export const ANCHOR1_OFFSET = CARVERA_ANCHOR_OFFSET;

// "Raise Z first" height in MACHINE coordinates: just below the Z reference
// (top). Same idea as the community controller's gotoSafeZ (G53 G0 Z-2).
export const SAFE_Z_MACHINE = -3;

// --- external vacuum / air cleaner (Carvera Air external control port) ------
//
// FIRMWARE SEMANTICS (official 1.0.6, MakeraInc/CarveraFirmware):
//
//   * The Air has NO internal vacuum: `switch.vacuum.output_pin nc` in the
//     Air config (src/config2.default:385) — M801/M802 drive the vacuum
//     switch AND the PSU fan (config2.default:130-135), but the vacuum pin
//     is not connected. An external vacuum/air cleaner hangs on the EXTERNAL
//     CONTROL PORT instead: `switch.extendout` on pin 2.2 (hwpwm), switched
//     with M851 (on, S = PWM power) / M852 (off) — config2.default:173-177.
//     (Same codes the community controller's "External Output" toggle uses.)
//   * M331.3 / M332.3 additionally toggle the firmware's extout-follows-
//     spindle mode (SimpleShell.cpp:239-252 set_extout_mode; SpindleControl
//     .cpp:83-95/115-119 opens/closes the port on M3/M5). We switch the port
//     EXPLICITLY instead so the run-on (linger) and the tool-change behaviour
//     stay configurable — a plain M331 (no subcode) would only arm the
//     unconnected internal-vacuum switch on the Air.
export const VACUUM_ON_COMMAND = 'M851';
export const VACUUM_OFF_COMMAND = 'M852';
// Default run-on after the job ends, clears dust still in the air/hose.
export const VACUUM_LINGER_DEFAULT_S = 10;

const fmt = (n) => String(Math.round(n * 1000) / 1000);

// Move to X/Y in the ACTIVE WORK coordinate system: raise Z straight up in
// machine coords first (no corner dart), then rapid absolute in the WCS.
// Returns [] when neither axis is a finite number.
export function gotoWorkXYCommands(x, y) {
  const parts = [];
  if (Number.isFinite(x)) parts.push('X' + fmt(x));
  if (Number.isFinite(y)) parts.push('Y' + fmt(y));
  if (!parts.length) return [];
  return [`G53 G0 Z${SAFE_Z_MACHINE}`, 'G90 G0 ' + parts.join(' ')];
}

// Return to the work origin (WPos X0/Y0) that was set with "set origin".
export function gotoWorkOriginCommands() {
  return gotoWorkXYCommands(0, 0);
}

// --- one-click "origin = anchor 1 + Makera offset" ---------------------------
//
// The safe sequence has TWO phases with a mandatory wait in between:
//
//   Phase 1: M496.3 — the firmware itself raises Z to its clearance height and
//            rapids to anchor 1 in machine coordinates (ATCHandler on_main_loop).
//   WAIT:    until the machine reports Idle again. M496 executes deferred, so
//            sending more motion immediately would race the anchor move — that
//            is exactly what used to trip "Soft Endstop X was exceeded" (a
//            relative X+15 from the park corner exceeds the -1 mm soft-limit
//            maximum).
//   Phase 2: G10 L20 P0 X0 Y0 — pure WCS bookkeeping, NO motion: "the current
//            position (= anchor 1) is work 0/0", which puts the work origin
//            (WPos 0/0) exactly ON anchor 1 = the blank/board corner. Z is left
//            untouched — it is set by the Z-probe / Config & Run step.
//            (ANCHOR1_OFFSET = 0/0; a former X15/Y10 shifted every job onto
//            the board — see ANCHOR1_OFFSET above.)
//
// This matches how the community controller sets the work origin (G10 offsets,
// never a relative jog) while reusing the firmware's own safe anchor move.
export function gotoAnchor1Command() {
  return 'M496.3';
}

export function setOriginAtAnchorOffsetCommands(offset = ANCHOR1_OFFSET) {
  return [
    'G90',
    `G10 L20 P0 X${fmt(-offset.x)} Y${fmt(-offset.y)}`,
  ];
}

// --- M495 automation (margin / Z probe / auto-leveling / Config & Run) ------
//
// FIRMWARE SEMANTICS (official 1.0.6, src/modules/tools/atc/ATCHandler.cpp):
//
//   * The workpiece Z probe of an M495 needs BOTH letters: `O` (X offset) AND
//     `F` (Y offset). ATCHandler.cpp:2441-2449: `O` WITHOUT `F` sets
//     zprobe_abs = true — the 4TH-AXIS ABSOLUTE probe. That branch
//     (fill_zprobe_abs_scripts, ATCHandler.cpp:397-459) probes at the fixed
//     ROTARY-MODULE position and ends with "G10 L20 P0 Z<rotation_offset_z>"
//     (Air default 23.0 mm = chuck radius, ATCHandler.cpp:1536): the work Z0
//     is placed ~23 mm BELOW the touched surface (the A-axis centreline).
//     Used on a bare bed this mills straight through any PCB — this exact
//     mistake caused a real through-cut. With `O0 F0` the firmware takes
//     fill_zprobe_scripts (ATCHandler.cpp:345-395) instead: probe AT THE WORK
//     ORIGIN on the workpiece, "G10 L20 P0 Z<probe_height>" = surface -> Z0.
//     (The community controller sends "O%g F%g" for the workpiece probe and a
//     bare "O0" only in its explicit 4th-axis mode, Controller.py autoCommand.)
//
//   * If the active tool is not the probe (T0), M495 handles the change
//     ITSELF (ATCHandler.cpp:2466-2488): "Change to probe tool first!" +
//     fill_change_scripts(0) (tool-wait the UI overlay confirms) +
//     fill_cali_scripts(true) (measures the probe on the TLO sensor). Do NOT
//     pre-set the number with M493.2 T0 — that skips the calibration and
//     leaves cur_tool_mz stale, which corrupts the next tool's TLO
//     (set_tool_offset, ATCHandler.cpp:1816-1830: tool_offset =
//     cur_tool_mz - ref_tool_mz; ref_tool_mz is snapshotted from cur_tool_mz
//     whenever a G10 ... Z... runs, Robot.cpp:577-580).
export const LEVELING_GRID_MIN = 5; // firmware needs >= 5x5 (CartGridStrategy.cpp:526)
export const LEVELING_GRID_MAX = 9;
export const LEVELING_HEIGHT_MM = 2; // Makera PCB default detection height (H)
const LEVELING_GRID_STEP_MM = 15; // ~1 probe point per 15 mm of board edge

// Grid density for a board of the given size, clamped to the firmware limits.
export function levelingGrid(widthMm, heightMm) {
  const clamp = (n) => Math.min(LEVELING_GRID_MAX, Math.max(LEVELING_GRID_MIN, Math.round(n)));
  return { i: clamp(widthMm / LEVELING_GRID_STEP_MM), j: clamp(heightMm / LEVELING_GRID_STEP_MM) };
}

// Board placement offset (drag & drop on the blank): the board's bottom-left
// corner sits at work (offset.x, offset.y) instead of the work origin. All
// M495 automation must probe/scan/level THE BOARD AREA, so the offset feeds
// the M495 letters like this (ATCHandler.cpp:2411-2506):
//   * X/Y  = path START in work coords (margin start, leveling grid start —
//            fill_autolevel_scripts moves there, then G32 R1 uses the current
//            position as grid origin, CartGridStrategy.cpp:527-547)
//   * C/D  = margin MAX corner, ABSOLUTE work coords (fill_margin_scripts
//            x_pos_max/y_pos_max) → offset + board size
//   * O/F  = Z-probe offset ADDED to X/Y (fill_zprobe_scripts probes at
//            x_pos + x_offset) → stays O0 F0: the probe lands on the board's
//            bottom-left corner. BOTH letters must be present, see above.
//   * A/B  = leveling area SIZE (unchanged by the offset)
const NO_PLACEMENT = { x: 0, y: 0 };

// Workpiece Auto-Z-probe at the board's bottom-left corner. O0 F0 — BOTH
// letters, see above; the placement offset moves the probe via X/Y.
export function zProbeCommand(offset = NO_PLACEMENT) {
  return `M495 X${fmt(offset.x)} Y${fmt(offset.y)} O0 F0 P1`;
}

// Scan margin only: trace the board outline (X/Y → C/D rectangle, no cutting).
export function scanMarginCommand(widthMm, heightMm, offset = NO_PLACEMENT) {
  return `M495 X${fmt(offset.x)} Y${fmt(offset.y)} C${fmt(offset.x + widthMm)} D${fmt(offset.y + heightMm)}`;
}

// Auto-leveling only: I×J grid over the board area starting at the offset.
export function autoLevelCommand(widthMm, heightMm, grid = levelingGrid(widthMm, heightMm), offset = NO_PLACEMENT) {
  return `M495 X${fmt(offset.x)} Y${fmt(offset.y)} A${fmt(widthMm)} B${fmt(heightMm)} I${grid.i} J${grid.j} H${LEVELING_HEIGHT_MM}`;
}

// Makera "Config and Run": scan margin (C/D) + Z probe on the board (O0 F0)
// + auto-leveling (A/B area, I/J grid, H height) + park (P1) — everything
// shifted onto the board area via the placement offset.
export function configAndRunCommand(widthMm, heightMm, grid = levelingGrid(widthMm, heightMm), offset = NO_PLACEMENT) {
  const w = fmt(widthMm);
  const h = fmt(heightMm);
  return `M495 X${fmt(offset.x)} Y${fmt(offset.y)} C${fmt(offset.x + widthMm)} D${fmt(offset.y + heightMm)} O0 F0 A${w} B${h} I${grid.i} J${grid.j} H${LEVELING_HEIGHT_MM} P1`;
}

// "Insert the wired probe (T0)" step. A real M6 T0 runs the manual-tool-change
// wait AND the probe calibration on the TLO sensor (fill_cali_scripts with
// is_probe=true) — required so ref_tool_mz is valid when the Z probe later
// executes G10 L20 Z. If the machine already reports T0, M6 T0 would be a
// no-op (ATCHandler.cpp:1927 "new_tool != active_tool"), so recalibrate with
// M491 instead (resets the TLO for the current tool = the probe).
export function insertProbeCommand(currentTool) {
  return currentTool === 0 ? 'M491' : 'M6 T0';
}

// Machine states in which the anchor-1 sequence must NOT start, mapped to a
// reason code the UI translates into a clear instruction.
export function anchor1Readiness(status, connected = true) {
  if (!connected) return { ok: false, reason: 'not-connected' };
  const state = status?.state;
  if (!state) return { ok: false, reason: 'no-status' };
  if (state === 'Alarm' || state === 'Halt' || state === 'Sleep') return { ok: false, reason: 'alarm' };
  if (state === 'Home') return { ok: false, reason: 'homing' };
  if (state === 'Run' || state === 'Hold' || state === 'Pause' || state === 'Wait' || state === 'Tool') {
    return { ok: false, reason: 'busy' };
  }
  return { ok: true, reason: null };
}

// Work coordinate offset (WCO = MPos - WPos) from a parsed status object
// (see parseStatus in src/machine.js). Returns null when the status doesn't
// carry both positions.
export function workCoordOffset(status) {
  const m = status?.mpos;
  const w = status?.wpos;
  if (!m || !w || m.length < 2 || w.length < 2) return null;
  return {
    x: m[0] - w[0],
    y: m[1] - w[1],
    z: m.length > 2 && w.length > 2 ? m[2] - w[2] : 0,
  };
}

// Whether a workpiece XY origin has been set. Without one, WPos equals MPos
// (WCO ~ 0) and every "absolute" move is really measured from the machine's
// reference corner at the top right. Returns null when it cannot be told
// from the status (no positions yet).
export function originIsSet(status, epsilonMm = 0.01) {
  const wco = workCoordOffset(status);
  if (!wco) return null;
  return Math.abs(wco.x) > epsilonMm || Math.abs(wco.y) > epsilonMm;
}

// A HOMED Carvera can never report machine coordinates above the soft-endstop
// maximum of -1 mm per axis (Robot.cpp; the reference corner is X/Y/Z-max).
// Positive / near-zero MPos therefore means: the machine was reset or power-
// cycled and NOT homed since — the coordinate system (and every stored WCS
// offset) is meaningless until $H runs. This is exactly the state the
// post-incident screenshot showed (MPos 0/116/63). Returns null without
// positions.
const HOMED_MPOS_MAX_MM = -0.5; // safely between "homed" (<= -1) and garbage (>= 0)
export function notHomedFromStatus(status) {
  const m = status?.mpos;
  if (!m || m.length < 3) return null;
  return m[0] > HOMED_MPOS_MAX_MM || m[1] > HOMED_MPOS_MAX_MM || m[2] > HOMED_MPOS_MAX_MM;
}
