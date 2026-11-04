import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

const h = React.createElement;

const CYAN = '#afd7ff';
const WHITE = '#ffffff';
const SOFT = '#c4c4c4';
const GRAY = '#777777';
const DIM = '#334455';

function parseInline(text, defaultColor = SOFT) {
  const tokens = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, match.index), color: defaultColor });
    }
    const raw = match[0];
    if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push({ text: raw.slice(1, -1), color: WHITE, bold: true });
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push({ text: raw.slice(2, -2), color: WHITE, bold: true });
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push({ text: raw.slice(1, -1), color: SOFT, italic: true });
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), color: defaultColor });
  }
  return tokens.length > 0 ? tokens : [{ text, color: defaultColor }];
}

function wrapTokens(tokens, maxWidth, indent = '    ') {
  const lines = [];
  let curLine = [];
  let curLen = 0;

  function pushWord(word, style) {
    if (!word) return;
    const wLen = word.length;
    if (curLen + wLen > maxWidth && curLen > 0) {
      lines.push(curLine);
      curLine = indent ? [{ text: indent, color: GRAY }] : [];
      curLen = indent ? indent.length : 0;
      const trimmed = word.trimStart();
      if (trimmed) {
        curLine.push({ ...style, text: trimmed });
        curLen += trimmed.length;
      }
    } else {
      curLine.push({ ...style, text: word });
      curLen += wLen;
    }
  }

  for (const tok of tokens) {
    const parts = tok.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (part.length > maxWidth) {
        let rem = part;
        while (rem.length > 0) {
          const avail = Math.max(1, maxWidth - curLen);
          const chunk = rem.slice(0, avail);
          curLine.push({ ...tok, text: chunk });
          curLen += chunk.length;
          rem = rem.slice(avail);
          if (rem.length > 0) {
            lines.push(curLine);
            curLine = indent ? [{ text: indent, color: GRAY }] : [];
            curLen = indent ? indent.length : 0;
          }
        }
      } else {
        pushWord(part, tok);
      }
    }
  }

  if (curLine.length > 0) lines.push(curLine);
  return lines.length > 0 ? lines : [[{ text: ' ' }]];
}

function parseChangelogToLines(content, maxWidth) {
  const rawLines = (content || '').split('\n');
  const allVisualLines = [];

  function ensureBlankLine() {
    if (allVisualLines.length > 0) {
      const last = allVisualLines[allVisualLines.length - 1];
      if (last.length === 1 && last[0].text === ' ') return;
      allVisualLines.push([{ text: ' ' }]);
    }
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      ensureBlankLine();
      continue;
    }

    // Top-level document header
    if (trimmed.startsWith('# ')) {
      const title = trimmed.slice(2).trim();
      const sepLen = Math.min(maxWidth, Math.max(20, title.length + 8));
      allVisualLines.push([{ text: `✦ ${title.toUpperCase()} ✦`, color: CYAN, bold: true }]);
      allVisualLines.push([{ text: '═'.repeat(sepLen), color: CYAN }]);
      allVisualLines.push([{ text: ' ' }]);
      continue;
    }

    // Markdown horizontal rule
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      ensureBlankLine();
      const sep = '─'.repeat(maxWidth);
      allVisualLines.push([{ text: sep, color: DIM }]);
      allVisualLines.push([{ text: ' ' }]);
      continue;
    }

    // Version headers (e.g. ## [Unreleased] or ## [0.1.0] — Initial Release)
    if (trimmed.startsWith('## ')) {
      const text = trimmed.slice(3).trim();
      ensureBlankLine();
      const toks = [
        { text: '◆  ', color: CYAN, bold: true },
        ...parseInline(text, WHITE)
      ];
      toks.forEach((t) => { t.bold = true; });
      allVisualLines.push(...wrapTokens(toks, maxWidth, '   '));
      allVisualLines.push([{ text: '─'.repeat(Math.min(maxWidth, Math.max(16, text.length + 4))), color: GRAY }]);
      continue;
    }

    // Category subheaders (e.g. ### Added, ### Fixed, ### Changed)
    if (trimmed.startsWith('### ')) {
      const cat = trimmed.slice(4).trim();
      const lower = cat.toLowerCase();
      let icon = '▸ ';
      if (lower.includes('added')) icon = '▲ ';
      else if (lower.includes('fixed')) icon = '● ';
      else if (lower.includes('changed') || lower.includes('updated')) icon = '■ ';
      else if (lower.includes('removed') || lower.includes('deprecated')) icon = '✖ ';
      else if (lower.includes('security')) icon = '🔒 ';

      ensureBlankLine();
      allVisualLines.push([{ text: `  ${icon}${cat.toUpperCase()}`, color: CYAN, bold: true }]);
      continue;
    }

    // Bullet items
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const text = trimmed.slice(2).trim();
      const inlineTokens = parseInline(text, SOFT);
      const bulletTokens = [
        { text: '  • ', color: CYAN },
        ...inlineTokens
      ];
      allVisualLines.push(...wrapTokens(bulletTokens, maxWidth, '    '));
      continue;
    }

    // Standard body text
    const pTokens = parseInline(trimmed, SOFT);
    allVisualLines.push(...wrapTokens(pTokens, maxWidth, ''));
  }

  return allVisualLines.length > 0 ? allVisualLines : [[{ text: 'No entries in changelog.' }]];
}

