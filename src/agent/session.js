import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const BUFFER_ROOT = path.join(LEVI_HOME, 'ACTIVE-BUFFER');
const ENDED_ROOT = path.join(LEVI_HOME, 'ENDED-BUFFER');
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

// Prunes empty ghost sessions and archives old inactive session buffers
export function autoPruneSessions({ maxActive = 30, maxEnded = 60, pruneEmpty = true } = {}) {
  const current = currentSessionId();
  let prunedEmpty = 0;
  let archivedActive = 0;
  let prunedEnded = 0;

  // 1. Prune ghost/empty sessions from ACTIVE-BUFFER
  if (pruneEmpty && fs.existsSync(BUFFER_ROOT)) {
    const entries = fs.readdirSync(BUFFER_ROOT);
    for (const entry of entries) {
      const m = /^SESSION-(\d+)$/.exec(entry);
      if (!m) continue;
      const id = Number(m[1]);
      if (id === current) continue;
      const sDir = sessionDir(id);
      try {
        const bufFile = path.join(sDir, 'BUFFER.MD');
        const titleFile = path.join(sDir, 'TITLE.TXT');
        const taskFile = path.join(sDir, 'TASK.md');
        const buf = fs.existsSync(bufFile) ? fs.readFileSync(bufFile, 'utf-8').trim() : '';
        const title = fs.existsSync(titleFile) ? fs.readFileSync(titleFile, 'utf-8').trim() : '';
        const tasks = fs.existsSync(taskFile) ? fs.readFileSync(taskFile, 'utf-8').trim() : '';
        const isEmpty = (!title && !tasks && (!buf || buf === 'summary: (empty session)'));
        if (isEmpty) {
          fs.rmSync(sDir, { recursive: true, force: true });
          prunedEmpty++;
        }
      } catch {}
    }
  }

  // 2. Auto-archive oldest active sessions if over maxActive
  if (fs.existsSync(BUFFER_ROOT)) {
    const activeList = listSessions();
    if (activeList.length > maxActive) {
      const excess = activeList.length - maxActive;
      const candidates = activeList.filter((s) => s.id !== current);
      for (let i = 0; i < Math.min(excess, candidates.length); i++) {
        endSession(candidates[i].id);
        archivedActive++;
      }
    }
  }

  // 3. Auto-prune oldest ended sessions if over maxEnded
  if (fs.existsSync(ENDED_ROOT)) {
    const endedList = listEndedSessions();
    if (endedList.length > maxEnded) {
      const toDelete = endedList.slice(maxEnded);
      for (const item of toDelete) {
        try {
          fs.rmSync(path.join(ENDED_ROOT, item.dirName), { recursive: true, force: true });
          prunedEnded++;
        } catch {}
      }
    }
  }

  if (prunedEmpty > 0 || archivedActive > 0 || prunedEnded > 0) {
    import('./retrieval.js').then((m) => m.rebuildIndex()).catch(() => {});
  }

  return { prunedEmpty, archivedActive, prunedEnded };
}

