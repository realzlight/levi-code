import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;
const GRAY = '#888888';
const GREEN = '#4ade80';
const RED = '#f87171';

const PUSH_STEPS = [
  { id: 'auth', label: 'Checking login' },
  { id: 'repo', label: 'Preparing local repo' },
  { id: 'remote', label: 'Connecting to GitHub' },
  { id: 'commit', label: 'Committing changes' },
  { id: 'push', label: 'Pushing' }
];

const SYNC_STEPS = [
  { id: 'check', label: 'Checking remote' },
  { id: 'fetch', label: 'Fetching from GitHub' },
  { id: 'reset', label: 'Replacing local files' }
];

function Spinner({ frame }) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  return h(Text, { color: 'white' }, frames[frame % frames.length]);
}

function StepLine({ step, state, frame }) {
  if (!state) {
    return h(Text, { color: GRAY }, '  ' + step.label);
  }
  if (state.status === 'running') {
    return h(Box, null, h(Spinner, { frame }), h(Text, { color: 'white' }, ' ' + step.label + (state.detail ? ' — ' + state.detail : '')));
  }
  if (state.status === 'error') {
    return h(Box, { flexDirection: 'column' },
      h(Text, { color: RED }, '✗ ' + step.label),
      state.detail ? h(Text, { color: RED }, '  ' + state.detail) : null
    );
  }
  return h(Text, { color: GREEN }, '✓ ' + step.label + (state.detail ? ' — ' + state.detail : ''));
}

// mode: 'push' | 'sync'. onDone(success: boolean) called when the operation finishes.
export default function MemSync({ mode, onDone }) {
  const steps = mode === 'push' ? PUSH_STEPS : SYNC_STEPS;
  const [states, setStates] = useState({});
  const [frame, setFrame] = useState(0);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const { runMemPush, runMemSync } = await import('../commands/mem.js');
      const runner = mode === 'push' ? runMemPush : runMemSync;

      const ok = await runner((id, status, detail) => {
        if (cancelled) return;
        setStates((prev) => ({ ...prev, [id]: { status, detail } }));
      });

      if (!cancelled) {
        setFinished(true);
        setTimeout(() => onDone?.(ok), 1200);
      }
    }

    run();
    return () => { cancelled = true; };
  }, [mode]);

  const CARD_COLOR = '#afd7ff';

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: CARD_COLOR, paddingX: 1 },
    h(Box, { justifyContent: 'space-between', marginBottom: 1 },
      h(Text, { color: CARD_COLOR, bold: true }, mode === 'push' ? '✦ SYNC TO GITHUB' : '✦ SYNC FROM GITHUB'),
      h(Text, { color: finished ? GREEN : CARD_COLOR }, finished ? '[✓ complete]' : '[syncing]')
    ),
    h(Box, { flexDirection: 'column' },
      steps.map((step) => h(StepLine, { key: step.id, step, state: states[step.id], frame }))
    ),
    finished ? h(Box, { marginTop: 1 }, h(Text, { color: GRAY }, 'Operation completed.')) : null
  );
}
