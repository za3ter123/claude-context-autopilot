'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Autopilot, STATES } = require('../src/monitor');

const W = 200000;
const base = { compactAt: 60, clearAt: 55, windowTokens: W };

test('rejects invalid config', () => {
  assert.throws(() => new Autopilot({ compactAt: 0, clearAt: 5, windowTokens: W }));
  assert.throws(() => new Autopilot({ compactAt: 50, clearAt: 60, windowTokens: W })); // clear > compact
  assert.throws(() => new Autopilot({ compactAt: 60, clearAt: 55, windowTokens: 0 }));
});

test('stays idle below the compact threshold', () => {
  const a = new Autopilot(base);
  const r = a.tick({ usedTokens: 0.4 * W, now: 1000, todoMtime: 0 });
  assert.strictEqual(r.action, 'none');
  assert.strictEqual(r.state, STATES.MONITORING);
});

test('fires /compact at the threshold', () => {
  const a = new Autopilot(base);
  const r = a.tick({ usedTokens: 0.6 * W, now: 1000 });
  assert.strictEqual(r.action, 'compact');
  assert.strictEqual(r.state, STATES.POST_COMPACT_WAIT);
});

test('sufficient compaction returns to monitoring (no clear)', () => {
  const a = new Autopilot(base);
  a.tick({ usedTokens: 0.6 * W, now: 1000 });               // -> compact
  const r = a.tick({ usedTokens: 0.30 * W, now: 2000 });    // dropped well below clearAt
  assert.strictEqual(r.action, 'compacted-ok');
  assert.strictEqual(r.state, STATES.MONITORING);
});

test('insufficient compaction triggers the handoff prompt', () => {
  const a = new Autopilot(base);
  a.tick({ usedTokens: 0.62 * W, now: 1000 });              // -> compact
  // settle via timeout, still above clearAt
  const r = a.tick({ usedTokens: 0.58 * W, now: 1000 + 150001 });
  assert.strictEqual(r.action, 'prompt');
  assert.strictEqual(r.state, STATES.CLEARING);
});

test('clears only after a fresh non-empty handoff file appears', () => {
  const a = new Autopilot(base);
  a.tick({ usedTokens: 0.62 * W, now: 1000 });
  const promptTick = a.tick({ usedTokens: 0.58 * W, now: 1000 + 150001 }); // -> prompt at this now
  const promptAt = 1000 + 150001;
  assert.strictEqual(promptTick.action, 'prompt');

  // stale file (saved before the prompt) must NOT trigger a clear
  const r1 = a.tick({ usedTokens: 0.58 * W, now: promptAt + 5000, todoMtime: promptAt - 10 });
  assert.strictEqual(r1.action, 'none');

  // fresh file -> clear
  const r2 = a.tick({ usedTokens: 0.58 * W, now: promptAt + 6000, todoMtime: promptAt + 1 });
  assert.strictEqual(r2.action, 'clear');
  assert.strictEqual(r2.state, STATES.MONITORING);
});

test('abandons the clear if no handoff is saved before the timeout', () => {
  const a = new Autopilot(base);
  a.tick({ usedTokens: 0.62 * W, now: 1000 });
  a.tick({ usedTokens: 0.58 * W, now: 1000 + 150001 });     // -> prompt
  const promptAt = 1000 + 150001;
  const r = a.tick({ usedTokens: 0.58 * W, now: promptAt + 600001, todoMtime: 0 });
  assert.strictEqual(r.action, 'abort-clear');
  assert.strictEqual(r.state, STATES.MONITORING);
});

test('honors cooldown after a sufficient compaction', () => {
  const a = new Autopilot(base);
  a.tick({ usedTokens: 0.6 * W, now: 1000 });
  a.tick({ usedTokens: 0.30 * W, now: 2000 });              // compacted-ok, cooldown until 62000
  const during = a.tick({ usedTokens: 0.65 * W, now: 30000 });
  assert.strictEqual(during.action, 'none');                // still cooling down
  const after = a.tick({ usedTokens: 0.65 * W, now: 63000 });
  assert.strictEqual(after.action, 'compact');              // cooldown elapsed
});
