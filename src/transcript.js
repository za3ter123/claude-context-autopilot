'use strict';
// Token-free context measurement. Reads the active session's transcript JSONL straight off disk
// and sums the same fields the in-app context meter uses. Never calls the API.

const os = require('os');
const path = require('path');
const fs = require('fs');

// ~/.claude/projects encodes a project path by replacing every \ / and : with a dash.
// Works for both Windows ("C:\Users\Win") and POSIX ("/Users/win/app") paths.
function encodeProjectDir(projectPath) {
  return projectPath.replace(/[\\/:]/g, '-');
}

function transcriptDir(projectPath, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', encodeProjectDir(projectPath));
}

// output_tokens is excluded: it is the reply, not context fed in (and it is already folded into
// the NEXT turn's input_tokens).
function usedTokensFromUsage(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
       + (usage.cache_creation_input_tokens || 0)
       + (usage.cache_read_input_tokens || 0);
}

function usedPct(usedTokens, windowTokens) {
  if (!windowTokens || windowTokens <= 0) return 0;
  return Math.round((usedTokens / windowTokens) * 1000) / 10; // 1 dp
}

function newestJsonl(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f);
      try { return { full, mtime: fs.statSync(full).mtimeMs }; }
      catch { return null; }
    })
    .filter(Boolean);
  if (!entries.length) return null;
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries[0].full;
}

// Read only the tail of the file (transcripts grow large); good enough to find the latest usage.
function tailLines(file, maxBytes = 65536) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8').split(/\r?\n/);
  } finally {
    fs.closeSync(fd);
  }
}

// Returns used-token total of the most recent turn, or -1 if no session/usage found.
function readCurrentUsage(dir) {
  const file = newestJsonl(dir);
  if (!file) return -1;
  let lines;
  try { lines = tailLines(file); } catch { return -1; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln) continue;
    let obj;
    try { obj = JSON.parse(ln); } catch { continue; }
    const usage = obj && obj.message && obj.message.usage;
    if (usage) return usedTokensFromUsage(usage);
  }
  return -1;
}

module.exports = {
  encodeProjectDir,
  transcriptDir,
  usedTokensFromUsage,
  usedPct,
  newestJsonl,
  readCurrentUsage,
};
