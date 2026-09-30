import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;
const GRAY = '#888888';
const BORDER = '#555555';

// output: null | { kind: 'text', text } | { kind: 'panel', title, fields: [{label, value, color?}] }
export default function CommandBar({ output }) {
  if (!output) return null;

  if (output.kind === 'text') {
    return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: BORDER, paddingX: 1 },
      output.text.split('\n').map((line, i) => h(Text, { key: i, color: 'white' }, line))
    );
  }

  // panel
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: BORDER, paddingX: 1 },
    h(Text, { color: 'white', bold: true }, output.title),
    output.fields.map((f, i) =>
      h(Box, { key: i },
        h(Text, { color: GRAY }, f.label + ': '),
        h(Text, { color: f.color || 'white' }, f.value)
      )
    )
  );
}
