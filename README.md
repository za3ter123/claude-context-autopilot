# Claude Context Autopilot

A **token-free** external watcher that manages an interactive Claude Code session's context for you.
It runs as a separate PowerShell process, reads the session transcript **from disk** (never calls the
API, so it costs zero tokens), and injects `/compact` and `/clear` as keystrokes when context fills up.

This exists because Claude Code natively offers only a boolean `autoCompactEnabled` — there is no
"compact at exactly 60%" setting, and the model itself **cannot** run `/compact` or `/clear` (those are
user/CLI-only commands; hooks can't fire them either). An external watcher is the only way to get a
precise-threshold, self-clearing workflow.

## What it does

It computes "context used %" exactly like the in-app meter:

```
used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens   (output excluded)
pct  = used / effective_window     (effective_window = autoCompactWindow from settings.json, else 200000)
```

Then runs a 3-state machine:

| State | Trigger | Action |
|-------|---------|--------|
| **MONITORING** | `pct >= CompactAt` (default 60%) | Sends `/compact`, records pre-compact tokens, → POST_COMPACT_WAIT |
| **POST_COMPACT_WAIT** | compaction settles (usage drops ≥5% of window, or 150s timeout) | If `pct >= ClearAt` (default 55%) → send the **clear-protocol prompt**, → CLEARING. Else → cooldown 60s → MONITORING |
| **CLEARING** | `.claude-autopilot-todo.md` is freshly written (mtime > prompt time, non-empty) | Wait 2s to settle, send `/clear`. (600s timeout abandons the clear without firing it.) |

**The clear never fires before your handoff is saved to disk.** The clear-protocol prompt tells Claude
to *first ask you* what to preserve and what's left to do, write your answers to
`.claude-autopilot-todo.md`, and only then does the watcher send `/clear`.

By design `ClearAt <= CompactAt`: the clear flow only fires when a `/compact` **failed** to bring usage
back under the line — the "compaction wasn't enough, hand off and start fresh" fallback.

## Requirements

- Windows (uses Win32 `SetForegroundWindow` + `SendKeys` for injection and toast notifications)
- Windows PowerShell 5.1+ (ships with Windows) or PowerShell 7
- Claude Code, run in a terminal window (this watcher drives that window from the outside)

## Install

```powershell
git clone https://github.com/za3ter123/claude-context-autopilot.git
cd claude-context-autopilot
powershell -File .\claude-context-autopilot.ps1 -SelfTest   # sanity check, no session needed
```

## Files it writes (in the project dir)

- `.claude-autopilot.log` — what it observed and did
- `.claude-autopilot.lock` — single-instance guard
- `.claude-autopilot-todo.md` — your handoff (Claude writes this; the watcher waits for it before `/clear`)

## Usage

**1. Verify the math offline (no session needed):**
```powershell
powershell -File .\claude-context-autopilot.ps1 -SelfTest
```

**2. Prove it reads your live context without touching the session:**
```powershell
powershell -File .\claude-context-autopilot.ps1 -DryRun
```
It logs the current `ctx N%` every poll. Confirm that number matches the in-app meter.

**3. Arm it live.** Run it, then **click your Claude Code terminal during the countdown** so it captures
the right window to type into:
```powershell
powershell -File .\claude-context-autopilot.ps1
```

### Key parameters

| Param | Default | Meaning |
|-------|---------|---------|
| `-Project` | current dir | Which session to watch (locates transcript under `~/.claude/projects/<encoded>/`) |
| `-CompactAt` | `60` | % used that triggers `/compact` |
| `-ClearAt` | `55` | % used (after compaction settles) that triggers the ask→todo→clear flow |
| `-EffectiveWindow` | `0` | Token window for %; 0 = read `autoCompactWindow`, fallback 200000 |
| `-PollSeconds` | `20` | Seconds between transcript reads |
| `-WindowCaptureDelay` | `6` | Countdown before grabbing the target window |
| `-TargetHandle` | `0` | Skip interactive capture; target this exact HWND (for re-arming) |
| `-MaxHours` | `24` | Runtime safety cap |
| `-DryRun` | off | Log actions but send no keystrokes |
| `-SelfTest` | off | Offline unit checks; no session/keys |

## Auto-start "forever" (optional)

`Register-AutopilotTask.ps1` installs a logon scheduled task that mirrors `claude-autoresume`:

```powershell
powershell -ExecutionPolicy Bypass -File .\Register-AutopilotTask.ps1 -Install -Project C:\path\to\your\project -ExtraArgs '-DryRun'
powershell -ExecutionPolicy Bypass -File .\Register-AutopilotTask.ps1 -Uninstall
```

**Caveat:** keystroke injection needs to know *which* window is your Claude terminal. At logon there
isn't one yet, so logon-start is fragile — **manual arming (step 3 above) is the reliable workflow.**
Auto-start is provided for parity but is best paired with a stable `-TargetHandle`.

## How it injects keystrokes

Win32 `SetForegroundWindow` + `ShowWindow` + `System.Windows.Forms.SendKeys::SendWait` against **one**
window handle captured at arm-time, so it cannot type into a random foreground app. Injected prompts
avoid SendKeys-special characters (`+ ^ % ~ ( ) { } [ ]`).

## Notes

- **No CLAUDE.md / config dependency.** The instructions Claude follows ride entirely inside the prompt
  the watcher injects (`$script:ClearPrompt` near the top of the script), so the automation works without
  any session-config rule telling Claude how to behave. Edit that one variable to change what Claude is told.
- **Tuning thresholds:** pass `-CompactAt` / `-ClearAt` to taste, e.g. `-CompactAt 70 -ClearAt 60`.
- **Privacy / safety:** the watcher only ever *reads* your transcript files and *types* `/compact`,
  `/clear`, and the handoff prompt into the one window you point it at. It makes no network calls.

## License

MIT — see [LICENSE](LICENSE).
