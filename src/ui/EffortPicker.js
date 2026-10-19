import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { EFFORT_LIST } from '../agent/effort.js';

const h = React.createElement;
const CYAN = '#afd7ff';
const SOFT = '#c4c4c4';
const GRAY = '#666666';

export default function EffortPicker({ current, onPick, onCancel }) {
  const currentId = current?.id || current || 'empyrean';
  const initialIndex = Math.max(0, EFFORT_LIST.findIndex((e) => e.id === currentId));
  const [sel, setSel] = useState(initialIndex);

  useInput((_, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setSel((sel - 1 + EFFORT_LIST.length) % EFFORT_LIST.length);
    if (key.downArrow) return setSel((sel + 1) % EFFORT_LIST.length);
    if (key.return) return onPick(EFFORT_LIST[sel]);
  });

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: CYAN, paddingX: 1 },
    h(Box, { justifyContent: 'space-between', marginBottom: 1, height: 1, overflow: 'hidden' },
      h(Text, { color: CYAN, bold: true }, '✦ SELECT EFFORT LEVEL'),
      h(Text, { color: GRAY }, `[active: ${current?.name || 'Empyrean'}]`)
    ),
    EFFORT_LIST.map((e, i) => {
      const isSel = i === sel;
      const isCur = e.id === currentId;
      const indicator = isSel ? '❯ ' : '  ';
      const star = isCur ? '★ ' : '  ';
      return h(
        Box,
        { key: e.id, height: 1, overflow: 'hidden' },
        h(Text, { color: CYAN }, indicator),
        h(Text, { color: isCur ? '#ffd700' : GRAY }, star),
        h(Text, { color: isSel ? CYAN : SOFT, bold: isSel }, e.label.padEnd(18)),
        h(Text, { color: isSel ? '#ffffff' : GRAY }, `: ${e.description}`)
      );
    }),
    h(Box, { marginTop: 1, height: 1, overflow: 'hidden' },
      h(Text, { color: GRAY }, '↑↓ select · enter confirm · esc cancel')
    )
  );
}
