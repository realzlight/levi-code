import { getGreeting } from "./greetings.js";
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useStdout, useApp } from 'ink';
import os from 'os';
import terminalImage from 'terminal-image';
import { execaSync } from 'execa';
import { setLatestInput } from './state.js';
import { getCommands } from './commands.js';
import Footer, { activeModel } from './Footer.js';
import ModelForm from './ModelForm.js';
import SessionPicker from './SessionPicker.js';
import AskPrompt from './AskPrompt.js';
import MemSync from './MemSync.js';
import Confirm from './Confirm.js';
import CommandBar from './CommandBar.js';
import { filterCommands, runCapture } from './commands.js';
import { currentSessionId, createSession, getTitle, setTitle, appendMessage, loadMessages, resumeSession, getSummary, getProject } from '../agent/session.js';
import { generateTitle } from '../agent/title.js';
import { runAgent } from '../agent/loop.js';
import { maybeCompact } from '../agent/compact.js';
import { getTasks } from '../agent/tasks.js';
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from 'node:readline/promises';
import fs from 'fs'
const h = React.createElement;
const GRAY = '#888888';
const BORDER = '#999999';
const HIGHLIGHT_BG = '#2a2a2a';
const DOT_COLOR = '#ffffff';
const LEVI_HOME = path.join(os.homedir(), '.levi');

const CONFIG = path.join(LEVI_HOME,'config.json')


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



function messageCost(message, width = 80) {
  if (!message || !message.text) return 1;
  const effectiveWidth = Math.max(15, width - 4);
  let rows = 0;
  const lines = message.text.split('\n');
  for (const line of lines) {
    rows += Math.max(1, Math.ceil(line.length / effectiveWidth));
  }
  return rows + 1;
}

