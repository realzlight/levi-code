import React from 'react';
import { Box, Text } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = React.createElement;
const CYAN = '#22d3ee';
const SOFT = '#c4c4c4';
const GRAY = '#666666';

const HINTS = [
  ['/', 'commands'],
  ['alt+enter', 'send'],
  ['↑↓', 'scroll'],
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

export default function Footer({ width, model }) {
  const right = model ? `◆ ${model}` : '';
  let used = right ? right.length + 3 : 0;
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
    right ? h(Text, { color: SOFT }, right) : null
  );
}
