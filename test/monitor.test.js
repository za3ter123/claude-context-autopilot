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

// ---- no-compact ceiling (Project 3) ----------------------------------------------------------
const nc = { compactAt: 60, clearAt: 55, noCompactAt: 85, windowTokens: W };

test('rejects a no-compact ceiling below the compact threshold', () => {
  assert.throws(() => new Autopilot({ compactAt: 60, clearAt: 55, noCompactAt: 50, windowTokens: W }));
});

test('between compactAt and the ceiling it still compacts normally', () => {
  const a = new Autopilot(nc);
  const r = a.tick({ usedTokens: 0.70 * W, now: 1000 });    // 70%: above compact, below ceiling
  assert.strictEqual(r.action, 'compact');
  assert.strictEqual(r.state, STATES.POST_COMPACT_WAIT);
});

test('at the no-compact ceiling it skips /compact and goes straight to handoff', () => {
  const a = new Autopilot(nc);
  const r = a.tick({ usedTokens: 0.86 * W, now: 1000 });    // 86%: at/above the ceiling
  assert.strictEqual(r.action, 'prompt-nocompact');
  assert.strictEqual(r.state, STATES.CLEARING);
});

test('no-compact handoff waits for the user confirmation before clearing', () => {
  const a = new Autopilot(nc);
  const t0 = 1000;
  a.tick({ usedTokens: 0.86 * W, now: t0 });                // -> prompt-nocompact at t0

  // Agent wrote the todo (fresh) but the user has not confirmed yet -> hold, do NOT clear.
  const waiting = a.tick({ usedTokens: 0.86 * W, now: t0 + 5000, todoMtime: t0 + 1, handoffConfirmed: false });
  assert.strictEqual(waiting.action, 'awaiting-confirm');
  assert.strictEqual(waiting.state, STATES.CLEARING);

  // User added items and confirmed (marker present) -> clear.
  const done = a.tick({ usedTokens: 0.86 * W, now: t0 + 9000, todoMtime: t0 + 8000, handoffConfirmed: true });
  assert.strictEqual(done.action, 'clear');
  assert.strictEqual(done.state, STATES.MONITORING);
});

test('no-compact handoff uses the longer confirm timeout before abandoning', () => {
  const a = new Autopilot(nc);
  const t0 = 1000;
  a.tick({ usedTokens: 0.86 * W, now: t0 });                // -> prompt-nocompact

  // Past the 10-min post-compact clearTimeout but within the 30-min confirm window: still waiting.
  const stillWaiting = a.tick({ usedTokens: 0.86 * W, now: t0 + 600001, todoMtime: 0, handoffConfirmed: false });
  assert.strictEqual(stillWaiting.action, 'none');
  assert.strictEqual(stillWaiting.state, STATES.CLEARING);

  // Past the 30-min confirm window with nothing saved -> abandon (leave the session intact).
  const gaveUp = a.tick({ usedTokens: 0.86 * W, now: t0 + 1800001, todoMtime: 0, handoffConfirmed: false });
  assert.strictEqual(gaveUp.action, 'abort-clear');
  assert.strictEqual(gaveUp.state, STATES.MONITORING);
});

test('the ceiling takes priority over the compact threshold when both are exceeded', () => {
  const a = new Autopilot(nc);
  const r = a.tick({ usedTokens: 0.90 * W, now: 1000 });    // 90%: above both
  assert.strictEqual(r.action, 'prompt-nocompact');         // not 'compact'
});
