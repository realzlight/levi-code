import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

const h = React.createElement;
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

  return h(Box, { flexDirection: 'column' },
    h(Text, { color: 'white', bold: true }, question),
    customMode
      ? h(Box, { marginTop: 1 },
          h(Text, { color: 'white' }, '\u276F ' + customText + '\u2588')
        )
      : h(Box, { flexDirection: 'column', marginTop: 1 },
          allOptions.map((opt, i) =>
            h(Text, {
              key: i,
              color: i === sel ? 'black' : 'white',
              backgroundColor: i === sel ? '#ffffff' : undefined
            }, (i === sel ? '\u203A ' : '  ') + opt)
          ),
          h(Text, { color: GRAY }, '\u2191\u2193 select \u2022 Enter to pick')
        )
  );
}
