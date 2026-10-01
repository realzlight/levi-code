import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;
const GRAY = '#888888';
const BORDER = '#555555';
const CYAN = '#22d3ee';
const GREEN = '#4ade80';
const GOLD = '#ffd700';

const SPARKS = ['✦', '✧', '★', '☆', '✶', '✸', '✹', '✺'];

// output: null | { kind: 'text', text } | { kind: 'panel', title, fields: [{label, value, color?}] } | { kind: 'init', ... }
export default function CommandBar({ output }) {
  if (!output) return null;

  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % 1000);
    }, 90);
    return () => clearInterval(timer);
  }, []);

  const spark = SPARKS[frame % SPARKS.length];

  if (output.kind === 'text') {
    return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: BORDER, paddingX: 1 },
      output.text.split('\n').map((line, i) => h(Text, { key: i, color: 'white' }, line)),
      h(Text, { color: GRAY }, 'Esc to close')
    );
  }

  // Specialized animated init layout
  if (output.kind === 'init') {
    const barLength = 22;
    // Animate progress bar filling up over ~10 frames (approx 900ms) to 100%
    const fillCount = Math.min(barLength, Math.max(3, Math.floor(((frame % 30) + 1) * 2.5)));
    const pct = Math.min(100, Math.floor((fillCount / barLength) * 100));

    return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: CYAN, paddingX: 1 },
      h(Box, { justifyContent: 'space-between', marginBottom: 1 },
        h(Text, { color: 'white', bold: true },
          h(Text, { color: CYAN }, `${spark} `),
          output.title || 'LEVI Workspace Initialized'
        ),
        h(Text, { color: GREEN, bold: true }, '[✓ Ready]')
      ),
      h(Box, { marginBottom: 1 },
        h(Text, { color: CYAN }, '  Progress: '),
        h(Text, { color: GREEN }, '█'.repeat(fillCount)),
        h(Text, { color: '#333333' }, '░'.repeat(Math.max(0, barLength - fillCount))),
        h(Text, { color: pct === 100 ? GREEN : GOLD }, ` ${pct}%`)
      ),
      (output.fields || []).map((f, i) =>
        h(Box, { key: i },
          h(Text, { color: CYAN }, '  ▸ '),
          h(Text, { color: GRAY }, (f.label + ': ').padEnd(15, ' ')),
          h(Text, { color: f.color || 'white' }, f.value)
        )
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: GRAY }, '  Esc to close · Ready for pair programming')
      )
    );
  }

  // Standard panel
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: output.borderColor || BORDER, paddingX: 1 },
    h(Box, { justifyContent: 'space-between' },
      h(Text, { color: 'white', bold: true }, output.title),
      output.status ? h(Text, { color: GREEN }, `[${output.status}]`) : null
    ),
    (output.fields || []).map((f, i) =>
      h(Box, { key: i },
        h(Text, { color: GRAY }, f.label + ': '),
        h(Text, { color: f.color || 'white' }, f.value)
      )
    ),
    h(Text, { color: GRAY }, 'Esc to close')
  );
}
