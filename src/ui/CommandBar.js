import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;
const CARD_COLOR = '#afd7ff';
const GRAY = '#888888';
const GREEN = '#4ade80';
const GOLD = '#ffd700';
const CYAN = '#38bdf8';
const DIM = '#64748b';
const WHITE = '#f3f4f6';

const SPARKS = ['✦', '✧', '★', '☆', '✶', '✸', '✹', '✺'];

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

// output: null | { kind: 'text', text, title? } | { kind: 'panel', title, fields: [{label, value, color?}] } | { kind: 'init', ... }
export default function CommandBar({ output, scrollOffset = 0, width = 80, height = 24 }) {
  if (!output) return null;

  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % 1000);
    }, 90);
    return () => clearInterval(timer);
  }, []);

  const spark = SPARKS[frame % SPARKS.length];
  const safeWidth = Math.max(30, width || 80);
  const contentWidth = safeWidth - 4; // account for border + padding

  if (output.kind === 'text') {
    const title = output.title || detectTitle(output.text);
    const rows = parseAndWrapLines(output.text, contentWidth);
    const maxRows = Math.min(Math.max((height || 24) - 9, 5), 14);
    const maxScroll = Math.max(0, rows.length - maxRows);
    const currentScroll = Math.min(Math.max(0, scrollOffset || 0), maxScroll);
    const visibleRows = rows.slice(currentScroll, currentScroll + maxRows);

    const isScrollable = rows.length > maxRows;
    const pct = isScrollable ? Math.round(((currentScroll + visibleRows.length) / rows.length) * 100) : 100;

    // Mini scrollbar indicator (8 chars)
    const barLen = 8;
    const fillLen = Math.max(1, Math.round((visibleRows.length / rows.length) * barLen));
    const startPos = Math.round((currentScroll / Math.max(1, rows.length)) * (barLen - fillLen));
    const scrollbar = isScrollable
      ? '░'.repeat(Math.max(0, startPos)) + '█'.repeat(fillLen) + '░'.repeat(Math.max(0, barLen - startPos - fillLen))
      : '';

    return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: CARD_COLOR, paddingX: 1, width: '100%' },
      // Header
      h(Box, { justifyContent: 'space-between', marginBottom: 1 },
        h(Text, { color: CARD_COLOR, bold: true }, `✦ ${title}`),
        h(Text, { color: GRAY },
          isScrollable
            ? `[${currentScroll + 1}-${currentScroll + visibleRows.length} of ${rows.length}]`
            : `[${rows.length} ${rows.length === 1 ? 'line' : 'lines'}]`
        )
      ),

      // Scrollable content area
      h(Box, { flexDirection: 'column', marginBottom: 1 },
        visibleRows.map((r, i) => {
          if (r.type === 'code_match') {
            return h(Box, { key: i, flexDirection: 'row' },
              h(Text, { color: CYAN, bold: true }, r.loc + ' '),
              h(Text, { color: WHITE }, r.text)
            );
          }
          if (r.type === 'continuation') {
            return h(Box, { key: i, flexDirection: 'row' },
              h(Text, { color: DIM }, '    '),
              h(Text, { color: '#cbd5e1' }, r.text)
            );
          }
          if (r.type === 'header_tag') {
            return h(Box, { key: i, flexDirection: 'row' },
              h(Text, { color: CARD_COLOR, bold: true }, r.tag + ' '),
              h(Text, { color: WHITE, bold: true }, r.text)
            );
          }
          if (r.type === 'tag') {
            return h(Box, { key: i, flexDirection: 'row' },
              h(Text, { color: GREEN, bold: true }, r.tag + ' '),
              h(Text, { color: '#e2e8f0' }, r.text)
            );
          }
          if (r.type === 'cmd') {
            return h(Box, { key: i, flexDirection: 'row' },
              h(Text, { color: CYAN, bold: true }, r.cmd + '  '),
              h(Text, { color: '#94a3b8' }, r.text)
            );
          }
          if (r.type === 'error') {
            return h(Text, { key: i, color: '#f87171', bold: true }, r.text);
          }
          if (r.type === 'empty') {
            return h(Text, { key: i }, ' ');
          }
          return h(Text, { key: i, color: WHITE }, r.text);
        })
      ),

      // Footer
      h(Box, { justifyContent: 'space-between' },
        isScrollable
          ? h(Box, null,
              h(Text, { color: CYAN }, scrollbar + ' '),
              h(Text, { color: GOLD }, `${pct}% `),
              h(Text, { color: GRAY }, '· ↑↓ / swipe to scroll')
            )
          : h(Text, { color: GRAY }, 'Done'),
        h(Text, { color: GRAY }, 'Esc to close')
      )
    );
  }

  // Specialized animated init layout
  if (output.kind === 'init') {
    const barLength = Math.min(22, Math.max(12, Math.floor(contentWidth * 0.4)));
    const fillCount = Math.min(barLength, Math.max(3, Math.floor(((frame % 30) + 1) * 2.5)));
    const pct = Math.min(100, Math.floor((fillCount / barLength) * 100));

    return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: CARD_COLOR, paddingX: 1, width: '100%' },
      h(Box, { justifyContent: 'space-between', marginBottom: 1 },
        h(Text, { color: CARD_COLOR, bold: true },
          `${spark} `,
          output.title || 'LEVI Workspace Initialized'
        ),
        h(Text, { color: GREEN, bold: true }, '[✓ Ready]')
      ),
      h(Box, { marginBottom: 1 },
        h(Text, { color: CARD_COLOR }, '  Progress: '),
        h(Text, { color: GREEN }, '█'.repeat(fillCount)),
        h(Text, { color: '#333333' }, '░'.repeat(Math.max(0, barLength - fillCount))),
        h(Text, { color: pct === 100 ? GREEN : GOLD }, ` ${pct}%`)
      ),
      (output.fields || []).map((f, i) =>
        h(Box, { key: i, flexDirection: 'row' },
          h(Text, { color: CARD_COLOR }, '  ▸ '),
          h(Text, { color: CARD_COLOR }, (f.label + ': ').padEnd(16, ' ')),
          h(Text, { color: f.color || 'white', wrap: 'wrap' }, f.value)
        )
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: GRAY }, '  Esc to close · Ready for pair programming')
      )
    );
  }

  // Standard panel
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: CARD_COLOR, paddingX: 1, width: '100%' },
    h(Box, { justifyContent: 'space-between', marginBottom: 1 },
      h(Text, { color: CARD_COLOR, bold: true }, `✦ ${output.title || 'LEVI'}`),
      output.status
        ? h(Text, { color: GREEN, bold: true }, `[${output.status}]`)
        : h(Text, { color: GRAY }, '[Esc to close]')
    ),
    (output.fields || []).map((f, i) =>
      h(Box, { key: i, flexDirection: 'row' },
        h(Text, { color: CARD_COLOR }, '▸ '),
        h(Text, { color: CARD_COLOR }, f.label + ': '),
        h(Text, { color: f.color || 'white', wrap: 'wrap' }, f.value)
      )
    ),
    h(Box, { marginTop: 1, justifyContent: 'flex-end' },
      h(Text, { color: GRAY }, 'Esc to close')
    )
  );
}
