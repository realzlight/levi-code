import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;
const CYAN = '#22d3ee';
const GRAY = '#737373';
const DIM = '#9ca3af';
const GREEN = '#4ade80';
const YELLOW = '#fbbf24';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export default function SubAgentBar({ subagents = [], width = 80 }) {
  if (!subagents || !subagents.length) return null;

  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % 100), 80);
    return () => clearInterval(timer);
  }, []);

  const spin = SPINNER[frame % SPINNER.length];
  const maxTaskWidth = Math.max(20, width - 24);

  return h(
    Box,
    { flexDirection: 'column', width: '100%', marginBottom: 0 },
    subagents.map((sa) => {
      const roleStr = `@${sa.role || 'subagent'}`;
      const statusStr = sa.status || 'running';
      const isDone = statusStr === 'done' || statusStr === 'completed';
      const statusColor = isDone ? GREEN : YELLOW;
      const statusIcon = isDone ? '✓' : spin;

      let taskPreview = String(sa.task || '').replace(/\s+/g, ' ').trim();
      if (taskPreview.length > maxTaskWidth) {
        taskPreview = taskPreview.slice(0, maxTaskWidth - 1) + '…';
      }

      const actionDetail = sa.action ? ` · ${sa.action}` : '';

      return h(
        Box,
        {
          key: sa.role,
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: CYAN,
          paddingX: 1,
          marginBottom: 0
        },
        h(
          Box,
          { justifyContent: 'space-between', width: '100%' },
          h(
            Box,
            null,
            h(Text, { color: CYAN, bold: true }, '⚡ Subagent '),
            h(Text, { color: '#ffffff', bold: true }, `[${roleStr}]`)
          ),
          h(
            Box,
            null,
            h(Text, { color: statusColor, bold: true }, `${statusIcon} ${statusStr}`),
            actionDetail ? h(Text, { color: DIM }, actionDetail) : null
          )
        ),
        h(
          Box,
          { marginTop: 0 },
          h(Text, { color: GRAY }, '  Task: '),
          h(Text, { color: '#e5e5e5' }, taskPreview)
        )
      );
    })
  );
}
