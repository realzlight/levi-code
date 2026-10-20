import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const ACTIVE_ROOT = path.join(LEVI_HOME, 'ACTIVE-BUFFER');
const ENDED_ROOT = path.join(LEVI_HOME, 'ENDED-BUFFER');
const MEMORY_ROOT = path.join(LEVI_HOME, 'MEMORY');
const PROJECTS_ROOT = path.join(LEVI_HOME, 'PROJECTS');

const MAX_TOTAL_CHARS = 2400;

function listRawFiles(scope = 'all') {
  const files = [];

  // 1. Session buffers (ACTIVE and ENDED)
  if (scope === 'all' || scope === 'sessions') {
    for (const [bucketDir, bucketName] of [[ACTIVE_ROOT, 'ACTIVE-BUFFER'], [ENDED_ROOT, 'ENDED-BUFFER']]) {
      if (!fs.existsSync(bucketDir)) continue;
      let entries = [];
      try { entries = fs.readdirSync(bucketDir); } catch { continue; }
      for (const entry of entries) {
        const m = /^SESSION-(\d+)(?:_.*)?$/.exec(entry);
        if (!m) continue;
        const sDir = path.join(bucketDir, entry);
        for (const fname of ['BUFFER.MD', 'TASK.md', 'TITLE.TXT', 'PROJECT.TXT']) {
          const fp = path.join(sDir, fname);
          if (fs.existsSync(fp)) {
            files.push({
              path: fp,
              display: `${bucketName}/${entry}/${fname}`,
              type: 'session',
              sessionId: m[1]
            });
          }
        }
      }
    }
  }

  // 2. User memory (.md files in ~/.levi/MEMORY)
  if (scope === 'all' || scope === 'user') {
    if (fs.existsSync(MEMORY_ROOT)) {
      try {
        for (const fname of fs.readdirSync(MEMORY_ROOT)) {
          if (fname.endsWith('.md')) {
            files.push({
              path: path.join(MEMORY_ROOT, fname),
              display: `MEMORY/${fname}`,
              type: 'user'
            });
          }
        }
      } catch {}
    }
  }

  // 3. Project files (.md files in ~/.levi/PROJECTS/*)
  if (scope === 'all' || scope === 'projects') {
    if (fs.existsSync(PROJECTS_ROOT)) {
      try {
        for (const proj of fs.readdirSync(PROJECTS_ROOT)) {
          const pDir = path.join(PROJECTS_ROOT, proj);
          try {
            if (!fs.statSync(pDir).isDirectory()) continue;
            for (const fname of fs.readdirSync(pDir)) {
              if (fname.endsWith('.md') || fname.endsWith('.txt')) {
                files.push({
                  path: path.join(pDir, fname),
                  display: `PROJECTS/${proj}/${fname}`,
                  type: 'project',
                  project: proj
                });
              }
            }
          } catch {}
        }
      } catch {}
    }
  }

  return files;
}

export async function searchRawMemory({ query, scope = 'all', limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return 'Error: query is required for raw_memory_search';

  const lim = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const files = listRawFiles(scope);
  if (!files.length) return `No memory files found for scope: ${scope}`;

  const lowerQ = q.toLowerCase();
  const results = [];
  let totalChars = 0;

  for (const item of files) {
    if (results.length >= lim) break;
    let content = '';
    try {
      content = fs.readFileSync(item.path, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= lim) break;
      const line = lines[i];
      if (line.toLowerCase().includes(lowerQ)) {
        const lineNum = i + 1;
        const snippet = line.trim().slice(0, 160);
        const out = `[${item.display}:${lineNum}] ${snippet}`;
        if (totalChars + out.length > MAX_TOTAL_CHARS) {
          results.push('... [more raw matches capped to save tokens]');
          break;
        }
        results.push(out);
        totalChars += out.length;
      }
    }
  }

  if (!results.length) {
    return `No raw memory matches found for "${q}" across ${files.length} files (scope: ${scope}).`;
  }

  return `[raw_memory_search: ${results.length} matches for "${q}"]\n` + results.join('\n');
}

export async function readRawMemory({ type, name, session_id, lines = 40, tail = false } = {}) {
  const t = String(type || '').trim().toLowerCase();
  const maxLines = Math.min(Math.max(Number(lines) || 40, 5), 200);

  let targetPath = null;
  let label = '';

  if (t === 'user' || (!t && name && !session_id)) {
    const fname = String(name || 'USER.md').trim();
    const finalName = fname.endsWith('.md') ? fname : fname + '.md';
    targetPath = path.join(MEMORY_ROOT, finalName);
    label = `MEMORY/${finalName}`;
  } else if (t === 'project') {
    const rawName = String(name || '').trim();
    if (!rawName) return 'Error: project name is required when type="project"';
    if (rawName.includes('/')) {
      targetPath = path.join(PROJECTS_ROOT, rawName);
      label = `PROJECTS/${rawName}`;
    } else {
      targetPath = path.join(PROJECTS_ROOT, rawName, 'DATA.md');
      label = `PROJECTS/${rawName}/DATA.md`;
    }
  } else if (t === 'session' || session_id !== undefined) {
    const sId = Number(session_id);
    if (!Number.isInteger(sId) || sId < 1) return 'Error: valid session_id is required';
    const fname = String(name || 'BUFFER.MD').trim().toUpperCase();

    const activePath = path.join(ACTIVE_ROOT, `SESSION-${sId}`, fname);
    if (fs.existsSync(activePath)) {
      targetPath = activePath;
      label = `ACTIVE-BUFFER/SESSION-${sId}/${fname}`;
    } else {
      if (fs.existsSync(ENDED_ROOT)) {
        try {
          const entries = fs.readdirSync(ENDED_ROOT);
          const foundDir = entries.find((e) => new RegExp(`^SESSION-${sId}(?:_.*)?$`).test(e));
          if (foundDir) {
            const endedPath = path.join(ENDED_ROOT, foundDir, fname);
            if (fs.existsSync(endedPath)) {
              targetPath = endedPath;
              label = `ENDED-BUFFER/${foundDir}/${fname}`;
            }
          }
        } catch {}
      }
    }
  } else {
    return 'Error: must specify type ("user", "project", or "session")';
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return `Error: raw memory file not found: ${label || targetPath}`;
  }

  try {
    const content = fs.readFileSync(targetPath, 'utf-8');
    const allLines = content.split(/\r?\n/);
    let selectedLines = [];
    if (tail) {
      selectedLines = allLines.slice(-maxLines);
    } else {
      selectedLines = allLines.slice(0, maxLines);
    }

    const formatted = selectedLines.join('\n').slice(0, MAX_TOTAL_CHARS);
    const suffix = allLines.length > maxLines ? `\n... [${allLines.length - maxLines} more lines truncated]` : '';
    return `[raw_memory: ${label} (${selectedLines.length}/${allLines.length} lines)]\n${formatted}${suffix}`;
  } catch (err) {
    return `Error reading ${label}: ${err.message}`;
  }
}
