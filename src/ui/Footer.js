import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

const h = React.createElement;
const CYAN = '#666666';
const SOFT = '#c4c4c4';
const GRAY = '#afd7ff';
const GREEN = '#4ade80';
const RED = '#f87171';

const HINTS = [
  ['/', 'commands'],
  ['alt+enter', 'send'],
  ['↑↓', 'scroll'],
  ['ctrl+o', 'tools'],
  ['/help', 'all commands']
];

export function activeModel() {
  try {
    const file = path.join(os.homedir(), '.levi', 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8')).active_model || '';
  } catch {
    return '';
  }
}

const listeners = new Set();
let cachedDiff = null;
let lastCheckTime = 0;
let isDiffChecking = false;
let checkPending = false;

function parseGitOutput(stdout) {
  let added = 0;
  let deleted = 0;
  let hasDiff = false;
  if (!stdout) return null;

  const [diffPart, statusPart] = stdout.split('---STATUS---');

  if (diffPart) {
    for (const line of diffPart.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const a = parseInt(parts[0], 10);
        const d = parseInt(parts[1], 10);
        if (!isNaN(a)) { added += a; hasDiff = true; }
        if (!isNaN(d)) { deleted += d; hasDiff = true; }
      }
    }
  }

  if (statusPart) {
    for (const line of statusPart.trim().split('\n')) {
      if (line.startsWith('?? ')) {
        const rel = line.slice(3).trim();
        if (rel.endsWith('/') || rel.startsWith('.') || rel.includes('node_modules')) continue;
        try {
          const stat = fs.statSync(rel);
          if (stat.isFile() && stat.size < 500000) {
            const count = fs.readFileSync(rel, 'utf8').split('\n').length;
            added += count;
            hasDiff = true;
          }
        } catch {}
      }
    }
  }

  return (hasDiff && (added > 0 || deleted > 0)) ? { added, deleted } : null;
}

export function subscribeGitDiff(cb) {
  listeners.add(cb);
  cb(cachedDiff);
  return () => {
    listeners.delete(cb);
  };
}

function notifyListeners(nextDiff) {
  cachedDiff = nextDiff;
  for (const cb of listeners) {
    try {
      cb(nextDiff);
    } catch {}
  }
}

export function refreshGitDiff(force = true) {
  const now = Date.now();
  if (!force && now - lastCheckTime < 500) {
    if (!checkPending) {
      checkPending = true;
      setTimeout(() => {
        checkPending = false;
        refreshGitDiff(true);
      }, 500 - (now - lastCheckTime));
    }
    return;
  }

  if (isDiffChecking) {
    checkPending = true;
    return;
  }

  isDiffChecking = true;
  lastCheckTime = now;

  const cmd = 'git diff HEAD --numstat 2>/dev/null; echo "---STATUS---"; git status --porcelain 2>/dev/null';
  exec(cmd, { timeout: 1500 }, (err, stdout) => {
    isDiffChecking = false;
    const nextDiff = parseGitOutput(stdout);
    notifyListeners(nextDiff);

    if (checkPending) {
      checkPending = false;
      setTimeout(() => refreshGitDiff(true), 80);
    }
  });
}

export function fetchGitDiff(cb) {
  if (cb) {
    const unsub = subscribeGitDiff(cb);
    refreshGitDiff(true);
    return unsub;
  }
  refreshGitDiff(true);
}

export default function Footer({ width, model }) {
  const [diff, setDiff] = useState(cachedDiff);

  useEffect(() => {
    const unsub = subscribeGitDiff(setDiff);
    refreshGitDiff(true);

    let gitWatcher = null;
    let gitWatchTimer = null;
    try {
      if (fs.existsSync('.git')) {
        gitWatcher = fs.watch('.git', (event, filename) => {
          if (!filename || filename === 'index' || filename === 'HEAD' || filename.startsWith('refs') || filename === 'COMMIT_EDITMSG') {
            clearTimeout(gitWatchTimer);
            gitWatchTimer = setTimeout(() => refreshGitDiff(true), 80);
          }
        });
      }
    } catch {}

    const pollTimer = setInterval(() => {
      refreshGitDiff(false);
    }, 1500);

    return () => {
      unsub();
      clearTimeout(gitWatchTimer);
      if (gitWatcher) {
        try { gitWatcher.close(); } catch {}
      }
      clearInterval(pollTimer);
    };
  }, []);

  const cwd = process.cwd();
  const home = os.homedir();
  const shortCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;

  const diffParts = [];
  if (diff?.added > 0) diffParts.push(`+${diff.added}`);
  if (diff?.deleted > 0) diffParts.push(`-${diff.deleted}`);
  const diffStr = diffParts.length ? `${diffParts.join(' ')} · ` : '';

  const rightText = model ? `${shortCwd} · ◆ ${model}` : shortCwd;
  const rightFull = diffStr + rightText;
  let used = rightFull ? rightFull.length + 3 : 0;
  const shown = [];

  for (const [k, d] of HINTS) {
    const w = k.length + 1 + d.length + (shown.length ? 3 : 0);
    if (used + w > width - 2) break;
    shown.push([k, d]);
    used += w;
  }

  return h(
    Box,
    { flexShrink: 0, height: 1, width, justifyContent: 'space-between' },
    h(
      Box,
      null,
      shown.map(([k, d], i) =>
        h(
          Text,
          { key: k },
          i ? h(Text, { color: GRAY }, ' · ') : null,
          h(Text, { color: CYAN }, k),
          h(Text, { color: GRAY }, ` ${d}`)
        )
      )
    ),
    h(
      Box,
      null,
      diff ? h(
        Box,
        null,
        diff.added > 0 ? h(Text, { color: GREEN, bold: true }, `+${diff.added}`) : null,
        diff.added > 0 && diff.deleted > 0 ? h(Text, { color: '#888888' }, ' ') : null,
        diff.deleted > 0 ? h(Text, { color: RED, bold: true }, `-${diff.deleted}`) : null,
        h(Text, { color: '#666666' }, ' · ')
      ) : null,
      rightText ? h(Text, { color: SOFT }, rightText) : null
    )
  );
}
