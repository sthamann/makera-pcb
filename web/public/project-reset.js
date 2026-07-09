// Project-scoped state reset. When a project is created / loaded / imported,
// every MANUAL confirmation must fall back to "not done" — the assistant's
// "board placed at anchor 1" tick, the fabrication step ticks and a monitored
// job all belong to the PREVIOUS board. Machine-side states (connected /
// homed / origin / Z probed) are NOT touched here: they are re-detected from
// the live status, which stays valid if the machine really is still set up.
//
// Pure function over injected state + storage so it is unit-testable
// (test/project-reset.test.js) without a DOM.

// localStorage key of the assistant's manual "board placed at anchor 1" tick.
export const SETUP_PLACED_KEY = 'makera_setup_placed';

export function resetProjectScopedState(state, storage) {
  try { storage.setItem(SETUP_PLACED_KEY, 'false'); } catch { /* storage full/blocked */ }
  if (state.fab) {
    state.fab.done = {}; // manual fabrication-step ticks
    state.fab.view = null;
    state.fab.job = null; // discard a monitored job (monitoring only — no machine command)
  }
  if (state.machine) {
    state.machine.heightMap = null; // leveling map belongs to the old setup
    state.machine.heightMapAssess = null;
  }
  return state;
}
