import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const h = React.createElement;
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

  return h(Box, { flexDirection: 'column' },
    h(Text, { color: RED, bold: true }, message),
    warning ? h(Text, { color: GRAY }, warning) : null,
    h(Box, { flexDirection: 'column', marginTop: 1 },
      options.map((opt, i) =>
        h(Text, {
          key: i,
          color: i === sel ? 'black' : 'white',
          backgroundColor: i === sel ? (i === 0 ? RED : '#ffffff') : undefined
        }, (i === sel ? '\u203A ' : '  ') + opt)
      )
    ),
    h(Text, { color: GRAY }, '\n\u2191\u2193 select \u2022 Enter to pick \u2022 Esc to cancel')
  );
}
