import { getGreeting } from "./greetings.js";
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useStdout, useApp } from 'ink';
import os from 'os';
import terminalImage from 'terminal-image';
import { execaSync } from 'execa';
import { setLatestInput } from './state.js';
import Palette, { paletteHeight } from './Palette.js';
import Footer, { activeModel } from './Footer.js';
import ModelForm from './ModelForm.js';
import SessionPicker from './SessionPicker.js';
import { filterCommands, runCapture } from './commands.js';
import { currentSessionId, getTitle, setTitle, appendMessage, loadMessages, resumeSession, getSummary } from '../agent/session.js';
import { generateTitle } from '../agent/title.js';
import { runAgent } from '../agent/loop.js';
import { maybeCompact } from '../agent/compact.js';
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from 'node:readline/promises';

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
  const lineCount = message.text.split('\n').length;
  return lineCount + 1;
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

const GREETING = getGreeting();

function sessionLine() {
  const id = currentSessionId();
  if (!id) return 'Abyssal \u2022 Discussion About CLI';
  const title = getTitle(id);
  return `SESSION-${id}${title ? ' \u2014 ' + title : ''}`;
}

function Header({ mascot }) {
  return h(Box, { alignItems: 'center' },
    mascot ? h(Text, null, mascot) : null,
    h(Box, { flexDirection: 'column', marginLeft: mascot ? 3 : 0 },
      h(Text, { color: 'white', bold: true }, 'Levi Code ', h(Text, { color: GRAY }, 'v2.1.25')),
      h(Text, { color: GRAY }, sessionLine()),
      h(Text, { color: '#c4c4c4' }, GREETING)
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

let savedMessages = [];
let app;

function App({ mascot }) {
  const [messages, setMessages] = useState(savedMessages);
  useEffect(() => { savedMessages = messages; }, [messages]);

  const [input, setInput] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [sel, setSel] = useState(0);
  const [form, setForm] = useState(null);
  const [closed, setClosed] = useState(false);
  const { exit } = useApp();
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();
  const paletteOn = input.startsWith('/') && !input.includes(' ') && !closed;
  const matches = paletteOn ? filterCommands(input.slice(1)) : [];
  const active = Math.min(sel, Math.max(matches.length - 1, 0));
  useEffect(() => { setSel(0); setClosed(false); }, [input]);
  const fill = (cmd) => setInput('/' + cmd.name + ' ');

  async function runSlash(text) {
    setMessages((prev) => [...prev, { role: 'user', text }]);
    const out = await runCapture(text, { clear: () => setMessages([]), exit, suspend, openForm: setForm });
    if (out) setMessages((prev) => [...prev, { role: 'agent', text: out }]);
  }

  function submit(raw) {
    const text = raw.trim();
    if (!text) return;
    setInput('');
    setScrollOffset(0);
    setLatestInput(text);
    if (text.startsWith('/')) { runSlash(text); return; }

    setMessages((prev) => [...prev, { role: 'user', text }, { role: 'agent', text: '...' }]);

    (async () => {
      const id = currentSessionId();
      if (id && !getTitle(id)) setTitle(id, await generateTitle(text));

      const onStep = (kind, data) => {
        if (kind === 'tool_call') {
          setMessages((prev) => [...prev.slice(0, -1), { role: 'agent', text: `${data.name}(${JSON.stringify(data.args)})` }]);
        }
      };

      let reply;
      try {
        reply = await runAgent(text, { onStep });
      } catch (e) {
        reply = `Error: ${e.message}`;
      }

      appendMessage(id, 'user', text);
      appendMessage(id, 'agent', reply);
      setMessages((prev) => [...prev.slice(0, -1), { role: 'agent', text: reply }]);
      maybeCompact(id);
    })();
  }

  useInput((char, key) => {
    if (form) return;
    if (paletteOn && matches.length) {
      if (key.upArrow) { setSel((active - 1 + matches.length) % matches.length); return; }
      if (key.downArrow) { setSel((active + 1) % matches.length); return; }
      if (key.tab) { fill(matches[active]); return; }
      if (key.return) {
        const cmd = matches[active];
        if ((cmd.args || []).some((a) => a.required)) fill(cmd); else submit('/' + cmd.name);
        return;
      }
    }
    if (key.escape) { setClosed(true); return; }
    if (key.upArrow) {
      setScrollOffset((o) => Math.min(o + 1, messages.length));
      return;
    }

    if (key.downArrow) {
      setScrollOffset((o) => Math.max(o - 1, 0));
      return;
    }

    if (!key.return && (char === '\r' || char === '\n')) { submit(input); return; }
    if (key.return) {
      if (input.startsWith('/')) { submit(input); return; }
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
  const availableForMessages = Math.max(1, terminalHeight - headerHeight - inputAreaHeight - footerHeight - hintReserve - (paletteOn ? paletteHeight(matches.length) : 0) - (form ? 2 : 0));

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

    paletteOn ? h(Palette, { matches, active }) : null,
    h(Box, { flexShrink: 0, flexDirection: 'column' },
      h(Rule),
      form
        ? (form.mode === 'resume'
            ? h(SessionPicker, {
                sessions: form.sessions,
                current: form.current,
                onPick: (id) => { resumeSession(id); const s = getSummary(id); const msgs = loadMessages(id); setMessages(s ? [{ role: 'agent', text: '[recap] ' + s }, ...msgs] : msgs); setScrollOffset(0); setForm(null); },
                onCancel: () => setForm(null)
              })
            : h(ModelForm, { key: form.mode + (form.name ?? ''), mode: form.mode, name: form.name, onDone: () => setForm(null) }))
        : h(InputBox, { value: input }),
      h(Rule)
    ),

    h(Footer, { width: terminalWidth, model: activeModel() })
  );
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mascot = "";

try {
  const mascotPath = path.join(__dirname, "assets", "mascot.png");
  mascot = await terminalImage.file(mascotPath, {
    width: 10,
    preserveAspectRatio: true
  });
} catch (error) {
  mascot = "";
}

const clearScreen = () =>
  execaSync(process.platform === 'win32' ? 'cls' : 'clear', { shell: true, stdio: 'inherit' });

function mount() {
  clearScreen();
  app = render(h(App, { mascot }));
}

async function suspend(fn) {
  await new Promise((r) => setTimeout(r, 50));
  app.unmount();
  clearScreen();
  try {
    await fn();
  } catch (e) {
    console.error(e.message);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\n\x1b[2mPress Enter to return...\x1b[0m');
  rl.close();
  mount();
}

mount();
