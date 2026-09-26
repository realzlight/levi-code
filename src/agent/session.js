import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const BUFFER_ROOT = path.join(LEVI_HOME, 'ACTIVE-BUFFER');
const CONFIG_PATH = path.join(LEVI_HOME, 'config.json');

const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const writeConfig = (c) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));

function sessionDir(id) {
  return path.join(BUFFER_ROOT, `SESSION-${id}`);
}

function nextId() {
  if (!fs.existsSync(BUFFER_ROOT)) return 1;
  const ids = fs
    .readdirSync(BUFFER_ROOT)
    .map((n) => /^SESSION-(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return ids.length ? Math.max(...ids) + 1 : 1;
}

export function createSession() {
  const id = nextId();
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'BUFFER.MD'), 'summary: (empty session)\n\n');
  fs.writeFileSync(path.join(dir, 'TASK.md'), '');
  fs.writeFileSync(path.join(dir, 'REPORT.MD'), '');
  fs.writeFileSync(path.join(dir, 'TITLE.TXT'), '');
  fs.writeFileSync(path.join(dir, 'PROJECT.TXT'), '');

  const config = readConfig();
  config.currentSession = id;
  writeConfig(config);

  return id;
}

export function listSessions() {
  if (!fs.existsSync(BUFFER_ROOT)) return [];
  return fs
    .readdirSync(BUFFER_ROOT)
    .map((n) => /^SESSION-(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
    .map((id) => {
      const bufferPath = path.join(sessionDir(id), 'BUFFER.MD');
      let summary = '(no summary)';
      try {
        const first = fs.readFileSync(bufferPath, 'utf-8').split('\n')[0];
        if (first.startsWith('summary:')) summary = first.slice(8).trim() || summary;
      } catch {}
      const title = getTitle(id);
      return { id, title, summary, project: getProject(id), team: fs.existsSync(path.join(sessionDir(id), 'TEAM')) };
    });
}

export function resumeSession(id) {
  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) return null;

  const config = readConfig();
  config.currentSession = id;
  writeConfig(config);

  return {
    id,
    buffer: fs.readFileSync(path.join(dir, 'BUFFER.MD'), 'utf-8')
  };
}

export function getProject(id) {
  try {
    const val = fs.readFileSync(path.join(sessionDir(id), 'PROJECT.TXT'), 'utf-8').trim();
    return val || null;
  } catch {
    return null;
  }
}

export function setProject(id, name) {
  fs.writeFileSync(path.join(sessionDir(id), 'PROJECT.TXT'), (name || '').trim());
}

export function getTitle(id) {
  try {
    return fs.readFileSync(path.join(sessionDir(id), 'TITLE.TXT'), 'utf-8').trim();
  } catch {
    return '';
  }
}

export function setTitle(id, title) {
  fs.writeFileSync(path.join(sessionDir(id), 'TITLE.TXT'), title.trim());
}

export function appendMessage(id, role, text) {
  if (!fs.existsSync(sessionDir(id))) return;
  if (!id) return;
  const file = path.join(sessionDir(id), 'BUFFER.MD');
  fs.appendFileSync(file, `@@${role}\n${text}\n\n`);
}

export function getSummary(id) {
  const file = path.join(sessionDir(id), 'BUFFER.MD');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const match = raw.match(/^summary:(.*?)\n\n/s);
    const text = match ? match[1].trim() : '';
    return text && text !== '(empty session)' ? text : '';
  } catch {
    return '';
  }
}

export function loadMessages(id) {
  const file = path.join(sessionDir(id), 'BUFFER.MD');
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const body = raw.replace(/^summary:.*\n\n?/, '');
  const parts = body.split(/^@@(user|agent)\n/m).slice(1);
  const messages = [];
  for (let i = 0; i < parts.length; i += 2) {
    const role = parts[i];
    const text = (parts[i + 1] || '').replace(/\n+$/, '');
    if (text) messages.push({ role, text });
  }
  return messages;
}

export function currentSessionId() {
  return readConfig().currentSession;
}

// Searches every session's title and BUFFER.MD content for a keyword.
// Returns matches sorted by relevance: title matches first, then content matches,
// each with a short snippet of surrounding context.
export function searchSessions(query, { excludeId } = {}) {
  if (!fs.existsSync(BUFFER_ROOT)) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results = [];
  const ids = fs
    .readdirSync(BUFFER_ROOT)
    .map((n) => /^SESSION-(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]));

  for (const id of ids) {
    if (id === excludeId) continue;

    const title = getTitle(id);
    const titleMatch = title.toLowerCase().includes(q);

    let raw = '';
    try {
      raw = fs.readFileSync(path.join(sessionDir(id), 'BUFFER.MD'), 'utf-8');
    } catch {
      continue;
    }

    const lowerRaw = raw.toLowerCase();
    const idx = lowerRaw.indexOf(q);
    const contentMatch = idx !== -1;

    if (!titleMatch && !contentMatch) continue;

    let snippet = '';
    if (contentMatch) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(raw.length, idx + q.length + 80);
      snippet = (start > 0 ? '...' : '') + raw.slice(start, end).replace(/\n+/g, ' ').trim() + (end < raw.length ? '...' : '');
    }

    results.push({ id, title, titleMatch, contentMatch, snippet });
  }

  results.sort((a, b) => (b.titleMatch - a.titleMatch) || (b.contentMatch - a.contentMatch));
  return results;
}

// Reads a specific session's summary (if compacted) or a truncated view of
// its raw buffer, for cross-session lookups without loading everything.
export function readSessionOverview(id, { maxChars = 2000 } = {}) {
  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) return null;

  const title = getTitle(id);
  const summary = getSummary(id);
  const raw = fs.readFileSync(path.join(dir, 'BUFFER.MD'), 'utf-8');

  if (summary) {
    return { id, title, summary, truncated: false };
  }

  const body = raw.replace(/^summary:.*\n\n?/, '');
  const truncated = body.length > maxChars;
  return { id, title, summary: null, buffer: body.slice(0, maxChars), truncated };
}

export function isSoloOnly() {
  return !!readConfig().soloOnly;
}

export function setSoloOnly(value) {
  const config = readConfig();
  config.soloOnly = value;
  writeConfig(config);
  return value;
}