function computeWindow(messages, scrollOffset, availableRows, width = 80) {
  const end = Math.max(0, messages.length - scrollOffset);
  let start = end;
  let used = 0;
  while (start > 0) {
    const cost = messageCost(messages[start - 1], width);
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
  if (!id) return 'Abyssal \u2022 /resume';
  const title = getTitle(id);
  return `SESSION-${id}${title ? ' \u2014 ' + title : ''}`;
}

function Header({ mascot, compact }) {
  if (compact) {
    return h(Box, { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
      h(Text, { color: 'white', bold: true }, 'Levi Code ', h(Text, { color: GRAY }, 'v2.1.25')),
      h(Text, { color: GRAY }, sessionLine())
    );
  }
  return h(Box, { alignItems: 'center' },
    mascot ? h(Text, null, mascot) : null,
    h(Box, { flexDirection: 'column', marginLeft: mascot ? 3 : 0 },
      h(Text, { color: 'white', bold: true }, 'Levi Code ', h(Text, { color: GRAY }, 'v2.1.25')),
      h(Text, { color: GRAY }, sessionLine()),
      h(Text, { color: '#c4c4c4' }, GREETING)
    )
  );
}

function Message({ role, text, tool, arg, result, status, todos, width }) {
  if (role === 'agent' && text === '...') {
    return h(Box, { marginBottom: 1 },
      h(ClaudeThinking, { running: true })
    );
  }
  if (role === 'tool_call') {
    return h(ClaudeToolCall, { tool, arg, result, status, todos });
  }

  return h(ClaudeMessage, { role: role === 'agent' ? 'assistant' : 'user', width }, text);
}

// --- Claude Prompt component (brainless/claude-prompt) -------------------------
// Adapted from https://brainless.swerdlow.dev/r/claude-prompt.json
// Original: browser JSX with CSS border + effort chips + mode line.
// This version targets Ink (terminal React) using Box / Text with ANSI colors.

const CP_FG = '#c0caf5';
const CP_RULE = '#808080';
const CP_MODE_COLORS = {
  auto:    { glyph: '⏵⏵', label: 'auto mode on',    color: '#ffd700' },
  manual:  { glyph: '⏸',  label: 'manual mode on',  color: '#949494' },
};
const CP_EFFORTS = {
  low:    { glyph: '○', label: 'low · /effort' },
  medium: { glyph: '◐', label: 'medium · /effort' },
  high:   { glyph: '●', label: 'high · /effort' },
  xhigh:  { glyph: '◉', label: 'xhigh · /effort' },
  max:    { glyph: '◈', label: 'max · /effort' },
};

function ClaudePrompt({ value, width }) {
  const display = value + '\u2588';
  const lines = display.split('\n');
  const ruleWidth = Math.max(10, (width || 80) - 2);

  return h(Box, { flexDirection: 'column' },
    // top rule
    h(Text, { color: CP_RULE }, '\u2500'.repeat(ruleWidth)),
    // input lines
    h(Box, { flexDirection: 'column', paddingLeft: 0 },
      lines.map((line, i) => h(Text, { key: i, color: CP_FG }, (i === 0 ? '\u276F ' : '  ') + line))
    ),
    // bottom rule
    h(Text, { color: CP_RULE }, '\u2500'.repeat(ruleWidth))
  );
}
// --- end Claude Prompt --------------------------------------------------------

// --- Claude Thinking component (brainless/claude-thinking) ---------------------
// Adapted from https://brainless.swerdlow.dev/r/claude-thinking.json
// Original: browser JSX with CSS gradient shimmer.
// This version targets Ink (terminal React) using Box / Text with ANSI colors.

// Captured cycle from claude/thinking frames: · ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢

const CT_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const CT_VERBS = [
  'Levitating', 'Schlepping', 'Liberating', 'Sleuthing', 'Noodling', 'Calibrating',
  'Reticulating', 'Synthesizing', 'Calibrating', 'Grep\'ing', 'Weaving', 'Untangling',
  'Orbiting', 'Distilling', 'Summoning', 'Decoding', 'Splicing', 'Fermenting',
  'Marinating', 'Simmering', 'Roasting', 'Brewing', 'Kneading', 'Forging',
  'Sculpting', 'Chiseling', 'Polishing', 'Buffing', 'Sandblasting', 'Welding',
  'Braiding', 'Knitting', 'Crocheting', 'Folding', 'Origami-ing', 'Tetris-ing',
  'Mining', 'Excavating', 'Prospecting', 'Dowsing', 'Spelunking', 'Burrowing',
  'Triaging', 'Sherpa-ing', 'Carrying', 'Unboxing', 'Unfurling', 'Unleashing',
  'Channeling', 'Manifesting', 'Divining', 'Scrying', 'Downgrading', 'Upgrading',
  'Shuffling', 'Lurking', 'Hovering', 'Drifting', 'Meandering', 'Wandering',
  'Pondering', 'Contemplating', 'Ruminating', 'Meditating', 'Vibing', 'Cooking',
  'Squinting', 'Peering', 'Sleuthing', 'Investigating', 'Foraging', 'Hunting',
  'Gathering', 'Indexing', 'Cataloging', 'Archiving', 'Combing', 'Sifting',
  'Wrangling', 'Taming', 'Domesticating', 'Negotiating', 'Bargaining', 'Haggling',
  'Yeeting', 'Yoinking', 'Borrowing', 'Liberating', 'Recruiting', 'Drafting',
];
const CLAUDE_COLOR = '#22d3ee';
const CT_DIM = '#7d7d7d';

const CT_DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function ClaudeThinking({ running = true, verbs = CT_VERBS, showTokens = true }) {
  const [glyph, setGlyph] = useState(0);
  const [verbIdx, setVerbIdx] = useState(0);
  const [secs, setSecs] = useState(0);
  const [dot, setDot] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setGlyph((g) => (g + 1) % CT_GLYPHS.length), 110);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setDot((d) => (d + 1) % CT_DOTS.length), 80);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setVerbIdx((v) => (v + 1) % verbs.length), 1000); // <-- 1s now
    return () => clearInterval(id);
  }, [running, verbs.length]);

  if (!running) return null;

  const verb = verbs[verbIdx % verbs.length];
  const tokens = showTokens? ` \u00b7 \u2191 ${Math.max(0, secs * 137)} tokens` : '';

  return h(Box, { gap: 1 },
    h(Text, { color: CLAUDE_COLOR }, CT_DOTS[dot]),
    h(Text, { color: CLAUDE_COLOR }, CT_GLYPHS[glyph]),
    h(Text, { color: CLAUDE_COLOR, bold: true }, `${verb}\u2026`),
    h(Text, { color: CT_DIM }, `(${secs}s${tokens} \u00b7 esc to interrupt)`)
  );
}
// --- end Claude Thinking ------------------------------------------------------

// --- Claude Message component (brainless/claude-message) -----------------------
// Adapted from https://brainless.swerdlow.dev/r/claude-message.json
// Original: browser JSX with Tailwind classes.
// This version targets Ink (terminal React) using Box / Text with ANSI colors.

const CM_USER_BG = '#3a3a3a';   // dark background for user rows
const CM_CARET = '#4e4e4e';     // subdued ❯ caret
const CM_AGENT_TEXT = '#c0caf5'; // light blue/lavender for assistant text

