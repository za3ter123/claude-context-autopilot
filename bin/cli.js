#!/usr/bin/env node
'use strict';
// claude-autopilot — run this INSTEAD of `claude`.
//
// It launches Claude Code inside a pseudo-terminal (PTY) and passes your keyboard and its output
// straight through, so it looks and feels exactly like running `claude`. In the background it reads
// the session transcript off disk (zero API tokens) and, when context fills up, writes commands
// into the PTY's stdin — no focus stealing, no simulated OS keystrokes, no GUI. Works the same on
// macOS, Linux, and Windows.

const os = require('os');
const path = require('path');
const fs = require('fs');

const { transcriptDir, readCurrentUsage } = require('../src/transcript');
const { readWindowTokens } = require('../src/settings');
const { Autopilot } = require('../src/monitor');

// ---- arg parsing -------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    compactAt: 60, clearAt: 55, noCompactAt: 0, window: 0, pollSeconds: 20,
    claudeCmd: null, dryRun: false, help: false, passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.passthrough = argv.slice(i + 1); break; }
    else if (a === '--compact-at') out.compactAt = Number(argv[++i]);
    else if (a === '--clear-at') out.clearAt = Number(argv[++i]);
    else if (a === '--no-compact-at') out.noCompactAt = Number(argv[++i]);
    else if (a === '--window') out.window = Number(argv[++i]);
    else if (a === '--poll') out.pollSeconds = Number(argv[++i]);
    else if (a === '--claude-cmd') out.claudeCmd = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else out.passthrough.push(a);
  }
  return out;
}

const HELP = `claude-autopilot — auto /compact + safe /clear for Claude Code (cross-platform, token-free)

USAGE
  claude-autopilot [options] [-- <args passed to claude>]

OPTIONS
  --compact-at <pct>     Context %% that triggers /compact                       (default 60)
  --clear-at <pct>       Context %% that, if still hit AFTER a compaction, starts the
                         ask -> save-handoff -> /clear flow                       (default 55)
  --no-compact-at <pct>  Ceiling above which we DON'T /compact at all. Instead we dump a
                         todo, ask you what to keep/add, and only /clear once YOU confirm.
                         Must be >= --compact-at. 0 disables it.                  (default 0)
  --window <tokens>      Token window for %%; 0 = read autoCompactWindow, else 200000
  --poll <seconds>       Seconds between transcript reads                         (default 20)
  --claude-cmd <cmd>     Command used to launch Claude Code                       (default "claude")
  --dry-run              Do NOT launch Claude; just print the live context %% it reads.
  -h, --help             Show this help.

EXAMPLES
  claude-autopilot                     # wrap claude with defaults
  claude-autopilot --compact-at 70 --clear-at 60
  claude-autopilot --compact-at 70 --no-compact-at 88   # compact at 70%, hand off (no compact) at 88%
  claude-autopilot -- --model opus     # forward args to claude
  claude-autopilot --dry-run           # prove it reads your context, launches nothing
`;

// The whole instruction set rides in this one prompt — there is no dependency on CLAUDE.md or any
// other config. Edit here to change what Claude is told before an auto-clear.
const CLEAR_PROMPT =
  'AUTO-CONTEXT autopilot: a compaction just ran but context is still high. Do NOT start new work. '
  + 'First ask me what to preserve and what is left to do. Then write my answers and the remaining '
  + 'task list to the file .claude-autopilot-todo.md in the project root. Once that file is saved, '
  + 'this session will be cleared automatically.';

// The line the agent appends ONLY after the user has finished adding/editing todo items. The
// no-compact handoff will not /clear until this marker appears, so the user stays in control.
const READY_MARKER = 'AUTOPILOT-READY';

const NOCOMPACT_PROMPT =
  'AUTO-CONTEXT autopilot: context is very high — too high to compact safely — so we will hand off to '
  + 'a fresh session instead of compacting. Do NOT start new work. Do this, in order: '
  + '(1) Write everything worth preserving — the remaining task list, key decisions, exact file paths, '
  + 'and open questions — to .claude-autopilot-todo.md in the project root. '
  + '(2) Then ASK me directly: what else should be on this todo list, and what should be dropped? '
  + '(3) Add my answers to that file and let me keep editing until I say it is complete. '
  + `(4) ONLY after I confirm, append a final line exactly "${READY_MARKER}" to the file. `
  + 'The session is cleared automatically once that line appears — and not before — so wait for my go-ahead.';

function nonEmptyMtime(file) {
  try {
    const st = fs.statSync(file);
    return st.size > 0 ? st.mtimeMs : 0;
  } catch { return 0; }
}

