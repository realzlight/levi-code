import React from 'react';
import { Box, Text } from 'ink';
import { usage } from './args.js';

const h = React.createElement;

const CYAN = '#22d3ee';
const SOFT = '#c4c4c4';
const GRAY = '#666666';
export const MAX_ROWS = 6;

// rows + 2 border lines + 1 hint line
export const paletteHeight = (n) => Math.min(Math.max(n, 1), MAX_ROWS) + 3;

export default function Palette({ matches, active }) {
  const start = Math.max(0, Math.min(active - Math.floor(MAX_ROWS / 2), matches.length - MAX_ROWS));
  const visible = matches.slice(start, start + MAX_ROWS);
  const pad = Math.max(0, ...matches.map((c) => usage(c).length)) + 2;
  const counter = matches.length > MAX_ROWS ? `  ${active + 1}/${matches.length}` : '';

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: CYAN, paddingX: 1 },
    matches.length
      ? visible.map((c, i) => {
          const isSel = start + i === active;
          return h(
            Box,
            { key: c.name },
            h(Text, { color: CYAN }, isSel ? '❯ ' : '  '),
            h(Text, { color: isSel ? CYAN : SOFT, bold: isSel }, usage(c).padEnd(pad)),
            h(Text, { color: isSel ? SOFT : GRAY }, c.description)
          );
        })
      : h(Text, { color: GRAY }, 'No matching commands'),
    h(Text, { color: GRAY }, `↑↓ navigate · tab fill · enter run · esc close${counter}`)
  );
}
