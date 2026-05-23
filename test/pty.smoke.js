'use strict';
// Not a unit test — a live smoke test that the PTY injection path works on THIS platform.
// Spawns an interactive Node REPL inside a PTY, "types" an expression by writing to the PTY
// (exactly how the autopilot injects /compact), and asserts the evaluated result comes back.
const pty = require('node-pty');

const isWin = process.platform === 'win32';
const shell = process.execPath; // node itself — guaranteed present, cross-platform
const child = pty.spawn(shell, ['-i'], { name: 'xterm-color', cols: 80, rows: 30, env: process.env });

let buf = '';
let done = false;
child.onData((d) => { buf += d; });

// give the REPL a moment, then inject like a keystroke stream: text, pause, Enter
setTimeout(() => child.write('17*3'), 600);
setTimeout(() => child.write('\r'), 800);

setTimeout(() => {
  done = true;
  child.kill();
  if (/\b51\b/.test(buf)) {
    console.log('[PASS] PTY injection works: child evaluated the injected input (saw 51).');
    process.exit(0);
  } else {
    console.log('[FAIL] did not observe expected output. Captured:\n' + buf.slice(-400));
    process.exit(1);
  }
}, 2500);

child.onExit(() => { if (!done) { console.log('[FAIL] child exited early'); process.exit(1); } });