// True once the agent has written the user-confirmation marker into the handoff file.
function hasReadyMarker(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes(READY_MARKER);
  } catch { return false; }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }
  if (opts.clearAt > opts.compactAt) {
    process.stderr.write('error: --clear-at must be <= --compact-at\n');
    process.exit(1);
  }
  if (opts.noCompactAt > 0 && opts.noCompactAt < opts.compactAt) {
    process.stderr.write('error: --no-compact-at must be >= --compact-at\n');
    process.exit(1);
  }

  const project = process.cwd();
  const windowTokens = opts.window > 0 ? opts.window : readWindowTokens();
  const tdir = transcriptDir(project);
  const todoFile = path.join(project, '.claude-autopilot-todo.md');
  const logFile = path.join(project, '.claude-autopilot.log');

  const auto = new Autopilot({
    compactAt: opts.compactAt, clearAt: opts.clearAt,
    noCompactAt: opts.noCompactAt, windowTokens,
  });

  // In wrapped mode we must NOT print to stdout (it would corrupt Claude's TUI) — log to file only.
  // In dry-run there is no TUI, so log to stdout.
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (opts.dryRun) process.stdout.write(line);
    else { try { fs.appendFileSync(logFile, line); } catch { /* ignore */ } }
  };

  const noCompactStr = opts.noCompactAt > 0
    ? `noCompactAt=${opts.noCompactAt}% (${Math.round(windowTokens * opts.noCompactAt / 100)} tok) `
    : 'noCompactAt=off ';
  const summary = `window=${windowTokens} compactAt=${opts.compactAt}% (${Math.round(windowTokens * opts.compactAt / 100)} tok) `
    + `clearAt=${opts.clearAt}% (${Math.round(windowTokens * opts.clearAt / 100)} tok) `
    + noCompactStr
    + `poll=${opts.pollSeconds}s dryRun=${opts.dryRun}`;
  log(`armed for ${project} | ${summary}`);

  // ---- dry-run: read-only, no PTY --------------------------------------------------------------
  if (opts.dryRun) {
    const tickOnce = () => {
      const used = readCurrentUsage(tdir);
      if (used < 0) { log('no active session transcript found yet'); return; }
      const todoMtime = nonEmptyMtime(todoFile);
      const handoffConfirmed = hasReadyMarker(todoFile);
      const r = auto.tick({ usedTokens: used, now: Date.now(), todoMtime, handoffConfirmed });
      log(`ctx ${r.pct}% (${used}/${windowTokens} tok) state=${r.state} action=${r.action}`);
    };
    tickOnce();
    const timer = setInterval(tickOnce, opts.pollSeconds * 1000);
    process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
    return;
  }

  // ---- wrapped mode: spawn claude in a PTY -----------------------------------------------------
  let pty;
  try { pty = require('node-pty'); }
  catch {
    process.stderr.write('error: node-pty is not installed. Run "npm install" in the claude-autopilot directory.\n');
    process.exit(1);
  }

  const isWin = process.platform === 'win32';
  const cmd = opts.claudeCmd || (isWin ? 'claude.cmd' : 'claude');
  const child = pty.spawn(cmd, opts.passthrough, {
    name: 'xterm-color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 30,
    cwd: project,
    env: process.env,
  });

  child.onData((d) => process.stdout.write(d));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => child.write(d.toString('utf8')));
  process.stdout.on('resize', () => child.resize(process.stdout.columns || 80, process.stdout.rows || 30));

  // Type a line into Claude's input the way a user would: text, brief pause, Enter.
  const injectLine = (text) => {
    child.write(text);
    setTimeout(() => child.write('\r'), 120);
  };

  const timer = setInterval(() => {
    const used = readCurrentUsage(tdir);
    if (used < 0) return;
    const todoMtime = nonEmptyMtime(todoFile);
    const handoffConfirmed = hasReadyMarker(todoFile);
    const r = auto.tick({ usedTokens: used, now: Date.now(), todoMtime, handoffConfirmed });
    switch (r.action) {
      case 'compact':
        log(`ctx ${r.pct}% >= ${opts.compactAt}% -> /compact`);
        injectLine('/compact');
        break;
      case 'prompt-nocompact':
        log(`ctx ${r.pct}% >= ${opts.noCompactAt}% (no-compact ceiling) -> dump todo + ask user, /clear only on your "${READY_MARKER}"`);
        injectLine(NOCOMPACT_PROMPT);
        break;
      case 'prompt':
        log(`still ${r.pct}% after compaction -> asking for handoff before clear`);
        injectLine(CLEAR_PROMPT);
        break;
      case 'awaiting-confirm':
        log(`todo written; waiting for you to add items and confirm with "${READY_MARKER}" before /clear`);
        break;
      case 'clear':
        log('handoff ready -> /clear');
        injectLine('/clear');
        break;
      case 'abort-clear':
        log('handoff never completed within timeout -> NOT clearing (session left intact)');
        break;
      case 'compacted-ok':
        log(`compaction sufficient (${r.pct}% < ${opts.clearAt}%) -> back to monitoring`);
        break;
      default:
        break;
    }
  }, opts.pollSeconds * 1000);

  const cleanup = () => { clearInterval(timer); if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} } };
  child.onExit(({ exitCode }) => { cleanup(); process.exit(exitCode || 0); });
  process.on('SIGINT', () => { child.write('\x03'); }); // forward Ctrl-C to Claude, don't kill the wrapper
}

main();