export function createSession() {
  try { autoPruneSessions(); } catch {}
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
  const parts = body.split(/^@@(user|agent|tool)\n/m).slice(1);
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
const STOPWORDS = new Set(['the', 'a', 'an', 'about', 'what', 'did', 'we', 'decide', 'is', 'was', 'were', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'that', 'this', 'it', 'with', 'he', 'she', 'do', 'be', 'so', 'at', 'by', 'up', 'no', 'you', 'your', 'last', 'time']);

function keywordsOf(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// Searches every session's title and BUFFER.MD content for keywords from the
// query (word-level match, not exact phrase — "UI framework" matches text
// containing "UI" and/or "framework" separately). Returns matches sorted by
// how many distinct keywords matched, title matches ranked highest.
export function searchSessions(query, { excludeId } = {}) {
  if (!fs.existsSync(BUFFER_ROOT)) return [];
  const keywords = keywordsOf(query);
  if (!keywords.length) return [];

  const results = [];
  const ids = fs
    .readdirSync(BUFFER_ROOT)
    .map((n) => /^SESSION-(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]));

  for (const id of ids) {
    if (id === excludeId) continue;

    const title = getTitle(id);
    const lowerTitle = title.toLowerCase();
    const titleMatches = keywords.filter((k) => lowerTitle.includes(k));

    let raw = '';
    try {
      raw = fs.readFileSync(path.join(sessionDir(id), 'BUFFER.MD'), 'utf-8');
    } catch {
      continue;
    }

    const lowerRaw = raw.toLowerCase();
    const contentMatches = keywords.filter((k) => lowerRaw.includes(k));

    if (!titleMatches.length && !contentMatches.length) continue;

    let snippet = '';
    if (contentMatches.length) {
      const idx = lowerRaw.indexOf(contentMatches[0]);
      const start = Math.max(0, idx - 80);
      const end = Math.min(raw.length, idx + contentMatches[0].length + 80);
      snippet = (start > 0 ? '...' : '') + raw.slice(start, end).replace(/\n+/g, ' ').trim() + (end < raw.length ? '...' : '');
    }

    results.push({
      id,
      title,
      titleMatch: titleMatches.length > 0,
      contentMatch: contentMatches.length > 0,
      matchedKeywords: [...new Set([...titleMatches, ...contentMatches])],
      snippet
    });
  }

  results.sort((a, b) => b.matchedKeywords.length - a.matchedKeywords.length || (b.titleMatch - a.titleMatch));
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

export function isDiaryEnabled() {
  try {
    return !!readConfig().diaryEnabled;
  } catch {
    return false;
  }
}

export function setDiaryEnabled(value) {
  const config = readConfig();
  config.diaryEnabled = Boolean(value);
  writeConfig(config);
  return config.diaryEnabled;
}

// Permanently removes one session folder. Guards: id must be a positive integer and the
// folder must be SESSION-<id> directly inside ACTIVE-BUFFER. Clears currentSession if it was this one.
export function deleteSession(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return false;
  const dir = sessionDir(n);
  if (path.dirname(dir) !== BUFFER_ROOT || !/^SESSION-\d+$/.test(path.basename(dir))) return false;
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  const config = readConfig();
  if (Number(config.currentSession) === n) {
    config.currentSession = null;
    writeConfig(config);
  }
  return true;
}

// Moves a session from ACTIVE-BUFFER to ENDED-BUFFER. Records the ended timestamp.
export function endSession(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return false;
  const src = sessionDir(n);
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(ENDED_ROOT, { recursive: true });
  // Use timestamp suffix to avoid collisions if a session was ended, restored and ended again
  const stamp = Date.now();
  const dest = path.join(ENDED_ROOT, `SESSION-${n}_${stamp}`);
  fs.renameSync(src, dest);
  // Write ended timestamp so we can display it
  try { fs.writeFileSync(path.join(dest, 'ENDED_AT.TXT'), new Date(stamp).toISOString()); } catch {}
  const config = readConfig();
  if (Number(config.currentSession) === n) {
    config.currentSession = null;
    writeConfig(config);
  }
  return true;
}

// Lists all sessions in ENDED-BUFFER, newest first.
export function listEndedSessions() {
  if (!fs.existsSync(ENDED_ROOT)) return [];
  return fs.readdirSync(ENDED_ROOT)
    .map((n) => /^SESSION-(\d+)_(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => {
      const id = Number(m[1]);
      const stamp = Number(m[2]);
      const dir = path.join(ENDED_ROOT, m[0]);
      let title = '', summary = '(no summary)', endedAt = '';
      try { title = fs.readFileSync(path.join(dir, 'TITLE.TXT'), 'utf-8').trim(); } catch {}
      try {
        const first = fs.readFileSync(path.join(dir, 'BUFFER.MD'), 'utf-8').split('\n')[0];
        if (first.startsWith('summary:')) summary = first.slice(8).trim() || summary;
      } catch {}
      try { endedAt = fs.readFileSync(path.join(dir, 'ENDED_AT.TXT'), 'utf-8').trim(); } catch {}
      return { id, stamp, dirName: m[0], title, summary, endedAt };
    })
    .sort((a, b) => b.stamp - a.stamp);
}

// Moves an ended session back into ACTIVE-BUFFER as a new session id.
export function restoreSession(dirName) {
  const src = path.join(ENDED_ROOT, dirName);
  if (!fs.existsSync(src)) return null;
  fs.mkdirSync(BUFFER_ROOT, { recursive: true });
  const newId = nextId();
  const dest = sessionDir(newId);
  fs.renameSync(src, dest);
  // Remove ended marker
  try { fs.rmSync(path.join(dest, 'ENDED_AT.TXT'), { force: true }); } catch {}
  const config = readConfig();
  config.currentSession = newId;
  writeConfig(config);
  import('./retrieval.js').then((m) => m.rebuildIndex()).catch(() => {});
  return newId;
}
