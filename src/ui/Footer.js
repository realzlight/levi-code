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

let cachedDiff = null;
let lastCheckTime = 0;
let isDiffChecking = false;

function fetchGitDiff(cb) {
  const now = Date.now();
  if (now - lastCheckTime < 2500 && cachedDiff !== null) {
    return cb(cachedDiff);
  }
  if (isDiffChecking) return cb(cachedDiff);
  isDiffChecking = true;
  lastCheckTime = now;

  exec('git diff HEAD --numstat 2>/dev/null', { timeout: 1200 }, (err, stdout) => {
    isDiffChecking = false;
    if (err || !stdout) {
      cachedDiff = null;
      return cb(null);
    }
    let added = 0;
    let deleted = 0;
    for (const line of stdout.trim().split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const a = parseInt(parts[0], 10);
        const d = parseInt(parts[1], 10);
        if (!isNaN(a)) added += a;
        if (!isNaN(d)) deleted += d;
      }
    }
    cachedDiff = (added > 0 || deleted > 0) ? { added, deleted } : null;
    cb(cachedDiff);
  });
}

export default function Footer({ width, model }) {
  const [diff, setDiff] = useState(cachedDiff);

  useEffect(() => {
    let mounted = true;
    fetchGitDiff((stats) => { if (mounted) setDiff(stats); });
    const timer = setInterval(() => {
      fetchGitDiff((stats) => { if (mounted) setDiff(stats); });
    }, 4000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  const cwd = process.cwd();
  const home = os.homedir();
  const shortCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;

  const diffStr = diff ? `+${diff.added} -${diff.deleted} · ` : '';
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
        h(Text, { color: GREEN, bold: true }, `+${diff.added}`),
        h(Text, { color: '#888888' }, ' '),
        h(Text, { color: RED, bold: true }, `-${diff.deleted}`),
        h(Text, { color: '#666666' }, ' · ')
      ) : null,
      rightText ? h(Text, { color: SOFT }, rightText) : null
    )
  );
}