export default function ChangelogViewer({ content, onClose, width, height, scrollRef }) {
  const [offset, setOffset] = useState(0);

  const usableWidth = Math.max(10, (width || 80) - 4);
  const totalHeight = Math.max(6, height || 24);

  const hasDividers = totalHeight >= 12;
  const fixedRows = hasDividers ? 6 : 4;
  const visibleLinesCount = Math.max(1, totalHeight - fixedRows);

  const allVisualLines = useMemo(() => {
    return parseChangelogToLines(content, usableWidth);
  }, [content, usableWidth]);

  const totalLines = allVisualLines.length;
  const maxOffset = Math.max(0, totalLines - visibleLinesCount);
  const clampedOffset = Math.min(offset, maxOffset);

  const pageJump = Math.max(1, visibleLinesCount - 2);

  // Hook up touch swipe / mouse scroll from parent
  useEffect(() => {
    if (scrollRef) {
      scrollRef.current = {
        up: () => setOffset((o) => Math.max(0, o - 2)),
        down: () => setOffset((o) => Math.min(maxOffset, o + 2))
      };
    }
    return () => {
      if (scrollRef) scrollRef.current = null;
    };
  }, [maxOffset, scrollRef]);

  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'Q' || key.return) {
      onClose();
      return;
    }
    if (key.upArrow || input === 'k' || input === 'K') {
      setOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.downArrow || input === 'j' || input === 'J') {
      setOffset((o) => Math.min(maxOffset, o + 1));
      return;
    }
    if (key.pageUp || input === 'b' || (key.ctrl && (input === 'b' || input === 'u'))) {
      setOffset((o) => Math.max(0, o - pageJump));
      return;
    }
    if (key.pageDown || input === ' ' || (key.ctrl && (input === 'f' || input === 'd'))) {
      setOffset((o) => Math.min(maxOffset, o + pageJump));
      return;
    }
    if (input === 'g' || key.home) {
      setOffset(0);
      return;
    }
    if (input === 'G' || key.end) {
      setOffset(maxOffset);
      return;
    }
  });

  // Render exactly visibleLinesCount rows to prevent any terminal overflow or jitter
  const renderedLines = [];
  for (let i = 0; i < visibleLinesCount; i++) {
    const lineIndex = clampedOffset + i;
    if (lineIndex < totalLines) {
      const tokens = allVisualLines[lineIndex];
      renderedLines.push(
        h(Box, { key: `l-${lineIndex}`, height: 1 },
          ...tokens.map((tok, j) =>
            h(Text, {
              key: `t-${j}`,
              color: tok.color,
              bold: tok.bold,
              dimColor: tok.dim,
              italic: tok.italic,
              wrap: 'truncate-end'
            }, tok.text)
          )
        )
      );
    } else {
      renderedLines.push(
        h(Box, { key: `empty-${i}`, height: 1 },
          h(Text, null, ' ')
        )
      );
    }
  }

  // Scrollbar track indicator
  const pct = maxOffset > 0 ? Math.round((clampedOffset / maxOffset) * 100) : 100;
  const barLength = Math.min(10, Math.max(5, Math.floor(usableWidth / 10)));
  const thumbPos = maxOffset > 0 ? Math.min(barLength - 1, Math.round((clampedOffset / maxOffset) * (barLength - 1))) : barLength - 1;
  const bar = '─'.repeat(thumbPos) + '█' + '─'.repeat(Math.max(0, barLength - 1 - thumbPos));

  return h(
    Box,
    {
      flexDirection: 'column',
      width,
      height: totalHeight,
      borderStyle: 'round',
      borderColor: CYAN
    },

    // Header bar
    h(
      Box,
      {
        height: 1,
        paddingX: 1,
        justifyContent: 'space-between',
        flexShrink: 0
      },
      h(
        Box,
        null,
        h(Text, { color: CYAN, bold: true }, '☾ LEVI '),
        h(Text, { color: WHITE, bold: true }, 'CHANGELOG')
      ),
      h(Text, { color: GRAY }, 'Esc/q to close')
    ),

    // Top divider
    hasDividers
      ? h(
          Box,
          { height: 1, paddingX: 1, flexShrink: 0 },
          h(Text, { color: DIM }, '─'.repeat(usableWidth))
        )
      : null,

    // Content area (guaranteed exact row height)
    h(
      Box,
      {
        flexDirection: 'column',
        height: visibleLinesCount,
        paddingX: 1,
        overflow: 'hidden',
        flexShrink: 0
      },
      ...renderedLines
    ),

    // Bottom divider
    hasDividers
      ? h(
          Box,
          { height: 1, paddingX: 1, flexShrink: 0 },
          h(Text, { color: DIM }, '─'.repeat(usableWidth))
        )
      : null,

    // Footer bar
    h(
      Box,
      {
        height: 1,
        paddingX: 1,
        justifyContent: 'space-between',
        flexShrink: 0
      },
      maxOffset === 0
        ? h(
            Box,
            null,
            h(Text, { color: CYAN }, '● All content shown ('),
            h(Text, { color: SOFT }, `${totalLines} lines`),
            h(Text, { color: CYAN }, ')')
          )
        : h(
            Box,
            null,
            h(Text, { color: CYAN, bold: true }, '▲ '),
            h(Text, { color: SOFT }, `${clampedOffset + 1}–${Math.min(clampedOffset + visibleLinesCount, totalLines)}/${totalLines} `),
            h(Text, { color: CYAN }, `[${bar}] `),
            h(Text, { color: GRAY }, `${pct}%`)
          ),
      h(
        Text,
        { color: GRAY },
        usableWidth > 55 ? '↑↓/j/k PgUp/Dn Home/End • q/Esc exit' : '↑↓ scroll • q exit'
      )
    )
  );
}
