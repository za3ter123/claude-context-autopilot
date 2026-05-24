# Set up Claude Context Autopilot with your AI agent

Copy **everything inside the box below** and paste it to your coding agent (Claude Code, Cursor, etc.).
It will install, verify, and start the autopilot for you — on macOS, Linux, or Windows.

---

```
You are setting up "Claude Context Autopilot" — a wrapper that runs Claude Code inside a PTY and
auto-runs /compact (and a safe ask→handoff→/clear fallback) when the context window fills up. It is
token-free: it reads the session transcript from disk and never calls the API. Follow these steps
exactly, detect the OS yourself, and report back at each step.

PRECHECKS
1. Verify Node.js >= 18 is installed: run `node --version`. If it's missing or older, stop and tell me
   to install Node 18+ from https://nodejs.org, then resume.
2. Verify the `claude` command exists on PATH (`claude --version`). If not, stop and tell me to install
   Claude Code first.

INSTALL
3. Clone the repo and install dependencies:
     git clone https://github.com/za3ter123/claude-context-autopilot.git
     cd claude-context-autopilot
     npm install
   (npm install pulls `node-pty`, which ships a prebuilt binary — no C++ compiler needed on Node 18+.
   If install fails on a native build, tell me the exact error instead of guessing.)

VERIFY (do not skip — I want proof it works before trusting it)
4. Run the unit tests: `npm test`. Confirm all tests pass (expect 22 passing). Paste the summary line.
5. Run a read-only live check from inside one of MY real projects (ask me which directory if unsure):
     cd /path/to/my/project
     node /absolute/path/to/claude-context-autopilot/bin/cli.js --dry-run
   Let it print one or two `ctx N%` lines, then stop it (Ctrl-C). Tell me the % it reported so I can
   compare it to the in-app context meter. If it says "no active session transcript found yet", that's
   expected when no Claude session has run in that dir — note it and move on.

MAKE IT EASY TO RUN
6. Run `npm link` inside the repo so the `claude-autopilot` command is available globally. If `npm link`
   needs elevated permissions and fails, instead tell me the absolute path to `bin/cli.js` so I can call
   it with `node`.

EXPLAIN + START
7. Tell me, in 2-3 lines: from now on I start Claude with `claude-autopilot` (instead of `claude`) inside
   any project, and use Claude normally. Defaults: /compact at 60% context, and if a compaction isn't
   enough it asks me for a handoff, saves it to `.claude-autopilot-todo.md`, then /clears. Mention I can
   tune it with `--compact-at` and `--clear-at`, and that `--no-compact-at <pct>` (a higher ceiling, e.g.
   88) makes it STOP compacting past that point and instead dump a todo, ask me what to keep/add, and only
   /clear after I confirm with an `AUTOPILOT-READY` line — so I stay in control near the very top.
8. Do NOT auto-start a live wrapped session yourself (it would take over this terminal). Just confirm
   setup is complete and show me the one command to run when I'm ready.

If any step fails, stop and show me the exact command and error output — do not improvise workarounds.
```

---

That's it. After it finishes, run `claude-autopilot` in any project instead of `claude`.
