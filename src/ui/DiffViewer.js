import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

const h = React.createElement;

const CYAN = '#afd7ff';
const WHITE = '#ffffff';
const SOFT = '#c4c4c4';
const GRAY = '#777777';
const DIM = '#334455';
const GREEN = '#4ade80';
const RED = '#f87171';

function parseDiffToLines(diffText, maxWidth) {
  const rawLines = (diffText || '').split('\n');
  const allVisualLines = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (raw === undefined) continue;

    // File header
    if (raw.startsWith('diff --git') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      const text = raw.length > maxWidth ? raw.slice(0, maxWidth - 1) + '…' : raw;
      allVisualLines.push([{ text, color: CYAN, bold: true }]);
      continue;
    }

    // Index or metadata
    if (raw.startsWith('index ') || raw.startsWith('similarity ') || raw.startsWith('rename ')) {
      const text = raw.length > maxWidth ? raw.slice(0, maxWidth - 1) + '…' : raw;
      allVisualLines.push([{ text, color: GRAY }]);
      continue;
    }

    // Hunk header
    if (raw.startsWith('@@')) {
      const text = raw.length > maxWidth ? raw.slice(0, maxWidth - 1) + '…' : raw;
      allVisualLines.push([{ text, color: WHITE, bold: true }]);
      continue;
    }

    // Additions
    if (raw.startsWith('+')) {
      let rem = raw;
      while (rem.length > 0) {
        const chunk = rem.slice(0, maxWidth);
        allVisualLines.push([{ text: chunk, color: GREEN }]);
        rem = rem.slice(maxWidth);
      }
      continue;
    }

    // Deletions
    if (raw.startsWith('-')) {
      let rem = raw;
      while (rem.length > 0) {
        const chunk = rem.slice(0, maxWidth);
        allVisualLines.push([{ text: chunk, color: RED }]);
        rem = rem.slice(maxWidth);
      }
      continue;
    }

    // Context or other
    let rem = raw || ' ';
    while (rem.length > 0) {
      const chunk = rem.slice(0, maxWidth);
      allVisualLines.push([{ text: chunk, color: SOFT }]);
      rem = rem.slice(maxWidth);
    }
  }

  return allVisualLines.length > 0 ? allVisualLines : [[{ text: 'No changes detected (working tree clean).' }]];
}

export default function DiffViewer({ diffText, onClose, width, height, scrollRef }) {
  const [offset, setOffset] = useState(0);

  const usableWidth = Math.max(10, (width || 80) - 4);
  const totalHeight = Math.max(6, height || 24);

  const hasDividers = totalHeight >= 12;
  const fixedRows = hasDividers ? 6 : 4;
  const visibleLinesCount = Math.max(1, totalHeight - fixedRows);

  const allVisualLines = useMemo(() => {
    return parseDiffToLines(diffText, usableWidth);
  }, [diffText, usableWidth]);

  const totalLines = allVisualLines.length;
  const maxOffset = Math.max(0, totalLines - visibleLinesCount);
  const clampedOffset = Math.min(offset, maxOffset);

  const pageJump = Math.max(1, visibleLinesCount - 2);

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
        h(Text, { color: WHITE, bold: true }, 'DIFF REVIEWER')
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

    // Content area
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
            h(Text, { color: CYAN }, '● All diff shown ('),
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
