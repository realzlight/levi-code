import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const h = React.createElement;
const CYAN = '#afd7ff';
const WHITE = '#ffffff';
const SOFT = '#c4c4c4';
const GRAY = '#777777';

function getProjectFiles(max = 400) {
  try {
    const gitFiles = execSync('git ls-files', { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const list = gitFiles.split('\n').map(s => s.trim()).filter(Boolean);
    if (list.length > 0) return list.slice(0, max);
  } catch {}

  // Fallback: fast recursive scan of cwd
  const results = [];
  const IGNORE = new Set(['.git', 'node_modules', '.cache', '.npm', '.next', 'dist', 'build', '.levi', 'coverage']);
  
  function scan(dir, depth = 0) {
    if (depth > 5 || results.length >= max) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(process.cwd(), full);
        if (e.isDirectory()) {
          scan(full, depth + 1);
        } else {
          results.push(rel);
          if (results.length >= max) return;
        }
      }
    } catch {}
  }

  scan(process.cwd());
  return results;
}

export default function FilePicker({ onPick, onCancel }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState([]);

  useEffect(() => {
    setFiles(getProjectFiles());
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return files.slice(0, 50);
    const q = query.toLowerCase();
    return files.filter(f => f.toLowerCase().includes(q)).slice(0, 50);
  }, [files, query]);

  const activeIndex = Math.min(sel, Math.max(0, filtered.length - 1));

  useInput((char, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      if (filtered[activeIndex]) onPick(filtered[activeIndex]);
      else onCancel();
      return;
    }
    if (key.upArrow) {
      setSel(s => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSel(s => Math.min(Math.max(0, filtered.length - 1), s + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1));
      setSel(0);
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      setQuery(q => q + char);
      setSel(0);
    }
  });

  const visibleCount = 7;
  const startIdx = Math.max(0, Math.min(activeIndex - Math.floor(visibleCount / 2), Math.max(0, filtered.length - visibleCount)));
  const visibleItems = filtered.slice(startIdx, startIdx + visibleCount);

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: CYAN, paddingX: 1 },
    h(Box, { justifyContent: 'space-between', marginBottom: 1 },
      h(Text, { color: CYAN, bold: true }, '✦ FUZZY FILE PALETTE'),
      h(Text, { color: GRAY }, `${filtered.length} files`)
    ),
    h(Box, { marginBottom: 1 },
      h(Text, { color: CYAN }, 'find: '),
      h(Text, { color: WHITE, bold: true }, query || ''),
      h(Text, { color: CYAN }, '█')
    ),
    ...visibleItems.map((item, idx) => {
      const realIdx = startIdx + idx;
      const isSel = realIdx === activeIndex;
      return h(
        Box,
        { key: item, height: 1, overflow: 'hidden' },
        h(Text, { color: isSel ? CYAN : GRAY }, isSel ? '❯ ' : '  '),
        h(Text, { color: isSel ? WHITE : SOFT, bold: isSel }, item)
      );
    }),
    filtered.length === 0 ? h(Box, { height: 1 }, h(Text, { color: GRAY }, 'No matching files found')) : null,
    h(Box, { marginTop: 1 },
      h(Text, { color: GRAY }, 'type filter · ↑↓ select · enter insert · esc close')
    )
  );
}
