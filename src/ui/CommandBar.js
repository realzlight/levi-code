import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;
const AMBER_LINE = '#f59e0b'; // Claude Code yellowish-orange edge line
const GRAY = '#888888';
const GREEN = '#4ade80';
const GOLD = '#fbbf24';
const CYAN = '#38bdf8';
const DIM = '#64748b';
const WHITE = '#f8fafc';
const MUTED = '#94a3b8';
const RED = '#f87171';

function detectTitle(text) {
  if (!text) return 'Command Output';
  if (/\[code_search:/i.test(text)) return 'Code Search';
  if (/\[raw_memory_search:/i.test(text)) return 'Raw Memory Search';
  if (/\[raw_memory:/i.test(text)) return 'Raw Memory';
  if (/\[memory\]/i.test(text)) return 'Memory Search';
  if (/^\/[a-zA-Z0-9_:-]+\s+/m.test(text)) return 'Command Help';
  if (/^Index rebuilt:/i.test(text)) return 'Index Status';
  return 'Command Output';
}

function parseAndWrapLines(rawText, width = 76) {
  if (!rawText) return [];
  const safeW = Math.max(24, width);
  const rawLines = String(rawText).split(/\r?\n/);
  const rows = [];

  for (const rawLine of rawLines) {
    if (!rawLine.trim()) {
      rows.push({ type: 'empty', text: '' });
      continue;
    }

    // Pattern 1: Code Search match: filepath:line: snippet
    const codeMatch = /^([^\s:]+:\d+:)\s*(.*)$/.exec(rawLine);
    if (codeMatch) {
      const loc = codeMatch[1];
      const code = codeMatch[2];
      const firstMax = safeW - loc.length - 1;

      if (firstMax > 8 && code.length > firstMax) {
        rows.push({ type: 'code_match', loc, text: code.slice(0, firstMax) });
        let rem = code.slice(firstMax).trimStart();
        const contW = safeW - 4;
        while (rem.length > contW) {
          let sp = rem.lastIndexOf(' ', contW);
          if (sp < contW * 0.4) sp = contW;
          rows.push({ type: 'continuation', text: rem.slice(0, sp) });
          rem = rem.slice(sp).trimStart();
        }
        if (rem.length) rows.push({ type: 'continuation', text: rem });
      } else {
        rows.push({ type: 'code_match', loc, text: code });
      }
      continue;
    }

    // Pattern 2: Bracketed tag e.g. [code_search: ...], [memory] ...
    const tagMatch = /^(\[[^\]]+\])\s*(.*)$/.exec(rawLine);
    if (tagMatch) {
      const tag = tagMatch[1];
      const rest = tagMatch[2];
      const isSearchHeader = /\[(code_search|raw_memory_search|raw_memory):/i.test(tag);
      const firstMax = safeW - tag.length - 1;

      if (firstMax > 8 && rest.length > firstMax) {
        rows.push({ type: isSearchHeader ? 'header_tag' : 'tag', tag, text: rest.slice(0, firstMax) });
        let rem = rest.slice(firstMax).trimStart();
        const contW = safeW - 4;
        while (rem.length > contW) {
          let sp = rem.lastIndexOf(' ', contW);
          if (sp < contW * 0.4) sp = contW;
          rows.push({ type: 'continuation', text: rem.slice(0, sp) });
          rem = rem.slice(sp).trimStart();
        }
        if (rem.length) rows.push({ type: 'continuation', text: rem });
      } else {
        rows.push({ type: isSearchHeader ? 'header_tag' : 'tag', tag, text: rest });
      }
      continue;
    }

    // Pattern 3: Command help line e.g. /cs <path> <query>  Search code...
    const cmdMatch = /^(\/[a-zA-Z0-9_:-]+(?:\s+(?:<[^>]+>|\[[^\]]+\]))*)\s{2,}(.*)$/.exec(rawLine);
    if (cmdMatch) {
      const cmd = cmdMatch[1];
      const desc = cmdMatch[2];
      const firstMax = safeW - cmd.length - 2;

      if (firstMax > 8 && desc.length > firstMax) {
        rows.push({ type: 'cmd', cmd, text: desc.slice(0, firstMax) });
        let rem = desc.slice(firstMax).trimStart();
        const contW = safeW - 4;
        while (rem.length > contW) {
          let sp = rem.lastIndexOf(' ', contW);
          if (sp < contW * 0.4) sp = contW;
          rows.push({ type: 'continuation', text: rem.slice(0, sp) });
          rem = rem.slice(sp).trimStart();
        }
        if (rem.length) rows.push({ type: 'continuation', text: rem });
      } else {
        rows.push({ type: 'cmd', cmd, text: desc });
      }
      continue;
    }

    // Pattern 4: Error or Warning
    if (/^Error:/i.test(rawLine)) {
      rows.push({ type: 'error', text: rawLine });
      continue;
    }

    // Pattern 5: Regular text wrapping
    let rem = rawLine;
    while (rem.length > safeW) {
      let sp = rem.lastIndexOf(' ', safeW);
      if (sp < safeW * 0.4) sp = safeW;
      rows.push({ type: 'normal', text: rem.slice(0, sp) });
      rem = rem.slice(sp).trimStart();
    }
    if (rem.length) rows.push({ type: 'normal', text: rem });
  }

  return rows;
}

const SPINNERS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// output: null | { kind: 'text', text, title? } | { kind: 'panel', title, status?, fields: [{label, value, color?}] } | { kind: 'loading', title, subtitle? } | { kind: 'init', ... }
export default function CommandBar({ output, scrollOffset = 0, width = 80, height = 24 }) {
  if (!output) return null;

  const isAnimated = output.kind === 'init' || output.kind === 'loading';
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!isAnimated) return;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % 1000);
    }, 80);
    return () => clearInterval(timer);
  }, [isAnimated]);

  const spinner = SPINNERS[frame % SPINNERS.length];
  const safeWidth = Math.max(30, width || 80);
  const contentWidth = safeWidth - 2;

  // 1. Text Output (e.g. /help, /cs, shell output, markdown)
  if (output.kind === 'text') {
    const title = output.title || detectTitle(output.text);
    const rows = parseAndWrapLines(output.text, contentWidth);
    const maxRows = Math.min(Math.max((height || 24) - 10, 5), 14);
    const maxScroll = Math.max(0, rows.length - maxRows);
    const currentScroll = Math.min(Math.max(0, scrollOffset || 0), maxScroll);
    const visibleRows = rows.slice(currentScroll, currentScroll + maxRows);
    const isScrollable = rows.length > maxRows;

    return h(Box, { flexDirection: 'column', width: '100%' },
      // Full edge-to-edge yellowish-orange line (Claude Code style)
      h(Text, { color: AMBER_LINE }, '─'.repeat(safeWidth)),

      // Clean top header bar
      h(Box, { justifyContent: 'space-between', width: '100%', paddingX: 1 },
        h(Box, null,
          h(Text, { color: AMBER_LINE, bold: true }, title.toUpperCase()),
          h(Text, { color: DIM }, ' · '),
          h(Text, { color: MUTED }, `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`)
        ),
        h(Box, null,
          isScrollable
            ? h(Text, { color: GOLD }, `[${currentScroll + 1}-${currentScroll + visibleRows.length} of ${rows.length}]`)
            : null,
          h(Text, { color: DIM }, isScrollable ? ' · ↑↓ scroll' : ' · done')
        )
      ),

      // Scrollable content area (clean typography, no clutter symbols)
      h(Box, { flexDirection: 'column', width: '100%', paddingX: 1, marginY: 0 },
        visibleRows.map((r, i) => {
          if (r.type === 'code_match') {
            return h(Box, { key: i, flexDirection: 'row', width: '100%' },
              h(Text, { color: CYAN, bold: true }, r.loc.padEnd(28, ' ')),
              h(Text, { color: WHITE }, r.text)
            );
          }
          if (r.type === 'continuation') {
            return h(Box, { key: i, flexDirection: 'row', width: '100%' },
              h(Text, { color: DIM }, '    '),
              h(Text, { color: '#cbd5e1' }, r.text)
            );
          }
          if (r.type === 'header_tag') {
            return h(Box, { key: i, flexDirection: 'row', width: '100%' },
              h(Text, { color: AMBER_LINE, bold: true }, r.tag + ' '),
              h(Text, { color: WHITE, bold: true }, r.text)
            );
          }
          if (r.type === 'tag') {
            return h(Box, { key: i, flexDirection: 'row', width: '100%' },
              h(Text, { color: GREEN, bold: true }, r.tag + ' '),
              h(Text, { color: '#e2e8f0' }, r.text)
            );
          }
          if (r.type === 'cmd') {
            return h(Box, { key: i, flexDirection: 'row', width: '100%' },
              h(Text, { color: CYAN, bold: true }, r.cmd.padEnd(22, ' ')),
              h(Text, { color: MUTED }, r.text)
            );
          }
          if (r.type === 'error') {
            return h(Text, { key: i, color: RED, bold: true }, r.text);
          }
          if (r.type === 'empty') {
            return h(Text, { key: i }, ' ');
          }
          return h(Text, { key: i, color: WHITE }, r.text);
        })
      ),

      // Clean bottom helper bar
      h(Box, { justifyContent: 'space-between', width: '100%', paddingX: 1 },
        h(Text, { color: DIM }, isScrollable ? '↑↓ line · pgup/pgdn page · esc close' : 'Ready · esc to return to prompt'),
        h(Text, { color: DIM }, '[esc close]')
      )
    );
  }

  // 2. Structured panel (e.g. /plugin:list, /config, /init)
  const isInstalled = output.status === 'INSTALLED';
  const isUpdated = output.status === 'UPDATED';
  const isRemoved = output.status === 'REMOVED';
  const isCatalog = output.status === 'CATALOG';

  const statusColor = isRemoved ? RED : (isInstalled || isUpdated) ? GREEN : isCatalog ? '#a78bfa' : GOLD;

  if (output.kind === 'panel' || output.kind === 'init') {
    return h(Box, { flexDirection: 'column', width: '100%' },
      // Full edge-to-edge yellowish-orange line
      h(Text, { color: AMBER_LINE }, '─'.repeat(safeWidth)),

      // Clean header
      h(Box, { justifyContent: 'space-between', width: '100%', paddingX: 1 },
        h(Box, null,
          h(Text, { color: AMBER_LINE, bold: true }, (output.title || 'LEVI').toUpperCase()),
          output.status ? h(Text, { color: statusColor, bold: true }, ` · ${output.status}`) : null
        ),
        h(Text, { color: DIM }, 'esc close')
      ),

      // Clean field rows (no clutter symbols!)
      h(Box, { flexDirection: 'column', width: '100%', paddingX: 1, marginY: 0 },
        (output.fields || []).map((f, i) =>
          h(Box, { key: i, flexDirection: 'row', width: '100%' },
            h(Text, { color: CYAN, bold: true }, (f.label + ':').padEnd(18, ' ')),
            h(Text, { color: f.color || WHITE, wrap: 'wrap' }, f.value)
          )
        )
      ),

      // Bottom bar
      h(Box, { justifyContent: 'space-between', width: '100%', paddingX: 1 },
        h(Text, { color: DIM }, 'Ready · esc to return to prompt'),
        h(Text, { color: DIM }, '[esc close]')
      )
    );
  }

  // 3. Animated loading state (e.g. /plugin:install)
  if (output.kind === 'loading') {
    return h(Box, { flexDirection: 'column', width: '100%' },
      h(Text, { color: AMBER_LINE }, '─'.repeat(safeWidth)),
      h(Box, { justifyContent: 'space-between', width: '100%', paddingX: 1 },
        h(Box, null,
          h(Text, { color: GOLD, bold: true }, `${spinner} `),
          h(Text, { color: WHITE, bold: true }, output.title || 'Working...'),
          output.subtitle ? h(Text, { color: MUTED }, ` — ${output.subtitle}`) : null
        ),
        h(Text, { color: DIM }, 'esc dismiss')
      )
    );
  }

  return null;
}
