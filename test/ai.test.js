import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewMessages, parseReview, flattenPatch } from '../src/ai.js';

test('buildReviewMessages produces system+user with board context', () => {
  const msgs = buildReviewMessages({
    config: { isolation: { cutDepth: 0.15 } },
    board: { width: 138.5, height: 30 },
    checks: { messages: [{ level: 'ok', text: 'gap fine' }] },
    operations: [{ id: 'isolation', toolType: 'vbit', diameter: 0.18 }],
    stats: { minCopperGap: 0.47 },
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /Carvera Air/);
  assert.match(msgs[1].content, /138\.5/);
  assert.match(msgs[1].content, /minCopperGap/);
});

test('parseReview extracts JSON from fenced text', () => {
  const r = parseReview('here you go:\n```json\n{"summary":"ok","issues":[{"severity":"warn","message":"x"}],"patch":{"isolation":{"cutDepth":0.12}}}\n```');
  assert.equal(r.summary, 'ok');
  assert.equal(r.issues.length, 1);
  assert.deepEqual(r.patch, { isolation: { cutDepth: 0.12 } });
});

test('parseReview tolerates raw JSON and missing fields', () => {
  const r = parseReview('{"summary":"s"}');
  assert.equal(r.summary, 's');
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.patch, {});
});

test('parseReview throws on non-JSON', () => {
  assert.throws(() => parseReview('no json here'), /JSON/);
});

test('flattenPatch flattens nested config to dotted keys', () => {
  const flat = flattenPatch({ isolation: { cutDepth: 0.12, passes: 3 }, outline: { tabs: 6 }, safeZ: 6 });
  assert.deepEqual(flat, { 'isolation.cutDepth': 0.12, 'isolation.passes': 3, 'outline.tabs': 6, safeZ: 6 });
});