function ClaudeMessage({ role = 'assistant', children, width }) {
  if (role === 'user') {
    const text = typeof children === 'string' ? children : '';
    const lines = text.split('\n');
    return h(Box, { flexDirection: 'column', width, marginBottom: 1 },
      lines.map((line, i) => {
        const prefix = i === 0 ? '\u276F ' : '  ';
        const isBlank = line.trim().length === 0;

        if (isBlank) {
          return h(Text, { key: i }, ' ');
        }

        return h(
          Text,
          { key: i, color: 'white', backgroundColor: CM_USER_BG },
          (prefix + line).padEnd(width, ' ')
        );
      })
    );
  }

  return h(Box, { marginBottom: 1 },
    h(Text, { color: DOT_COLOR }, '\u25CF'),
    h(Text, { color: CM_AGENT_TEXT }, ` ${children}`)
  );
}

// --- Claude Slash Menu component (brainless/claude-slash-menu) -----------------
// Adapted from https://brainless.swerdlow.dev/r/claude-slash-menu.json
// Original: browser JSX with <ul role="listbox">.
// This version targets Ink (terminal React) using Box / Text with ANSI colors.

const CSM_ACTIVE = '#afd7ff';    // light blue for selected row
const CSM_INACTIVE = '#949494';  // gray for unselected rows
const CSM_NAME_COLS = 20;        // padded command name column

function ClaudeSlashMenu({ matches, active }) {
  if (!matches.length) {
    return h(Box, { flexDirection: 'column', marginBottom: 0 },
      h(Text, { color: CSM_INACTIVE }, '  No matching commands')
    );
  }

  const maxVisible = 8;
  const start = Math.max(0, Math.min(active - Math.floor(maxVisible / 2), matches.length - maxVisible));
  const visible = matches.slice(start, start + maxVisible);
  const counter = matches.length > maxVisible ? `  ${active + 1}/${matches.length}` : '';

  return h(Box, { flexDirection: 'column', marginBottom: 0 },
    visible.map((c, i) => {
      const isActive = start + i === active;
      const name = ('/' + c.name).padEnd(CSM_NAME_COLS);
      return h(Box, { key: c.name },
        h(Text, { color: isActive ? CSM_ACTIVE : CSM_INACTIVE }, isActive ? '❯ ' : '  '),
        h(Text, { color: isActive ? CSM_ACTIVE : CSM_INACTIVE, bold: isActive }, name),
        h(Text, { color: isActive ? '#c4c4c4' : '#666666' }, c.description)
      );
    }),
    h(Text, { color: '#666666' }, `  ↑↓ navigate · tab fill · enter run · esc close${counter}`)
  );
}

export const slashMenuHeight = (n) => Math.min(Math.max(n, 1), 8) + 1;
// --- end Claude Slash Menu ----------------------------------------------------

// --- Claude Todo List component (brainless/claude-todo-list) -------------------
// Adapted from https://brainless.swerdlow.dev/r/claude-todo-list.json
// Terminal React/Ink version matching Claude Code capture grammar:
//   ⎿ ✔ done     (green + dim)
//     ◼ active   (terracotta + bold)
//     ◻ pending  (default/gray)

const CTL_DONE = '#87d787';   // 38;5;114 - green
const CTL_ACTIVE = '#d78787'; // 38;5;174 - Claude terracotta
const CTL_DIM = '#949494';    // 38;5;246 - dim gray

const CTL_ICONS = {
  done: '✔',
  active: '◼',
  todo: '◻',
};

function ClaudeTodoList({ todos = [] }) {
  if (!todos || !todos.length) return null;

  return h(Box, { flexDirection: 'column' },
    todos.map((t, i) => {
      const icon = CTL_ICONS[t.status] || CTL_ICONS.todo;
      const iconColor = t.status === 'done' ? CTL_DONE : (t.status === 'active' ? CTL_ACTIVE : CTL_DIM);
      const labelColor = t.status === 'done' ? CTL_DIM : (t.status === 'active' ? '#ffffff' : '#c4c4c4');
      const bold = t.status === 'active';
      const prefix = i === 0 ? '  \u23BF ' : '    ';

      return h(Box, { key: i },
        h(Text, { color: CTL_DIM }, prefix),
        h(Text, { color: iconColor }, `${icon} `),
        h(Text, { color: labelColor, bold }, t.label)
      );
    })
  );
}
// --- end Claude Todo List -----------------------------------------------------

// --- Claude Tool Call component (brainless/claude-tool-call) -------------------
// Adapted from https://brainless.swerdlow.dev/r/claude-tool-call.json
// Terminal React/Ink version matching Claude Code capture grammar:
//   ⏺ tool(arg)
//     ⎿ result

const TC_STATUS_COLOR = {
  success: '#4ea96f', // green
  error: '#f7768e',   // red
  pending: '#e0af68', // yellow
};
const TC_TOOL = '#c0caf5';
const TC_PAREN = '#565f89';
const TC_ARG = '#7dcfff';
const TC_BRANCH = '#565f89';
const TC_RESULT = '#8b8fa3';

