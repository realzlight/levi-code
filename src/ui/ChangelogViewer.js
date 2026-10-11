import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
const h = React.createElement;

export default function ChangelogViewer({ content, onClose, width, height }) {
  const lines = content.split('\n');
  const [offset, setOffset] = useState(0);
  const visible = Math.max(1, height - 5);

  useInput((_, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) setOffset(o => Math.max(0, o - 1));
    if (key.downArrow) setOffset(o => Math.min(Math.max(0, lines.length - visible), o + 1));
    if (key.pageUp) setOffset(o => Math.max(0, o - visible));
    if (key.pageDown) setOffset(o => Math.min(Math.max(0, lines.length - visible), o + visible));
  });

  const slice = lines.slice(offset, offset + visible);

  return h(Box, {
    flexDirection: 'column',
    width,
    height,
    borderStyle: 'round',
    borderColor: '#22d3ee',
    paddingX: 2,
    paddingY: 0,
  },
    h(Box, { justifyContent: 'space-between', marginBottom: 1 },
      h(Text, { color: '#22d3ee', bold: true }, '☾  CHANGELOG'),
      h(Text, { color: '#555' }, 'Esc close  ↑↓ scroll  PgUp/Dn page')
    ),
    ...slice.map((line, i) => {
      const isH1 = line.startsWith('# ');
      const isH2 = line.startsWith('## ');
      const isH3 = line.startsWith('### ');
      const isBullet = line.startsWith('- ');
      const color = isH1 ? '#22d3ee'
                  : isH2 ? '#a78bfa'
                  : isH3 ? '#34d399'
                  : isBullet ? '#e2e8f0'
                  : '#999';
      const bold = isH1 || isH2 || isH3;
      const text = isH1 ? line.slice(2)
                 : isH2 ? line.slice(3)
                 : isH3 ? line.slice(4)
                 : line;
      return h(Text, { key: i, color, bold }, text || ' ');
    }),
    h(Box, { marginTop: 1 },
      h(Text, { color: '#444' }, `${offset + 1}–${Math.min(offset + visible, lines.length)} / ${lines.length} lines`)
    )
  );
}
