import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { filterCommands, runCommand } from './commands.js';
import { usage } from './args.js';

const h = React.createElement;

const CYAN = '#22d3ee';
const SOFT = '#c4c4c4';
const GRAY = '#666666';
const MAX_ROWS = 6;

export default function Prompt({ onChat }) {
  const { exit } = useApp();
  const [value, setValue] = useState('');
  const [sel, setSel] = useState(0);
  const [closed, setClosed] = useState(false);
  const [log, setLog] = useState([]);

  // palette shows while typing the command name, hides once a space starts the args
  const paletteOn = value.startsWith('/') && !/\s/.test(value) && !closed;
  const matches = paletteOn ? filterCommands(value.slice(1)) : [];
  const active = Math.min(sel, Math.max(matches.length - 1, 0));

  const print = (t) => setLog((l) => [...l, String(t)].slice(-40));
  const ctx = { print, clear: () => setLog([]), exit };

  const edit = (next) => {
    setValue(next);
    setSel(0);
    setClosed(false);
  };

  const submit = async (text) => {
    const line = text.trim();
    if (!line) return;
    setValue('');
    setSel(0);
    setClosed(false);
    print(`❯ ${line}`);
    if (line.startsWith('/')) await runCommand(line, ctx);
    else if (onChat) await onChat(line, ctx);
    else print('Chat is not wired yet. Type / for commands.');
  };

  useInput((input, key) => {
    if (paletteOn && matches.length) {
      if (key.upArrow) return setSel((active - 1 + matches.length) % matches.length);
      if (key.downArrow) return setSel((active + 1) % matches.length);
      if (key.tab) return edit(`/${matches[active].name} `);
      if (key.return) {
        const cmd = matches[active];
        const needsArgs = (cmd.args || []).some((a) => a.required);
        return needsArgs ? edit(`/${cmd.name} `) : submit(`/${cmd.name}`);
      }
    }
    if (key.escape) return setClosed(true);
    if (key.return) return submit(value);
    if (key.backspace || key.delete) return edit(value.slice(0, -1));
    if (input && !key.ctrl && !key.meta) edit(value + input);
  });

  // scroll window around the selected row
  const start = Math.max(0, Math.min(active - Math.floor(MAX_ROWS / 2), matches.length - MAX_ROWS));
  const visible = matches.slice(start, start + MAX_ROWS);
  const pad = Math.max(0, ...matches.map((c) => usage(c).length)) + 2;
  const counter = matches.length > MAX_ROWS ? `  ${active + 1}/${matches.length}` : '';

  const palette = paletteOn
    ? h(
        Box,
        { flexDirection: 'column', borderStyle: 'round', borderColor: GRAY, paddingX: 1 },
        matches.length
          ? visible.map((c, i) => {
              const isSel = start + i === active;
              return h(
                Box,
                { key: c.name },
                h(Text, { color: CYAN }, isSel ? '❯ ' : '  '),
                h(Text, { color: isSel ? CYAN : SOFT, bold: isSel }, usage(c).padEnd(pad)),
                h(Text, { color: isSel ? SOFT : GRAY }, c.description)
              );
            })
          : h(Text, { color: GRAY }, 'No matching commands'),
        h(Text, { color: GRAY }, `↑↓ navigate · tab fill · enter run · esc close${counter}`)
      )
    : null;

  return h(
    Box,
    { flexDirection: 'column' },
    log.length
      ? h(
          Box,
          { flexDirection: 'column', marginBottom: 1 },
          log.map((l, i) => h(Text, { key: i, color: SOFT }, l))
        )
      : null,
    h(
      Box,
      { borderStyle: 'round', borderColor: paletteOn ? CYAN : GRAY, paddingX: 1 },
      h(Text, { color: CYAN }, '❯ '),
      h(Text, null, value),
      h(Text, { inverse: true }, ' ')
    ),
    palette
  );
}
