# Claude Context Autopilot

Run Claude Code as you always do — this just keeps the context window from filling up on you.

`claude-autopilot` is a thin wrapper you run **instead of** `claude`. It launches Claude Code inside a
pseudo-terminal (PTY) and passes your keyboard and its output straight through, so it looks and feels
exactly like the real CLI. In the background it reads the session transcript **from disk** (zero API
tokens) and, when the context gets full, it types `/compact` for you — and if a compaction isn't enough,
it runs a safe **ask → save handoff → `/clear`** flow so you never lose your place.

**No focus stealing. No simulated OS keystrokes. No Notepad. No GUI.** Identical on macOS, Linux, and
Windows, because it owns Claude's stdin directly instead of poking at windows.

## Why this exists

Claude Code natively offers only a boolean `autoCompactEnabled` — there is no "compact at exactly 60%"
setting, and the model itself **cannot** run `/compact` or `/clear` (those are user/CLI-only; hooks can't
fire them either). An external driver is the only way to get a precise-threshold, self-clearing workflow,
and a PTY wrapper is the clean way to do it.

## What it does

It computes "context used %" exactly like the in-app meter:

```
used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens   (output excluded)
pct  = used / effective_window     (effective_window = autoCompactWindow from settings.json, else 200000)
```

Then runs a 3-state machine:

| State | Trigger | Action |
|-------|---------|--------|
| **MONITORING** | `pct >= compactAt` (default 60%) | Types `/compact`, records pre-compact tokens, → POST_COMPACT_WAIT |
| **POST_COMPACT_WAIT** | compaction settles (usage drops ≥5% of window, or 150s timeout) | If `pct >= clearAt` (default 55%) → type the **handoff prompt**, → CLEARING. Else → cooldown 60s → MONITORING |
| **CLEARING** | `.claude-autopilot-todo.md` is freshly written (mtime > prompt time, non-empty) | Types `/clear`. (600s timeout abandons the clear — your session is left intact.) |

**The `/clear` never fires before your handoff is saved to disk.** The handoff prompt tells Claude to
*first ask you* what to preserve and what's left to do, write your answers to `.claude-autopilot-todo.md`,
and only then does the watcher send `/clear`.

By design `clearAt <= compactAt`: the clear flow only fires when a `/compact` **failed** to bring usage
back under the line — the "compaction wasn't enough, hand off and start fresh" fallback.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- Claude Code installed and on your `PATH` (the `claude` command)
- That's it. Works on macOS, Linux, and Windows (uses ConPTY there automatically).

## Install

```bash
git clone https://github.com/za3ter123/claude-context-autopilot.git
cd claude-context-autopilot
npm install        # pulls node-pty (prebuilt binary, no compiler needed on Node 18+)
npm test           # 15 unit tests — verify it works before trusting it
```

Optionally put it on your PATH so you can run it from any project:

```bash
npm link           # exposes `claude-autopilot` globally
```

## Usage

Go to your project and start Claude **through** the autopilot instead of directly:

```bash
cd /path/to/your/project
claude-autopilot                       # == running `claude`, but with the autopilot watching
```

Use Claude normally. You'll see a `.claude-autopilot.log` appear in the project — that's the watcher
narrating what it observes and does. When context crosses your threshold it types `/compact` itself;
if that's not enough it asks you for a handoff and then clears.

**Prove it reads your context first (launches nothing):**

```bash
claude-autopilot --dry-run             # prints live ctx % every poll; compare to the in-app meter
```

**Forward arguments to Claude** after `--`:

```bash
claude-autopilot -- --model opus
```

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `--compact-at <pct>` | `60` | Context % that triggers `/compact` |
| `--clear-at <pct>` | `55` | Context % that, if still hit *after* a compaction, starts the ask → handoff → `/clear` flow |
| `--window <tokens>` | `0` | Token window for %; `0` = read `autoCompactWindow` from settings.json, else 200000 |
| `--poll <seconds>` | `20` | Seconds between transcript reads |
| `--claude-cmd <cmd>` | `claude` | Command used to launch Claude Code |
| `--dry-run` | off | Don't launch Claude; just print the live context % it reads |
| `-h`, `--help` | | Show help |

Example: be more relaxed about it —

```bash
claude-autopilot --compact-at 70 --clear-at 60
```

## How injection works (and why it's safe)

The wrapper holds the write end of Claude's PTY. To "type" a command it simply does
`child.write('/compact\r')` — the exact same bytes your keyboard would send. Because the wrapper *owns*
that input stream, there is no window to focus, no race with whatever app is in the foreground, and no
way for the keystrokes to land in the wrong place. The same code path runs on every OS; on Windows,
`node-pty` uses ConPTY under the hood.

It only ever **reads** your transcript files and **writes** `/compact`, `/clear`, and the handoff prompt
into the Claude it launched. It makes **no network calls**.

## Files it writes (in the project dir)

- `.claude-autopilot.log` — what it observed and did
- `.claude-autopilot-todo.md` — your handoff (Claude writes this; the watcher waits for it before `/clear`)

All three are git-ignored by default.

## No config dependency

The full instruction set Claude follows before an auto-clear rides inside the single `CLEAR_PROMPT`
string at the top of [`bin/cli.js`](bin/cli.js). There is **no** dependency on `CLAUDE.md` or any other
config file — edit that one string to change what Claude is told.

## Set it up with your AI agent

Don't want to read docs? Paste [`AGENT_SETUP.md`](AGENT_SETUP.md) to your coding agent and it will clone,
install, verify, and start the autopilot for you.

## License

MIT — see [LICENSE](LICENSE).
