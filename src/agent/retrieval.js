import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getEmbedding, cosineSimilarity, vectorToBuffer, bufferToVector } from './embedding.js';

const HOME = path.join(os.homedir(), '.levi');
const DB_PATH = path.join(HOME, 'INDEX.db');
const CHUNK = 1000;
const STOP = new Set(['the', 'and', 'for', 'what', 'did', 'we', 'about', 'with', 'that', 'this', 'you', 'are', 'was', 'how', 'when', 'is', 'to', 'of', 'in', 'on', 'it', 'my', 'me', 'do', 'be', 'a', 'an']);

async function openDb() {
  const w = process.emitWarning;
  process.emitWarning = () => {};
  let mod;
  try { mod = await import('node:sqlite'); } finally { process.emitWarning = w; }
  if (!mod || !mod.DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync is not available in this Node version');
  }
  try { fs.mkdirSync(HOME, { recursive: true }); } catch {}
  const db = new mod.DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, sig TEXT, kind TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(text, path UNINDEXED, kind UNINDEXED, session UNINDEXED, role UNINDEXED, tokenize = 'porter unicode61');
    CREATE TABLE IF NOT EXISTS vectors (path TEXT, chunk_idx INTEGER, vector BLOB, PRIMARY KEY (path, chunk_idx));
  `);
  return db;
}

function splitText(text, max = CHUNK) {
  const out = [];
  let cur = '';
  for (const para of String(text).split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (cur && cur.length + p.length + 2 > max) { out.push(cur); cur = ''; }
    if (p.length > max) {
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function listSources() {
  const out = [];
  for (const bucket of ['ACTIVE-BUFFER', 'ENDED-BUFFER']) {
    const root = path.join(HOME, bucket);
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const m = /^SESSION-(\d+)$/.exec(d);
      if (!m) continue;
      for (const f of ['BUFFER.MD', 'TITLE.TXT', 'PROJECT.TXT', 'TASK.md']) {
        const p = path.join(root, d, f);
        if (fs.existsSync(p)) out.push({ path: p, kind: 'session', session: m[1] });
      }
    }
  }
  try {
    for (const f of fs.readdirSync(path.join(HOME, 'MEMORY'))) {
      if (/\.md$/i.test(f)) out.push({ path: path.join(HOME, 'MEMORY', f), kind: 'memory', session: '' });
    }
  } catch {}
  try {
    for (const name of fs.readdirSync(path.join(HOME, 'PROJECTS'))) {
      let files = [];
      try { files = fs.readdirSync(path.join(HOME, 'PROJECTS', name)); } catch { continue; }
      for (const f of files) {
        if (/\.md$/i.test(f)) out.push({ path: path.join(HOME, 'PROJECTS', name, f), kind: 'project', session: '' });
      }
    }
  } catch {}
  return out;
}

function chunkFile(src, raw) {
  const base = path.basename(src.path).toUpperCase();
  if (src.kind === 'session' && base === 'BUFFER.MD') {
    const out = [];
    const sm = /^summary:(.*)\n\n?/.exec(raw);
    if (sm && sm[1].trim() && !/empty session/.test(sm[1])) out.push({ text: 'summary: ' + sm[1].trim(), role: 'summary' });
    const body = raw.replace(/^summary:.*\n\n?/, '');
    const parts = body.split(/^@@(user|agent)\n/m).slice(1);
    for (let i = 0; i < parts.length; i += 2) {
      for (const piece of splitText(parts[i + 1] || '')) out.push({ text: piece, role: parts[i] });
    }
    return out;
  }
  if (src.kind === 'session') {
    const t = raw.trim();
    return t ? [{ text: (base === 'TITLE.TXT' ? 'title: ' : 'project: ') + t, role: 'meta' }] : [];
  }
  return splitText(raw).map((text) => ({ text, role: '' }));
}

function syncIndex(db, extra = []) {
  const sources = listSources().concat(extra.map((p) => ({ path: p, kind: 'file', session: '' })));
  const known = new Map(db.prepare('SELECT path, sig, kind FROM files').all().map((r) => [r.path, r]));
  const seen = new Set();
  db.exec('BEGIN');
  try {
    for (const src of sources) {
      seen.add(src.path);
      let st;
      try { st = fs.statSync(src.path); } catch { continue; }
      if (src.kind === 'file' && st.size > 1000000) continue;
      const sig = st.mtimeMs + ':' + st.size;
      if (known.get(src.path)?.sig === sig) continue;
      let raw = '';
      try { raw = fs.readFileSync(src.path, 'utf-8'); } catch { continue; }
      db.prepare('DELETE FROM chunks WHERE path = ?').run(src.path);
      const ins = db.prepare('INSERT INTO chunks (text, path, kind, session, role) VALUES (?, ?, ?, ?, ?)');
      for (const c of chunkFile(src, raw)) ins.run(c.text, src.path, src.kind, src.session, c.role);
      db.prepare('INSERT OR REPLACE INTO files (path, sig, kind) VALUES (?, ?, ?)').run(src.path, sig, src.kind);
    }
    for (const [p, r] of known) {
      if (!seen.has(p) && r.kind !== 'file') {
        db.prepare('DELETE FROM chunks WHERE path = ?').run(p);
        db.prepare('DELETE FROM files WHERE path = ?').run(p);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function ftsQuery(q, mode) {
  const toks = (String(q || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 1 && !STOP.has(t)).slice(0, 8);
  if (!toks.length) return '';
  const quoted = toks.map((t, i) => '"' + t + '"' + (i === toks.length - 1 && t.length >= 3 ? '*' : ''));
  return quoted.join(mode === 'or' ? ' OR ' : ' ');
}

function sessionFile(id, name) {
  for (const bucket of ['ACTIVE-BUFFER', 'ENDED-BUFFER']) {
    const p = path.join(HOME, bucket, 'SESSION-' + id, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sessionOverview(id) {
  const bf = sessionFile(id, 'BUFFER.MD');
  if (!bf) return 'Error: session ' + id + ' not found';
  const read = (n) => { const p = sessionFile(id, n); try { return p ? fs.readFileSync(p, 'utf-8').trim() : ''; } catch { return ''; } };
  const raw = fs.readFileSync(bf, 'utf-8');
  const summary = (/^summary:(.*)/.exec(raw) || [])[1] || '';
  const msgs = chunkFile({ path: bf, kind: 'session' }, raw).filter((c) => c.role === 'user' || c.role === 'agent').slice(-4);
  const lines = ['session ' + id + (read('TITLE.TXT') ? ' "' + read('TITLE.TXT') + '"' : '') + (read('PROJECT.TXT') ? ' project ' + read('PROJECT.TXT') : '')];
  if (summary.trim()) lines.push('summary: ' + summary.trim().slice(0, 300));
  for (const m of msgs) lines.push(m.role + ': ' + m.text.replace(/\s+/g, ' ').slice(0, 160));
  return lines.join('\n').slice(0, 1200);
}

const resolveHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p));

export async function retrieve({ query, session, path: file, limit } = {}) {
  if (session && !query && !file) return sessionOverview(session);
  let db;
  try { db = await openDb(); } catch (e) { return 'Error: search index unavailable (' + String((e && e.message) || e).slice(0, 80) + '). It needs Node 22.13 or newer with node:sqlite.'; }
  try {
    const lim = Math.min(Math.max(Number(limit) || 5, 1), 8);
    const filePath = file ? resolveHome(String(file)) : '';
    syncIndex(db, filePath && fs.existsSync(filePath) ? [filePath] : []);
    if (filePath && !query) {
      const rows = db.prepare('SELECT text FROM chunks WHERE path = ? ORDER BY rowid LIMIT 2').all(filePath);
      return rows.length ? rows.map((r) => r.text).join('\n---\n').slice(0, 1200) : 'No indexed content for that path.';
    }
    const run = (mode) => {
      const q = ftsQuery(query, mode);
      if (!q) return [];
      let sql = "SELECT path, kind, session, role, snippet(chunks, 0, '[', ']', ' ... ', 20) AS s FROM chunks WHERE chunks MATCH ?";
      const params = [q];
      if (session) { sql += ' AND session = ?'; params.push(String(session)); }
      if (filePath) { sql += ' AND path = ?'; params.push(filePath); }
      sql += ' ORDER BY bm25(chunks) LIMIT ?';
      params.push(lim);
      return db.prepare(sql).all(...params);
    };
    let rows = run('and');
    if (!rows.length) rows = run('or');
    if (!rows.length && query) {
      try {
        const qVec = await getEmbedding(query);
        if (qVec) {
          const candSql = "SELECT text, path, kind, session, role FROM chunks WHERE kind IN ('memory', 'project') OR (kind = 'session' AND role = 'summary') LIMIT 60";
          const cands = db.prepare(candSql).all();
          const scored = [];
          for (const cand of cands) {
            const candVec = await getEmbedding(cand.text);
            if (candVec) {
              const sim = cosineSimilarity(qVec, candVec);
              if (sim > 0.32) {
                scored.push({ ...cand, s: cand.text.slice(0, 180), sim });
              }
            }
          }
          scored.sort((a, b) => b.sim - a.sim);
          rows = scored.slice(0, lim);
        }
      } catch {}
    }
    if (!rows.length) return 'No matches. Try different keywords.';
    const home = os.homedir();
    const lines = [];
    let total = 0;
    for (const r of rows) {
      const line = '[' + r.kind + (r.session ? ' ' + r.session : '') + (r.role ? ' ' + r.role : '') + '] ' + (r.kind === 'session' ? '' : r.path.replace(home, '~') + ': ') + String(r.s).replace(/\s+/g, ' ');
      if (total + line.length > 1200) break;
      lines.push(line);
      total += line.length;
    }
    return lines.join('\n');
  } finally {
    db.close();
  }
}

export async function rebuildIndex() {
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suf); } catch {} }
  let db;
  try { db = await openDb(); } catch (e) { return 'Error: search index unavailable (' + String((e && e.message) || e).slice(0, 80) + '). It needs Node 22.13 or newer with node:sqlite.'; }
  try {
    syncIndex(db, []);
    const f = db.prepare('SELECT count(*) AS n FROM files').get().n;
    const c = db.prepare('SELECT count(*) AS n FROM chunks').get().n;
    return 'Index rebuilt: ' + f + ' files, ' + c + ' chunks.';
  } finally {
    db.close();
  }
}
