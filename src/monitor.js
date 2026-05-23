'use strict';
// Pure state machine for the context autopilot. No I/O, no timers, no PTY — it just decides what
// SHOULD happen given the current usage and clock. This is what the unit tests exercise.
//
//   MONITORING        : watching usage. At >= compactAt% -> emit 'compact'.
//   POST_COMPACT_WAIT  : compaction issued; wait for it to settle (usage drops, or timeout).
//                        If still >= clearAt% after settling -> emit 'prompt' (ask user to hand off).
//                        Otherwise -> back to MONITORING with a cooldown.
//   CLEARING           : handoff prompt sent; once the todo file is freshly saved -> emit 'clear'.
//                        If it is never saved before clearTimeout -> emit 'abort-clear' (leave intact).

const STATES = Object.freeze({
  MONITORING: 'MONITORING',
  POST_COMPACT_WAIT: 'POST_COMPACT_WAIT',
  CLEARING: 'CLEARING',
});

const DEFAULTS = Object.freeze({
  settleDropFraction: 0.05,   // usage must fall by >= 5% of window to count as "compaction settled"
  settleTimeoutMs: 150000,    // ...or give up waiting after 150s
  clearTimeoutMs: 600000,     // abandon auto-clear if the handoff file never appears within 10 min
  cooldownMs: 60000,          // pause after a sufficient compaction before acting again
  postClearCooldownMs: 90000, // longer pause right after a clear
});

class Autopilot {
  constructor(opts = {}) {
    if (!(opts.compactAt > 0)) throw new Error('compactAt must be > 0');
    if (!(opts.clearAt > 0)) throw new Error('clearAt must be > 0');
    if (opts.clearAt > opts.compactAt) throw new Error('clearAt must be <= compactAt');
    if (!(opts.windowTokens > 0)) throw new Error('windowTokens must be > 0');

    this.compactAt = opts.compactAt;
    this.clearAt = opts.clearAt;
    this.windowTokens = opts.windowTokens;
    this.cfg = { ...DEFAULTS, ...(opts.timing || {}) };

    this.state = STATES.MONITORING;
    this.preCompactTokens = 0;
    this.waitStart = 0;
    this.promptSentAt = 0;
    this.cooldownUntil = 0;
  }

  pct(usedTokens) {
    return Math.round((usedTokens / this.windowTokens) * 1000) / 10;
  }

  // Drive one observation. Returns { action, pct, state }.
  //   input: { usedTokens, now (ms epoch), todoMtime (ms epoch of a non-empty handoff file, else 0) }
  //   action: 'none' | 'compact' | 'prompt' | 'clear' | 'abort-clear' | 'compacted-ok'
  tick(input) {
    const { usedTokens, now, todoMtime = 0 } = input;
    const pct = this.pct(usedTokens);
    let action = 'none';

    switch (this.state) {
      case STATES.MONITORING:
        if (pct >= this.compactAt && now >= this.cooldownUntil) {
          this.preCompactTokens = usedTokens;
          this.waitStart = now;
          this.state = STATES.POST_COMPACT_WAIT;
          action = 'compact';
        }
        break;

      case STATES.POST_COMPACT_WAIT: {
        const dropThreshold = this.preCompactTokens - this.windowTokens * this.cfg.settleDropFraction;
        const settled = usedTokens <= dropThreshold;
        const timedOut = now - this.waitStart >= this.cfg.settleTimeoutMs;
        if (settled || timedOut) {
          if (pct >= this.clearAt) {
            this.promptSentAt = now;
            this.state = STATES.CLEARING;
            action = 'prompt';
          } else {
            this.cooldownUntil = now + this.cfg.cooldownMs;
            this.state = STATES.MONITORING;
            action = 'compacted-ok';
          }
        }
        break;
      }

      case STATES.CLEARING:
        if (todoMtime > this.promptSentAt) {
          this.cooldownUntil = now + this.cfg.postClearCooldownMs;
          this.state = STATES.MONITORING;
          action = 'clear';
        } else if (now - this.promptSentAt >= this.cfg.clearTimeoutMs) {
          this.cooldownUntil = now + this.cfg.cooldownMs;
          this.state = STATES.MONITORING;
          action = 'abort-clear';
        }
        break;

      default:
        break;
    }

    return { action, pct, state: this.state };
  }
}

module.exports = { Autopilot, STATES, DEFAULTS };
