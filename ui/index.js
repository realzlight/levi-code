import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import os from 'os';
import path from 'path';
import terminalImage from 'terminal-image';
import { execaSync } from 'execa';
import { setLatestInput } from './state.js';

const h = React.createElement;
const GRAY = '#888888';
const BORDER = '#999999';
const HIGHLIGHT_BG = '#2a2a2a';
const DOT_COLOR = '#ffffff';

function shortenHome(dir) {
  const home = os.homedir();
  return dir.startsWith(home) ? dir.replace(home, '~') : dir;
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  return size;
}

function messageCost(message) {
  const lineCount = message.role === 'user' ? message.text.split('\n').length : 1;
  return lineCount + 1; // +1 for the message's own marginBottom
}

function computeWindow(messages, scrollOffset, availableRows) {
  const end = Math.max(0, messages.length - scrollOffset);
  let start = end;
  let used = 0;
  while (start > 0) {
    const cost = messageCost(messages[start - 1]);
    if (used + cost > availableRows && start !== end) break;
    used += cost;
    start -= 1;
  }
  return { start, end };
}

function Rule() {
  return h(Box, {
    width: '100%',
    borderStyle: 'single',
    borderTop: true,
    borderBottom: false,
    borderLeft: false,
    borderRight: false,
    borderColor: BORDER
  });
}

function Header({ mascot }) {
  return h(Box, { alignItems: 'center' },
    mascot ? h(Text, null, mascot) : null,
    h(Box, { flexDirection: 'column', marginLeft: mascot ? 3 : 0 },
      h(Text, { color: 'white', bold: true }, 'Levi Code ', h(Text, { color: GRAY }, 'v2.1.25')),
      h(Text, { color: GRAY }, 'Abyssal \u2022 Discussion About CLI'),
      h(Text, { color: GRAY }, os.homedir())
    )
  );
}

function Message({ role, text, width }) {
  if (role === 'user') {
    const lines = text.split('\n');
    return h(Box, { flexDirection: 'column', width, marginBottom: 1 },
      lines.map((line, i) => {
        const prefix = i === 0 ? '\u203A ' : '  ';
        const isBlank = line.trim().length === 0;

        if (isBlank) {
          return h(Text, { key: i }, ' ');
        }

        return h(
          Text,
          { key: i, color: 'white', backgroundColor: HIGHLIGHT_BG },
          (prefix + line).padEnd(width, ' ')
        );
      })
    );
  }

  return h(Box, { marginBottom: 1 },
    h(Text, { color: DOT_COLOR }, '\u25CF'),
    h(Text, { color: 'white' }, ` ${text}`)
  );
}

function InputBox({ value }) {
  const display = value + '\u2588';
  const lines = display.split('\n');
  return h(Box, { flexDirection: 'column' },
    lines.map((line, i) => h(Text, { key: i, color: 'white' }, (i === 0 ? '\u276F ' : '  ') + line))
  );
}

function App({ mascot }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();

  function submit(raw) {
    const text = raw.trim();
    if (!text) return;
    setInput('');
    setScrollOffset(0);
    setLatestInput(text);
    setMessages((prev) => [
      ...prev,
      { role: 'user', text },
      { role: 'agent', text: 'Msg Received' }
    ]);
  }

  useInput((char, key) => {
    if (key.upArrow) {
      setScrollOffset((o) => Math.min(o + 1, messages.length));
      return;
    }

    if (key.downArrow) {
      setScrollOffset((o) => Math.max(o - 1, 0));
      return;
    }

    if (key.return) {
      if (key.ctrl || key.meta) {
        submit(input);
        return;
      }
      const beforeAt = input.length > 1 ? input[input.length - 2] : '';
      const atTouchesText = input.endsWith('@') && beforeAt !== '' && !/\s/.test(beforeAt);
      if (atTouchesText) {
        submit(input.slice(0, -1));
      } else {
        setInput((value) => value + '\n');
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    if (char) {
      setInput((value) => value + char);
    }
  });

  const mascotLines = mascot ? mascot.split('\n').length : 0;
  const headerHeight = Math.max(mascotLines, 3) + 1;
  const inputLines = (input + '\u2588').split('\n').length;
  const inputAreaHeight = 1 + inputLines + 1;
  const footerHeight = 1;
  const hintReserve = 2;
  const availableForMessages = Math.max(1, terminalHeight - headerHeight - inputAreaHeight - footerHeight - hintReserve);

  const { start, end } = computeWindow(messages, scrollOffset, availableForMessages);
  const visibleMessages = messages.slice(start, end);
  const hiddenAbove = start > 0;
  const hiddenBelow = scrollOffset > 0;

  return h(
    Box,
    { flexDirection: 'column', width: terminalWidth, height: terminalHeight },

    h(Box, { flexShrink: 0, flexDirection: 'column', marginBottom: 2 },
      h(Header, { mascot })
    ),

    h(Box, {
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      overflow: 'hidden'
    },
      hiddenAbove ? h(Text, { color: GRAY }, '\u2191 more above \u2014 \u2191 to scroll') : null,
      visibleMessages.map((message, index) =>
        h(Message, { key: start + index, role: message.role, text: message.text, width: terminalWidth })
      ),
      hiddenBelow ? h(Text, { color: GRAY }, '\u2193 \u2193 to return to latest') : null
    ),

    h(Box, { flexShrink: 0, flexDirection: 'column' },
      h(Rule),
      h(InputBox, { value: input }),
      h(Rule)
    ),

    h(Box, { flexShrink: 0, height: 1 },
      h(Text, { color: GRAY }, '/cmd -> Show Commands \u2022 '),
      h(Text, { color: GRAY }, '/help -> Show Helps'),
      h(Text, { color: GRAY }, ' \u2022 /resume -> Select Sessions')
    )
  );
}

let mascot = '';
try {
  mascot = await terminalImage.file(path.join(process.cwd(), 'assets', 'mascot.png'), { width: 10 });
} catch {
  mascot = '';
}

execaSync(process.platform === 'win32' ? 'cls' : 'clear', { shell: true, stdio: 'inherit' });
render(h(App, { mascot }));
