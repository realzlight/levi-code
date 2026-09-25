import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const h = React.createElement;
const CYAN = '#22d3ee';
const SOFT = '#c4c4c4';
const GRAY = '#666666';

export default function SessionPicker({ sessions, current, onPick, onCancel }) {
  const [sel, setSel] = useState(Math.max(0, sessions.findIndex((s) => s.id === current)));

  useInput((_, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setSel((sel - 1 + sessions.length) % sessions.length);
    if (key.downArrow) return setSel((sel + 1) % sessions.length);
    if (key.return) return onPick(sessions[sel].id);
  });

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: CYAN, paddingX: 1 },
    sessions.length
      ? sessions.map((s, i) => {
          const isSel = i === sel;
          const label = `SESSION-${s.id}${s.team ? ' [team]' : ''}`;
          return h(
            Box,
            { key: s.id },
            h(Text, { color: CYAN }, s.id === current ? '★ ' : '  '),
            h(Text, { color: isSel ? CYAN : SOFT, bold: isSel }, label.padEnd(18)),
            h(Text, { color: isSel ? SOFT : GRAY }, s.title || s.summary || '(untitled)')
          );
        })
      : h(Text, { color: GRAY }, 'No sessions yet. Use /new'),
    h(Text, { color: GRAY }, '↑↓ select · enter resume · esc cancel')
  );
}
