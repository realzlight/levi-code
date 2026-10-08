import React, { useEffect, useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

const h = React.createElement;
const GRAY = '#888888';
const GREEN = '#4ade80';
const RED = '#f87171';
const CYAN = '#afd7ff';
const LAVENDER = '#c0caf5';

const COMPACT_STEPS = [
  { id: 'read', label: 'Reading session buffer' },
  { id: 'summarize', label: 'Generating conversation summary' },
  { id: 'extract', label: 'Extracting durable facts & patterns' },
  { id: 'write', label: 'Saving compacted buffer' }
];

function Spinner({ frame }) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  return h(Text, { color: CYAN }, frames[frame % frames.length]);
}

function StepLine({ step, state, frame }) {
  if (!state) {
    return h(Text, { color: GRAY }, '  ' + step.label);
  }
  if (state.status === 'running') {
    return h(Box, null,
      h(Spinner, { frame }),
      h(Text, { color: 'white' }, ' ' + step.label + (state.detail ? ' — ' + state.detail : ''))
    );
  }
  if (state.status === 'error') {
    return h(Box, { flexDirection: 'column' },
      h(Text, { color: RED }, '✗ ' + step.label),
      state.detail ? h(Text, { color: RED }, '  ' + state.detail) : null
    );
  }
  return h(Text, { color: GREEN }, '✓ ' + step.label + (state.detail ? ' — ' + state.detail : ''));
}

export default function CompactProgress({ sessionId, onDone }) {
  const [states, setStates] = useState({});
  const [frame, setFrame] = useState(0);
  const [finished, setFinished] = useState(false);
  const [result, setResult] = useState(null);
  const resultRef = useRef(null);

  useEffect(() => {
    const interval = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(interval);
  }, []);

  useInput((input, key) => {
    if (key.escape || (finished && key.return)) {
      onDone?.(resultRef.current);
    }
  });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const { compact } = await import('../agent/compact.js');
      const { getProject } = await import('../agent/session.js');
      const project = sessionId ? getProject(sessionId) : null;

      const res = await compact(sessionId, project, {
        force: true,
        onProgress: (id, status, detail) => {
          if (cancelled) return;
          setStates((prev) => ({ ...prev, [id]: { status, detail } }));
        }
      });

      if (!cancelled) {
        resultRef.current = res;
        setResult(res);
        setFinished(true);
        // Auto-dismiss after 3 seconds if user doesn't press Enter/Esc
        setTimeout(() => {
          if (!cancelled) onDone?.(res);
        }, 3000);
      }
    }

    run();
    return () => { cancelled = true; };
  }, [sessionId]);

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: finished ? (result?.ok ? GREEN : RED) : CYAN, paddingX: 1, paddingY: 0 },
    h(Box, { justifyContent: 'space-between', marginBottom: 1 },
      h(Text, { color: CYAN, bold: true }, `✦ COMPACTING SESSION-${sessionId || '?'}`),
      finished ? h(Text, { color: GRAY }, '[press enter/esc]') : null
    ),
    h(Box, { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
      COMPACT_STEPS.map((step) => h(StepLine, { key: step.id, step, state: states[step.id], frame }))
    ),
    finished && result
      ? (result.ok
          ? h(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: GREEN, paddingX: 1 },
              h(Text, { color: GREEN, bold: true }, '✓ Compaction complete!'),
              h(Text, { color: 'white' }, `  Folded: ${result.compactedCount} messages · Kept: ${result.keptCount} recent`),
              result.summary ? h(Text, { color: LAVENDER }, `  Summary: ${result.summary}`) : null
            )
          : h(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: RED, paddingX: 1 },
              h(Text, { color: RED, bold: true }, result.error ? '✗ Compaction failed' : 'ℹ Compaction skipped'),
              h(Text, { color: 'white' }, `  ${result.error || result.reason || 'Unknown issue'}`)
            ))
      : null
  );
}
