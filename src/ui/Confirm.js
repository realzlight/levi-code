import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const h = React.createElement;
const CARD_COLOR = '#afd7ff';
const GRAY = '#888888';
const RED = '#f87171';

export default function Confirm({ message, warning, options = ['Yes', 'Cancel'], onConfirm, onCancel }) {
  const [sel, setSel] = useState(options.length - 1); // default to the safe option

  useInput((char, key) => {
    if (key.upArrow) { setSel((s) => (s - 1 + options.length) % options.length); return; }
    if (key.downArrow) { setSel((s) => (s + 1) % options.length); return; }
    if (key.return) {
      if (sel === 0) onConfirm?.();
      else onCancel?.();
      return;
    }
    if (key.escape) { onCancel?.(); return; }
  });

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: CARD_COLOR, paddingX: 1 },
    h(Box, { justifyContent: 'space-between', marginBottom: 1 },
      h(Text, { color: CARD_COLOR, bold: true }, '✦ CONFIRMATION'),
      h(Text, { color: GRAY }, '[action required]')
    ),
    h(Text, { color: RED, bold: true }, message),
    warning ? h(Box, { marginTop: 1 }, h(Text, { color: GRAY }, warning)) : null,
    h(Box, { flexDirection: 'column', marginTop: 1 },
      options.map((opt, i) => {
        const isSel = i === sel;
        return h(
          Box,
          { key: i },
          h(Text, { color: CARD_COLOR }, isSel ? '› ' : '  '),
          h(Text, {
            color: isSel ? 'black' : 'white',
            backgroundColor: isSel ? (i === 0 ? RED : CARD_COLOR) : undefined,
            bold: isSel
          }, ` ${opt} `)
        );
      })
    ),
    h(Box, { marginTop: 1 },
      h(Text, { color: GRAY }, '↑↓ select · Enter to pick · Esc to cancel')
    )
  );
}
