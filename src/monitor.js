'use strict';
// Pure state machine for the context autopilot. No I/O, no timers, no PTY — it just decides what
// SHOULD happen given the current usage and clock. This is what the unit tests exercise.
//
//   MONITORING        : watching usage.
//                         - at >= noCompactAt% (if set) -> emit 'prompt-nocompact'. Context is too
//                           high to compact safely, so we skip /compact entirely and go straight to a
//                           user-confirmed handoff (dump todo, ask the user, let them add items).
//                         - else at >= compactAt% -> emit 'compact'.
//   POST_COMPACT_WAIT  : compaction issued; wait for it to settle (usage drops, or timeout).
//                         If still >= clearAt% after settling -> emit 'prompt' (ask user to hand off).
//                         Otherwise -> back to MONITORING with a cooldown.
//   CLEARING           : a handoff prompt was sent; behaviour depends on how we got here:
//                         - from POST_COMPACT_WAIT: clears as soon as a fresh todo file is saved.
//                         - from the no-compact ceiling: ALSO waits for the user's confirmation
//                           marker, so the user has time to add/edit todo items before the /clear.
//                         If the handoff never lands before the timeout -> emit 'abort-clear'.

const STATES = Object.freeze({
  MONITORING: 'MONITORING',
  POST_COMPACT_WAIT: 'POST_COMPACT_WAIT',
  CLEARING: 'CLEARING',
});

const DEFAULTS = Object.freeze({
  settleDropFraction: 0.05,   // usage must fall by >= 5% of window to count as "compaction settled"
  settleTimeoutMs: 150000,    // ...or give up waiting after 150s
  clearTimeoutMs: 600000,     // abandon a post-compact auto-clear if the file never appears (10 min)
  confirmTimeoutMs: 1800000,  // a human is in the loop on the no-compact path, so wait longer (30 min)
  cooldownMs: 60000,          // pause after a sufficient compaction before acting again
  postClearCooldownMs: 90000, // longer pause right after a clear
});

class Autopilot {
  constructor(opts = {}) {
    if (!(opts.compactAt > 0)) throw new Error('compactAt must be > 0');
    if (!(opts.clearAt > 0)) throw new Error('clearAt must be > 0');
    if (opts.clearAt > opts.compactAt) throw new Error('clearAt must be <= compactAt');
    if (!(opts.windowTokens > 0)) throw new Error('windowTokens must be > 0');

    // noCompactAt is optional. 0 (default) disables the ceiling -> classic compact-then-maybe-clear.
    // When set it must sit AT or ABOVE compactAt: it's a higher zone where compaction is skipped.
    this.noCompactAt = opts.noCompactAt > 0 ? opts.noCompactAt : 0;
    if (this.noCompactAt && this.noCompactAt < opts.compactAt) {
      throw new Error('noCompactAt must be >= compactAt');
    }

    this.compactAt = opts.compactAt;
    this.clearAt = opts.clearAt;
    this.windowTokens = opts.windowTokens;
    this.cfg = { ...DEFAULTS, ...(opts.timing || {}) };

    this.state = STATES.MONITORING;
    this.preCompactTokens = 0;
    this.waitStart = 0;
    this.promptSentAt = 0;
    this.cooldownUntil = 0;
    this.clearNeedsConfirm = false; // set per-episode when CLEARING is entered via the no-compact path
  }

  pct(usedTokens) {
    return Math.round((usedTokens / this.windowTokens) * 1000) / 10;
  }

  // Drive one observation. Returns { action, pct, state }.
  //   input: { usedTokens, now (ms epoch),
  //            todoMtime (ms epoch of a non-empty handoff file, else 0),
  //            handoffConfirmed (bool: user-confirmation marker present in the handoff file) }
  //   action: 'none' | 'compact' | 'prompt' | 'prompt-nocompact' | 'awaiting-confirm'
  //         | 'clear' | 'abort-clear' | 'compacted-ok'
  tick(input) {
    const { usedTokens, now, todoMtime = 0, handoffConfirmed = false } = input;
    const pct = this.pct(usedTokens);
    let action = 'none';

    switch (this.state) {
      case STATES.MONITORING:
        if (now < this.cooldownUntil) break;
        if (this.noCompactAt && pct >= this.noCompactAt) {
          // Too high to compact safely — go straight to a user-confirmed handoff, no /compact.
          this.promptSentAt = now;
          this.clearNeedsConfirm = true;
          this.state = STATES.CLEARING;
          action = 'prompt-nocompact';
        } else if (pct >= this.compactAt) {
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
            this.clearNeedsConfirm = false; // post-compact handoff clears on save (unchanged behaviour)
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

      case STATES.CLEARING: {
        const fresh = todoMtime > this.promptSentAt;
        const confirmed = !this.clearNeedsConfirm || handoffConfirmed === true;
        const timeoutMs = this.clearNeedsConfirm ? this.cfg.confirmTimeoutMs : this.cfg.clearTimeoutMs;
        if (fresh && confirmed) {
          this.cooldownUntil = now + this.cfg.postClearCooldownMs;
          this.state = STATES.MONITORING;
          this.clearNeedsConfirm = false;
          action = 'clear';
        } else if (fresh && this.clearNeedsConfirm) {
          // Todo is written but the user hasn't confirmed (added items) yet — keep waiting, don't clear.
          action = 'awaiting-confirm';
        } else if (now - this.promptSentAt >= timeoutMs) {
          this.cooldownUntil = now + this.cfg.cooldownMs;
          this.state = STATES.MONITORING;
          this.clearNeedsConfirm = false;
          action = 'abort-clear';
        }
        break;
      }

      default:
        break;
    }

    return { action, pct, state: this.state };
  }
}

module.exports = { Autopilot, STATES, DEFAULTS };
