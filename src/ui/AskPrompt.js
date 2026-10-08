import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const h = React.createElement;
const CARD_COLOR = '#afd7ff';
const GRAY = '#888888';

export default function AskPrompt({ question, options, allowCustom = true, onPick }) {
  const allOptions = allowCustom ? [...options, 'Custom answer...'] : options;
  const [sel, setSel] = useState(0);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');

  useInput((char, key) => {
    if (customMode) {
      if (key.return) {
        if (customText.trim()) onPick(customText.trim());
        return;
      }
      if (key.backspace || key.delete) { setCustomText((v) => v.slice(0, -1)); return; }
      if (key.escape) { setCustomMode(false); setCustomText(''); return; }
      if (char && !key.ctrl && !key.meta) setCustomText((v) => v + char);
      return;
    }

    if (key.upArrow) { setSel((s) => (s - 1 + allOptions.length) % allOptions.length); return; }
    if (key.downArrow) { setSel((s) => (s + 1) % allOptions.length); return; }
    if (key.return) {
      const isCustomOption = allowCustom && sel === allOptions.length - 1;
      if (isCustomOption) { setCustomMode(true); return; }
      onPick(allOptions[sel]);
      return;
    }
  });

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: CARD_COLOR, paddingX: 1 },
    h(Box, { justifyContent: 'space-between', marginBottom: 1 },
      h(Text, { color: CARD_COLOR, bold: true }, '✦ INPUT REQUIRED'),
      h(Text, { color: GRAY }, customMode ? '[type custom]' : `[1 of ${allOptions.length}]`)
    ),
    h(Text, { color: 'white', bold: true }, question),
    customMode
      ? h(Box, { marginTop: 1 },
          h(Text, { color: CARD_COLOR, bold: true }, '❯ '),
          h(Text, { color: 'white' }, customText + '█')
        )
      : h(Box, { flexDirection: 'column', marginTop: 1 },
          allOptions.map((opt, i) => {
            const isSel = i === sel;
            return h(
              Box,
              { key: i },
              h(Text, { color: CARD_COLOR }, isSel ? '› ' : '  '),
              h(Text, { color: isSel ? CARD_COLOR : '#999999', bold: isSel }, opt)
            );
          }),
          h(Box, { marginTop: 1 },
            h(Text, { color: GRAY }, '↑↓ select · Enter to pick · Esc to cancel')
          )
        )
  );
}
