'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// Read the context window the percentages are measured against. Mirrors the app:
// settings.json -> autoCompactWindow, falling back to 200000.
function readWindowTokens(home = os.homedir(), fallback = 200000) {
  try {
    const raw = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const s = JSON.parse(raw);
    if (s && s.autoCompactWindow > 0) return s.autoCompactWindow;
  } catch { /* ignore */ }
  return fallback;
}

module.exports = { readWindowTokens };