function ClaudeToolCall({ tool, arg, result, status = 'success', todos }) {
  const statusColor = TC_STATUS_COLOR[status] || TC_STATUS_COLOR.success;

  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    // Header: ⏺ tool(arg)
    h(Box, {},
      h(Text, { color: statusColor }, '\u23FA '),
      h(Text, { color: TC_TOOL }, tool),
      arg !== undefined && arg !== '' ? h(Text, null,
        h(Text, { color: TC_PAREN }, '('),
        h(Text, { color: TC_ARG }, arg),
        h(Text, { color: TC_PAREN }, ')')
      ) : null
    ),
    // If todos present, render ClaudeTodoList
    todos && todos.length ? h(ClaudeTodoList, { todos }) : null,
    // If result present (and no todos)
    (!todos || !todos.length) && result ? h(Box, {},
      h(Text, { color: TC_BRANCH }, '  \u23BF '),
      h(Text, { color: TC_RESULT }, result)
    ) : null
  );
}
// --- end Claude Tool Call -----------------------------------------------------

function formatToolArg(name, args) {
  if (!args) return '';
  if (name === 'bash') {
    return args.command || '';
  }
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
    return args.path || '';
  }
  if (name === 'set_project') {
    return args.name || '';
  }
  if (name === 'add_task_cluster') {
    return args.title || '';
  }
  if (name === 'set_task_done') {
    return `cluster ${args.cluster}, task ${args.taskIndex}`;
  }
  if (name === 'add_task_to_cluster') {
    return args.text || '';
  }
  if (name === 'edit_task') {
    return args.text || '';
  }
  if (name === 'delete_task') {
    return `cluster ${args.cluster}, task ${args.taskIndex}`;
  }
  if (name === 'delete_cluster') {
    return `cluster ${args.cluster}`;
  }
  if (name === 'search_sessions') {
    return args.query || '';
  }
  if (name === 'read_session') {
    return String(args.id || '');
  }
  if (name === 'spawn_subagent') {
    return `@${args.role}: ${args.instruction || ''}`;
  }
  if (name === 'message_subagent') {
    return `@${args.role}: ${args.message || ''}`;
  }
  if (name === 'ask') {
    return args.question || '';
  }
  const keys = Object.keys(args);
  if (keys.length === 1 && typeof args[keys[0]] === 'string') {
    return args[keys[0]];
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

function getTodoItems(id) {
  if (!id) return null;
  try {
    const clusters = getTasks(id);
    if (!clusters || !clusters.length) return null;
    const activeCluster = clusters.find((c) => c.status !== 'completed') || clusters[clusters.length - 1];
    if (!activeCluster || !activeCluster.tasks.length) return null;

    let foundActive = false;
    return activeCluster.tasks.map((t) => {
      if (t.done) return { label: t.text, status: 'done' };
      if (!foundActive) {
        foundActive = true;
        return { label: t.text, status: 'active' };
      }
      return { label: t.text, status: 'todo' };
    });
  } catch {
    return null;
  }
}

// --- Safety stdin interceptor -------------------------------------------------
// Intercepts process.stdin.read directly because Ink uses read() rather than 'data' events.
// This completely consumes mouse escape sequences (\x1b[<...M/m and \x1b[M...) before
// Ink ever sees them, preventing any numbers/characters from being typed into the input bar.
let globalScrollUp = null;
let globalScrollDown = null;
let globalTap = null;

const origRead = process.stdin.read;
process.stdin.read = function (...args) {
  const chunk = origRead.apply(this, args);
  if (!chunk) return chunk;

  let str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

  // SGR mouse mode: \x1b[<btn;col;rowM or m
  if (str.includes('\x1b[<')) {
    const re = /\x1b\[<(\d+);\d+;\d+([Mm])/g;
    let match;
    while ((match = re.exec(str)) !== null) {
      const btn = parseInt(match[1], 10);
      const action = match[2];
      if (btn === 64) {
        if (globalScrollUp) globalScrollUp();
      } else if (btn === 65) {
        if (globalScrollDown) globalScrollDown();
      } else if (btn === 0 && action === 'M') {
        if (globalTap) globalTap();
      }
    }
    str = str.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '');
  }

  // X11 mouse mode fallback: \x1b[M + 3 bytes
  if (str.includes('\x1b[M')) {
    const reX11 = /\x1b\[M([\s\S]{3})/g;
    let mX;
    while ((mX = reX11.exec(str)) !== null) {
      const b = mX[1].charCodeAt(0) - 32;
      if (b === 64 && globalScrollUp) globalScrollUp();
      else if (b === 65 && globalScrollDown) globalScrollDown();
    }
    str = str.replace(/\x1b\[M[\s\S]{3}/g, '');
  }

  // Strip any remaining orphan escape codes
  str = str.replace(/\x1b\[<\d+;\d+;?\d*[Mm]?/g, '');

  if (!str) return Buffer.isBuffer(chunk) ? Buffer.alloc(0) : '';
  return Buffer.isBuffer(chunk) ? Buffer.from(str) : str;
};

function wrapText(text, width) {
  if (!text) return [''];
  const maxW = Math.max(10, width);
  const result = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.length <= maxW) {
      result.push(line);
    } else {
      let rem = line;
      while (rem.length > maxW) {
        result.push(rem.slice(0, maxW));
        rem = rem.slice(maxW);
      }
      result.push(rem);
    }
  }
  return result;
}

function buildDisplayLines(messages, width) {
  const lines = [];
  const safeWidth = Math.max(20, width);

  messages.forEach((msg, msgIdx) => {
    if (msg.role === 'tool_call') {
      const statusColor = TC_STATUS_COLOR[msg.status || 'success'] || TC_STATUS_COLOR.success;
      lines.push({
        key: `tc-${msgIdx}-head`,
        node: h(Box, { key: `tc-${msgIdx}-head` },
          h(Text, { color: statusColor }, '\u23FA '),
          h(Text, { color: TC_TOOL }, msg.tool),
          msg.arg !== undefined && msg.arg !== '' ? h(Text, null,
            h(Text, { color: TC_PAREN }, '('),
            h(Text, { color: TC_ARG }, msg.arg),
            h(Text, { color: TC_PAREN }, ')')
          ) : null
        )
      });

      if (msg.todos && msg.todos.length) {
        msg.todos.forEach((t, todoIdx) => {
          const icon = CTL_ICONS[t.status] || CTL_ICONS.todo;
          const iconColor = t.status === 'done' ? CTL_DONE : (t.status === 'active' ? CTL_ACTIVE : CTL_DIM);
          const labelColor = t.status === 'done' ? CTL_DIM : (t.status === 'active' ? '#ffffff' : '#c4c4c4');
          const bold = t.status === 'active';
          const prefix = todoIdx === 0 ? '  \u23BF ' : '    ';

          lines.push({
            key: `tc-${msgIdx}-todo-${todoIdx}`,
            node: h(Box, { key: `tc-${msgIdx}-todo-${todoIdx}` },
              h(Text, { color: CTL_DIM }, prefix),
              h(Text, { color: iconColor }, `${icon} `),
              h(Text, { color: labelColor, bold }, t.label)
            )
          });
        });
      } else if (msg.status === 'pending') {
        lines.push({
          key: `tc-${msgIdx}-pending`,
          node: h(Box, { key: `tc-${msgIdx}-pending` },
            h(Text, { color: TC_BRANCH }, '  \u23BF '),
            h(Text, { color: TC_STATUS_COLOR.pending }, 'running...')
          )
        });
      } else if (msg.result) {
        const rawLines = String(msg.result).trim().split('\n');
        const maxResultLines = 6;
        const visibleRes = rawLines.slice(0, maxResultLines);
        visibleRes.forEach((rLine, rIdx) => {
          const prefix = rIdx === 0 ? '  \u23BF ' : '    ';
          const rWidth = Math.max(10, safeWidth - 4);
          const chunk = rLine.length > rWidth ? rLine.slice(0, rWidth - 1) + '…' : rLine;
          lines.push({
            key: `tc-${msgIdx}-res-${rIdx}`,
            node: h(Box, { key: `tc-${msgIdx}-res-${rIdx}` },
              h(Text, { color: TC_BRANCH }, prefix),
              h(Text, { color: TC_RESULT }, chunk)
            )
          });
        });
        if (rawLines.length > maxResultLines) {
          lines.push({
            key: `tc-${msgIdx}-res-more`,
            node: h(Box, { key: `tc-${msgIdx}-res-more` },
              h(Text, { color: TC_BRANCH }, '    '),
              h(Text, { color: '#666666' }, `... (+${rawLines.length - maxResultLines} more lines)`)
            )
          });
        }
      }

      lines.push({
        key: `msg-${msgIdx}-sep`,
        node: h(Text, { key: `msg-${msgIdx}-sep` }, ' ')
      });
      return;
    }

    if (msg.role === 'agent' && msg.text === '...') {
      lines.push({
        key: `msg-${msgIdx}-thinking`,
        node: h(Box, { key: `msg-${msgIdx}-thinking` },
          h(ClaudeThinking, { running: true })
        )
      });
      return;
    }

    if (msg.role === 'user') {
      const text = typeof msg.text === 'string' ? msg.text : '';
      const textWidth = Math.max(10, safeWidth - 2);
      const wrapped = wrapText(text, textWidth);

      wrapped.forEach((chunk, lineIdx) => {
        const prefix = lineIdx === 0 ? '\u276F ' : '  ';
        const isBlank = chunk.trim().length === 0;
        lines.push({
          key: `msg-${msgIdx}-${lineIdx}`,
          node: isBlank
            ? h(Text, { key: `msg-${msgIdx}-${lineIdx}` }, ' ')
            : h(
                Text,
                { key: `msg-${msgIdx}-${lineIdx}`, color: 'white', backgroundColor: CM_USER_BG },
                (prefix + chunk).padEnd(safeWidth, ' ')
              )
        });
      });

      lines.push({
        key: `msg-${msgIdx}-sep`,
        node: h(Text, { key: `msg-${msgIdx}-sep` }, ' ')
      });
      return;
    }

    // Agent message
    const text = typeof msg.text === 'string' ? msg.text : '';
    const textWidth = Math.max(10, safeWidth - 3);
    const wrapped = wrapText(text, textWidth);

    wrapped.forEach((chunk, lineIdx) => {
      const isFirst = lineIdx === 0;
      lines.push({
        key: `msg-${msgIdx}-${lineIdx}`,
        node: h(Box, { key: `msg-${msgIdx}-${lineIdx}` },
          h(Text, { color: isFirst ? DOT_COLOR : 'transparent' }, isFirst ? '\u25CF ' : '  '),
          h(Text, { color: CM_AGENT_TEXT }, chunk)
        )
      });
    });

    lines.push({
      key: `msg-${msgIdx}-sep`,
      node: h(Text, { key: `msg-${msgIdx}-sep` }, ' ')
    });
  });

  return lines;
}

let savedMessages = [];
let app;

function App({ mascot }) {
  const [messages, setMessages] = useState(savedMessages);
  useEffect(() => { savedMessages = messages; }, [messages]);

  const [input, setInput] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const targetScrollRef = React.useRef(0);
  const animTimerRef = React.useRef(null);
  const [sel, setSel] = useState(0);
  const [form, setForm] = useState(null);
  const [commandOutput, setCommandOutput] = useState(null);
  const [closed, setClosed] = useState(false);
  const { exit } = useApp();
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();

  // When the terminal resizes (keyboard up/down), snap to latest messages
  useEffect(() => {
    if (animTimerRef.current) clearTimeout(animTimerRef.current);
    animTimerRef.current = null;
    targetScrollRef.current = 0;
    setScrollOffset(0);
  }, [terminalHeight]);

  useEffect(() => {
    return () => {
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
    };
  }, []);

  const paletteOn = input.startsWith('/') && !input.includes(' ') && !closed;
  const matches = paletteOn ? filterCommands(input.slice(1)) : [];
  const active = Math.min(sel, Math.max(matches.length - 1, 0));
  useEffect(() => { setSel(0); setClosed(false); if (input.startsWith('/')) setCommandOutput(null); }, [input]);
  const fill = (cmd) => setInput('/' + cmd.name + ' ');

  async function runSlash(text) {
    setMessages((prev) => [...prev, { role: 'user', text }]);
    const { text: out, panel } = await runCapture(text, { clear: () => setMessages([]), exit, suspend, openForm: setForm });
    if (panel) setCommandOutput({ kind: 'panel', ...panel });
    else if (out) setCommandOutput({ kind: 'text', text: out });
  }

  function submit(raw) {
    const text = raw.trim();
    if (!text) return;
    setCommandOutput(null);
    setInput('');
    targetScrollRef.current = 0;
    setScrollOffset(0);
    setLatestInput(text);
    if (text.startsWith('/')) { runSlash(text); return; }

    setMessages((prev) => [...prev, { role: 'user', text }, { role: 'agent', text: '...' }]);

    (async () => {
      let id = currentSessionId();
      if (!id) id = createSession();
      if (id && !getTitle(id)) setTitle(id, await generateTitle(text));

      const onStep = (kind, data) => {
        if (kind === 'thought') {
          if (data && data.clusterCreated && id) {
            const todos = getTodoItems(id);
            if (todos && todos.length) {
              setMessages((prev) => [
                ...prev.slice(0, -1),
                {
                  role: 'tool_call',
                  id: 'cluster-' + data.clusterCreated.num,
                  tool: 'TaskCreate',
                  arg: data.clusterCreated.title,
                  status: 'success',
                  result: '',
                  todos
                },
                { role: 'agent', text: '...' }
              ]);
            }
          }
        } else if (kind === 'tool_call') {
          const arg = formatToolArg(data.name, data.args);
          const isTaskTool = [
            'add_task_cluster', 'set_task_done', 'add_task_to_cluster',
            'edit_task', 'delete_task', 'delete_cluster', 'get_tasks'
          ].includes(data.name);

          const todos = isTaskTool && id ? getTodoItems(id) : null;

          setMessages((prev) => [
            ...prev.slice(0, -1),
            {
              role: 'tool_call',
              id: data.id,
              tool: data.name,
              arg,
              rawArgs: data.args,
              status: 'pending',
              result: '',
              todos
            },
            { role: 'agent', text: '...' }
          ]);
        } else if (kind === 'tool_result') {
          const resStr = String(data.result || '');
          const isError = resStr.startsWith('Error:');
          const isTaskTool = [
            'add_task_cluster', 'set_task_done', 'add_task_to_cluster',
            'edit_task', 'delete_task', 'delete_cluster', 'get_tasks'
          ].includes(data.call?.name);

          const todos = isTaskTool && id ? getTodoItems(id) : null;

          setMessages((prev) => {
            const next = [...prev];
            let idx = -1;
            for (let i = next.length - 1; i >= 0; i--) {
              if (
                next[i].role === 'tool_call' &&
                (next[i].id === data.call?.id || (next[i].tool === data.call?.name && next[i].status === 'pending'))
              ) {
                idx = i;
                break;
              }
            }
            if (idx !== -1) {
              next[idx] = {
                ...next[idx],
                status: isError ? 'error' : 'success',
                result: resStr,
                todos: todos || next[idx].todos
              };
            }
            return next;
          });
        }
      };

      let reply;
      try {
        reply = await runAgent(text, { onStep });
      } catch (e) {
        reply = `Error: ${e.message}`;
      }

      appendMessage(id, 'user', text);

      if (reply && typeof reply === 'object' && reply.__ask) {
        appendMessage(id, 'agent', reply.question);
        setMessages((prev) => [...prev.slice(0, -1), { role: 'agent', text: reply.question }]);
        setForm({ mode: 'ask', question: reply.question, options: reply.options, allowCustom: reply.allowCustom });
        maybeCompact(id, getProject(id));
        return;
      }

      appendMessage(id, 'agent', reply);
      setMessages((prev) => [...prev.slice(0, -1), { role: 'agent', text: reply }]);
      maybeCompact(id, getProject(id));
    })();
  }

  const displayLines = React.useMemo(() => buildDisplayLines(messages, terminalWidth), [messages, terminalWidth]);
  const totalLines = displayLines.length;

  const isCompact = terminalHeight < 22;
  const mascotLines = (!isCompact && mascot) ? mascot.split('\n').length : 0;
  const headerHeight = isCompact ? 1 : Math.max(mascotLines, 3) + 1;
  const headerMargin = isCompact ? 1 : 2;
  const inputLines = (input + '\u2588').split('\n').length;
  // ClaudePrompt: 1 top rule + inputLines + 1 bottom rule = 2 + inputLines
  const inputAreaHeight = 2 + inputLines;
  const footerHeight = 1;
  const commandOutputHeight = commandOutput
    ? 3 + (commandOutput.kind === 'panel' ? 1 + commandOutput.fields.length : commandOutput.text.split('\n').length)
    : 0;

  const fixedHeight = headerHeight + headerMargin + inputAreaHeight + footerHeight + (paletteOn ? slashMenuHeight(matches.length) : 0) + (form ? 2 : 0) + commandOutputHeight;
  const rawAvailable = Math.max(1, terminalHeight - fixedHeight);
  const needsScrollIndicators = totalLines > rawAvailable;
  const availableForMessages = Math.max(1, rawAvailable - (needsScrollIndicators ? 2 : 0));

  const maxScroll = Math.max(0, totalLines - availableForMessages);
  const clampedScroll = Math.min(scrollOffset, maxScroll);

  const end = Math.max(0, totalLines - clampedScroll);
  const start = Math.max(0, end - availableForMessages);
  const visibleLines = displayLines.slice(start, end);

  const hiddenAbove = start > 0;
  const hiddenBelow = end < totalLines;

  const animateTo = React.useCallback((targetVal) => {
    targetScrollRef.current = Math.max(0, Math.min(targetVal, maxScroll));
    if (animTimerRef.current) return;

    const tick = () => {
      setScrollOffset((curr) => {
        const target = targetScrollRef.current;
        const diff = target - curr;
        if (diff === 0) {
          animTimerRef.current = null;
          return target;
        }
        const step = Math.sign(diff) * Math.max(1, Math.ceil(Math.abs(diff) * 0.18));
        const next = curr + step;
        if (next === target) {
          animTimerRef.current = null;
          return target;
        }
        animTimerRef.current = setTimeout(tick, 12);
        return next;
      });
    };
    animTimerRef.current = setTimeout(tick, 12);
  }, [maxScroll]);

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
    if (key.escape) { setClosed(true); setCommandOutput(null); return; }

    if (key.pageUp) {
      animateTo(targetScrollRef.current + 6);
      return;
    }
    if (key.pageDown) {
      animateTo(targetScrollRef.current - 6);
      return;
    }
    if (key.upArrow) {
      animateTo(targetScrollRef.current + 1);
      return;
    }
    if (key.downArrow) {
      animateTo(targetScrollRef.current - 1);
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
      targetScrollRef.current = 0;
      setScrollOffset(0);
      setInput((value) => value.slice(0, -1));
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    if (char) {
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(char) || char.startsWith('\x1b')) return;
      targetScrollRef.current = 0;
      setScrollOffset(0);
      setInput((value) => value + char);
    }
  });

  useEffect(() => {
    globalScrollUp = () => animateTo(targetScrollRef.current + 1);
    globalScrollDown = () => animateTo(targetScrollRef.current - 1);

    let tapTimer = null;
    globalTap = () => {
      // Drop mouse mode for 1 second so Termux delivers touch to the soft keyboard
      process.stdout.write('\x1b[?1002l\x1b[?1006l');
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        process.stdout.write('\x1b[?1002h\x1b[?1006h');
      }, 1000);
    };

    return () => {
      globalScrollUp = null;
      globalScrollDown = null;
      globalTap = null;
      if (tapTimer) clearTimeout(tapTimer);
    };
  }, [animateTo]);

  return h(
    Box,
    { flexDirection: 'column', width: terminalWidth, height: terminalHeight },

    h(Box, { flexShrink: 0, flexDirection: 'column', marginBottom: headerMargin },
      h(Header, { mascot: isCompact ? null : mascot, compact: isCompact })
    ),

    h(Box, {
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      overflow: 'hidden'
    },
      hiddenAbove ? h(Text, { color: GRAY }, '\u2191 swipe down to scroll up') : null,
      visibleLines.map((item) => item.node),
      hiddenBelow ? h(Text, { color: GRAY }, '\u2193 swipe up to return to latest') : null
    ),

    paletteOn ? h(ClaudeSlashMenu, { matches, active }) : null,
    h(CommandBar, { output: commandOutput }),
    h(Box, { flexShrink: 0, flexDirection: 'column' },
      form
        ? (form.mode === 'resume'
            ? h(SessionPicker, {
                sessions: form.sessions,
                current: form.current,
                onPick: (id) => { resumeSession(id); const s = getSummary(id); const msgs = loadMessages(id); setMessages(s ? [{ role: 'agent', text: '[recap] ' + s }, ...msgs] : msgs); setScrollOffset(0); setForm(null); },
                onCancel: () => setForm(null)
              })
            : form.mode === 'ask'
            ? h(AskPrompt, {
                question: form.question,
                options: form.options,
                allowCustom: form.allowCustom,
                onPick: (answer) => { setForm(null); submit(answer); }
              })
            : form.mode === 'mem-push'
            ? h(MemSync, { mode: 'push', onDone: () => setForm(null) })
            : form.mode === 'mem-sync-confirm1'
            ? h(Confirm, {
                message: 'This will PERMANENTLY REPLACE your local ~/.levi with the remote version.',
                warning: 'Sessions, memory, projects, and config not already pushed will be LOST. This cannot be undone.',
                options: ['Continue', 'Cancel'],
                onConfirm: () => setForm({ mode: 'mem-sync-confirm2' }),
                onCancel: () => setForm(null)
              })
            : form.mode === 'mem-sync-confirm2'
            ? h(Confirm, {
                message: 'Are you absolutely sure?',
                warning: 'This is your last chance to cancel before local data is overwritten.',
                options: ["Yes, I'm sure — replace it", 'Cancel'],
                onConfirm: () => setForm({ mode: 'mem-sync-progress' }),
                onCancel: () => setForm(null)
              })
            : form.mode === 'mem-sync-progress'
            ? h(MemSync, { mode: 'sync', onDone: () => setForm(null) })
            : h(ModelForm, { key: form.mode + (form.name ?? ''), mode: form.mode, name: form.name, onDone: () => setForm(null) }))
        : h(ClaudePrompt, { value: input, width: terminalWidth })
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

const enterAltScreen = () => {
  try {
    // Clear screen, clear scrollback, home cursor, enter alt screen and enable mouse reporting
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H\x1b[?1049h\x1b[?1002h\x1b[?1006h');
  } catch {}
};

const exitAltScreen = () => {
  try {
    process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?1049l');
  } catch {}
};

process.on('exit', exitAltScreen);
process.on('SIGINT', () => { exitAltScreen(); process.exit(0); });
process.on('SIGTERM', () => { exitAltScreen(); process.exit(0); });

function mount() {
  enterAltScreen();
  app = render(h(App, { mascot }));
}

async function suspend(fn) {
  await new Promise((r) => setTimeout(r, 50));
  app.unmount();
  exitAltScreen();
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
