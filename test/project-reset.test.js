import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_PLACED_KEY, resetProjectScopedState } from '../web/public/project-reset.js';

function makeState() {
  return {
    fab: {
      done: { fixate: true, setOrigin: true, isolation: true },
      view: 3,
      job: { monitor: { active: true }, stepId: 'isolation' },
    },
    machine: {
      connected: true, // machine-side state must stay untouched
      status: { state: 'Idle' },
      heightMap: { cols: 9, rows: 5 },
      heightMapAssess: { ok: false },
    },
  };
}

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    setItem(k, v) { data[k] = String(v); },
    getItem(k) { return k in data ? data[k] : null; },
  };
}

test('project switch resets manual ticks, job monitor and height map', () => {
  const state = makeState();
  const storage = makeStorage({ [SETUP_PLACED_KEY]: 'true' });
  resetProjectScopedState(state, storage);
  // manual "board placed at anchor 1" tick cleared (JSON false)
  assert.equal(JSON.parse(storage.getItem(SETUP_PLACED_KEY)), false);
  // fabrication ticks + monitored job discarded
  assert.deepEqual(state.fab.done, {});
  assert.equal(state.fab.view, null);
  assert.equal(state.fab.job, null);
  // stale leveling data discarded
  assert.equal(state.machine.heightMap, null);
  assert.equal(state.machine.heightMapAssess, null);
});

test('machine-side live state is NOT touched (connection/status stay)', () => {
  const state = makeState();
  resetProjectScopedState(state, makeStorage());
  assert.equal(state.machine.connected, true);
  assert.deepEqual(state.machine.status, { state: 'Idle' });
});

test('a blocked storage does not break the reset', () => {
  const state = makeState();
  const storage = { setItem() { throw new Error('quota'); }, getItem() { return null; } };
  assert.doesNotThrow(() => resetProjectScopedState(state, storage));
  assert.deepEqual(state.fab.done, {});
});
