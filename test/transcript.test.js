'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
  encodeProjectDir, transcriptDir, usedTokensFromUsage, usedPct, newestJsonl, readCurrentUsage,
} = require('../src/transcript');

test('usedTokensFromUsage sums input + cache, excludes output', () => {
  const u = { input_tokens: 11399, cache_creation_input_tokens: 32701, cache_read_input_tokens: 25140, output_tokens: 282 };
  assert.strictEqual(usedTokensFromUsage(u), 69240);
});

test('usedTokensFromUsage handles null and partial usage', () => {
  assert.strictEqual(usedTokensFromUsage(null), 0);
  assert.strictEqual(usedTokensFromUsage({ input_tokens: 5 }), 5);
});

test('usedPct rounds to one decimal and guards zero window', () => {
  assert.strictEqual(usedPct(120000, 200000), 60);
  assert.strictEqual(usedPct(110000, 200000), 55);
  assert.strictEqual(usedPct(133333, 200000), 66.7);
  assert.strictEqual(usedPct(50000, 0), 0);
});

test('encodeProjectDir encodes both Windows and POSIX paths', () => {
  assert.strictEqual(encodeProjectDir('C:\\Users\\dev'), 'C--Users-dev');
  assert.strictEqual(encodeProjectDir('/Users/dev/app'), '-Users-dev-app');
});

test('transcriptDir lands under ~/.claude/projects/<encoded>', () => {
  const d = transcriptDir('C:\\Users\\dev', '/home/x');
  assert.strictEqual(d, path.join('/home/x', '.claude', 'projects', 'C--Users-dev'));
});

test('newestJsonl + readCurrentUsage read the latest usage from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-'));
  try {
    const older = path.join(dir, 'a.jsonl');
    const newer = path.join(dir, 'b.jsonl');
    fs.writeFileSync(older, JSON.stringify({ message: { usage: { input_tokens: 1 } } }) + '\n');
    fs.writeFileSync(newer,
      JSON.stringify({ type: 'noise' }) + '\n' +
      JSON.stringify({ message: { usage: { input_tokens: 100, cache_read_input_tokens: 23 } } }) + '\n' +
      'this is not json\n');
    // make `newer` clearly newer
    const future = Date.now() / 1000 + 100;
    fs.utimesSync(newer, future, future);

    assert.strictEqual(newestJsonl(dir), newer);
    assert.strictEqual(readCurrentUsage(dir), 123); // last valid usage line in newest file
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readCurrentUsage returns -1 when directory is missing', () => {
  assert.strictEqual(readCurrentUsage(path.join(os.tmpdir(), 'definitely-not-here-zzz')), -1);
});
