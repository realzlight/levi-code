import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getEmbedding, rerankCandidates } from './embedding.js';

const HOME = path.join(os.homedir(), '.levi');
const DB_PATH = path.join(HOME, 'INDEX.db');
const CHUNK = 1000;
const STOP = new Set(['the', 'and', 'for', 'what', 'did', 'we', 'about', 'with', 'that', 'this', 'you', 'are', 'was', 'how', 'when', 'is', 'to', 'of', 'in', 'on', 'it', 'my', 'me', 'do', 'be', 'a', 'an']);

let hasVec = false;

async function openDb() {
  const w = process.emitWarning;
  process.emitWarning = () => {};
  let mod;
  try { mod = await import('node:sqlite'); } finally { process.emitWarning = w; }
  if (!mod || !mod.DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync is not available in this Node version');
  }
  try { fs.mkdirSync(HOME, { recursive: true }); } catch {}
  const db = new mod.DatabaseSync(DB_PATH, { allowExtension: true });
  db.exec('PRAGMA busy_timeout = 3000');

  // Dense Indexing initialization: load native sqlite-vec vec0 extension
  try {
    db.enableLoadExtension(true);
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const vecPath = path.resolve(__dirname, '../lib/sqlite-vec/vec0');
    db.loadExtension(vecPath);
    hasVec = true;
  } catch {
    hasVec = false;
  }

  // 1. Unified Data Layout Paradigm:
  // - Primary Persistence: relational table `documents`
  // - Sparse Indexing: external-content virtual table `documents_fts` linked via triggers
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, sig TEXT, kind TEXT);

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      text TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      path TEXT,
      kind TEXT,
      session TEXT,
      role TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title,
      text,
      content='documents',
      content_rowid='id',
      tokenize = 'porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
      INSERT INTO documents_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
    END;
  `);

  // Dense Indexing: vector virtual table `documents_vec` with vec0 syntax
  if (hasVec) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_vec USING vec0(
          id INTEGER PRIMARY KEY,
          embedding float[384]
        );
      `);
    } catch {
      hasVec = false;
    }
  }

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
      const m = /^SESSION-(\d+)(?:_.*)?$/.exec(d);
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
  try {
    const skillsDir = path.join(HOME, 'SKILLS');
    for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        let files = [];
        try { files = fs.readdirSync(path.join(skillsDir, ent.name)); } catch { continue; }
        for (const f of files) {
          if (/\.md$/i.test(f)) out.push({ path: path.join(skillsDir, ent.name, f), kind: 'skill', session: '' });
        }
      } else if (/\.md$/i.test(ent.name)) {
        out.push({ path: path.join(skillsDir, ent.name), kind: 'skill', session: '' });
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

async function syncIndex(db, extra = []) {
  const sources = listSources().concat(extra.map((p) => ({ path: p, kind: 'file', session: '' })));
  const known = new Map(db.prepare('SELECT path, sig, kind FROM files').all().map((r) => [r.path, r]));
  const seen = new Set();

  for (const src of sources) {
    seen.add(src.path);
    let st;
    try { st = fs.statSync(src.path); } catch { continue; }
    if (src.kind === 'file' && st.size > 1000000) continue;
    const sig = st.mtimeMs + ':' + st.size;
    if (known.get(src.path)?.sig === sig) continue;

    let raw = '';
    try { raw = fs.readFileSync(src.path, 'utf-8'); } catch { continue; }

    // Remove old document records and their dense vectors
    const oldDocs = db.prepare('SELECT id FROM documents WHERE path = ?').all(src.path);
    for (const d of oldDocs) {
      if (hasVec) {
        try { db.prepare('DELETE FROM documents_vec WHERE id = ?').run(BigInt(d.id)); } catch {}
      }
    }
    db.prepare('DELETE FROM documents WHERE path = ?').run(src.path);

    const title = path.basename(src.path);
    const chunks = chunkFile(src, raw);
    const insDoc = db.prepare('INSERT INTO documents (title, text, path, kind, session, role) VALUES (?, ?, ?, ?, ?, ?)');
    const insVec = hasVec ? db.prepare('INSERT INTO documents_vec(id, embedding) VALUES (?, ?)') : null;

    for (const c of chunks) {
      const res = insDoc.run(title, c.text, src.path, src.kind, src.session, c.role || '');
      const docId = BigInt(res.lastInsertRowid);

      if (insVec) {
        try {
          const vec = await getEmbedding(c.text);
          if (vec) {
            insVec.run(docId, vec);
          }
        } catch {}
      }
    }

    db.prepare('INSERT OR REPLACE INTO files (path, sig, kind) VALUES (?, ?, ?)').run(src.path, sig, src.kind);
  }

  for (const [p, r] of known) {
    if (!seen.has(p) && r.kind !== 'file') {
      const oldDocs = db.prepare('SELECT id FROM documents WHERE path = ?').all(p);
      for (const d of oldDocs) {
        if (hasVec) {
          try { db.prepare('DELETE FROM documents_vec WHERE id = ?').run(BigInt(d.id)); } catch {}
        }
      }
      db.prepare('DELETE FROM documents WHERE path = ?').run(p);
      db.prepare('DELETE FROM files WHERE path = ?').run(p);
    }
  }
}

function ftsQuery(q, mode) {
  const toks = (String(q || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((t) => t.length > 1 && !STOP.has(t)).slice(0, 8);
  if (!toks.length) return '';
  const quoted = toks.map((t, i) => '"' + t + '"' + (i === toks.length - 1 && t.length >= 3 ? '*' : ''));
  return quoted.join(mode === 'or' ? ' OR ' : ' ');
}

function sessionFile(id, name) {
  const active = path.join(HOME, 'ACTIVE-BUFFER', 'SESSION-' + id, name);
  if (fs.existsSync(active)) return active;
  const endedRoot = path.join(HOME, 'ENDED-BUFFER');
  if (fs.existsSync(endedRoot)) {
    try {
      const entries = fs.readdirSync(endedRoot);
      const found = entries.find((e) => new RegExp('^SESSION-' + id + '(?:_.*)?$').test(e));
      if (found) {
        const p = path.join(endedRoot, found, name);
        if (fs.existsSync(p)) return p;
      }
    } catch {}
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

/**
 * High-Precision Multi-Stage Hybrid Memory Architecture:
 * - Stage 1: Parallel High-Recall Extraction (Sparse FTS5 + Dense sqlite-vec)
 * - Stage 2: Reciprocal Rank Fusion Interleaving (RRF merging & top-25 candidate hydration)
 * - Stage 3: Full-Attention Cross-Encoder Reranking (Xenova/bge-reranker-base)
 */
export async function retrieve({ query, session, path: file, limit = 5, rebuild = false } = {}) {
  if (session && !query && !file) return sessionOverview(session);

  if (rebuild) {
    try { await rebuildIndex(); } catch {}
  }

  let db;
  try {
    db = await openDb();
  } catch (e) {
    return 'Error: search index unavailable (' + String((e && e.message) || e).slice(0, 80) + ').';
  }

  try {
    const lim = Math.min(Math.max(Number(limit) || 5, 1), 25);
    const filePath = file ? resolveHome(String(file)) : '';
    if (filePath && fs.existsSync(filePath)) {
      await syncIndex(db, [filePath]);
    } else {
      const hasDocs = db.prepare('SELECT 1 FROM documents LIMIT 1').get();
      if (!hasDocs) {
        await syncIndex(db);
      }
    }

    if (filePath && !query) {
      const rows = db.prepare('SELECT text FROM documents WHERE path = ? ORDER BY id LIMIT 2').all(filePath);
      return rows.length ? rows.map((r) => r.text).join('\n---\n').slice(0, 1200) : 'No indexed content for that path.';
    }

    if (!query) {
      return 'No search query provided.';
    }

    // ── STAGE 1: Parallel High-Recall Extraction (The Dragnet) ──
    const runSparse = () => {
      const q = ftsQuery(query, 'and') || ftsQuery(query, 'or');
      if (!q) return [];
      let sql = `SELECT rowid AS id, rank, snippet(documents_fts, 1, '[', ']', '...', 15) AS s FROM documents_fts WHERE documents_fts MATCH ?`;
      const params = [q];
      if (session) { sql += ' AND rowid IN (SELECT id FROM documents WHERE session = ?)'; params.push(String(session)); }
      if (filePath) { sql += ' AND rowid IN (SELECT id FROM documents WHERE path = ?)'; params.push(filePath); }
      sql += ' ORDER BY rank LIMIT 50';
      try { return db.prepare(sql).all(...params); } catch { return []; }
    };

    const runDense = async () => {
      if (!hasVec) return [];
      try {
        const qVec = await getEmbedding(query);
        if (!qVec) return [];
        let sql = `SELECT id, distance FROM documents_vec WHERE embedding MATCH ? AND k = ?`;
        const params = [qVec, 50n];
        sql += ' ORDER BY distance';
        return db.prepare(sql).all(...params);
      } catch {
        return [];
      }
    };

    const [sparseHits, denseHits] = await Promise.all([runSparse(), runDense()]);

    // ── STAGE 2: Reciprocal Rank Fusion Interleaving (The Mathematical Merge) ──
    const RRF_K = 60;
    const rrfScores = new Map(); // id -> { id, rrfScore, sparseRank, denseRank, snippet }

    sparseHits.forEach((hit, idx) => {
      const id = Number(hit.id);
      const rank = idx + 1;
      const cur = rrfScores.get(id) || { id, rrfScore: 0, snippet: hit.s };
      cur.rrfScore += 1.0 / (RRF_K + rank);
      cur.sparseRank = rank;
      if (hit.s) cur.snippet = hit.s;
      rrfScores.set(id, cur);
    });

    denseHits.forEach((hit, idx) => {
      const id = Number(hit.id);
      const rank = idx + 1;
      const cur = rrfScores.get(id) || { id, rrfScore: 0 };
      cur.rrfScore += 1.0 / (RRF_K + rank);
      cur.denseRank = rank;
      rrfScores.set(id, cur);
    });

    if (rrfScores.size === 0) {
      return 'No matches. Try different keywords.';
    }

    // Slice top 25 highest-scoring candidate IDs from RRF merge
    const top25Candidates = [...rrfScores.values()]
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, 25);

    const candidateIds = top25Candidates.map((c) => c.id);
    const placeholders = candidateIds.map(() => '?').join(',');
    const hydratedRows = db.prepare(`SELECT id, title, text, path, kind, session, role FROM documents WHERE id IN (${placeholders})`).all(...candidateIds);
    const hydratedMap = new Map(hydratedRows.map((r) => [Number(r.id), r]));

    const candidates = top25Candidates.map((c) => {
      const doc = hydratedMap.get(c.id) || {};
      return {
        ...doc,
        id: c.id,
        rrfScore: c.rrfScore,
        snippet: c.snippet || (doc.text ? doc.text.slice(0, 180) : '')
      };
    }).filter((d) => Boolean(d.text));

    if (candidates.length === 0) {
      return 'No matches found.';
    }

    // ── STAGE 3: Full-Attention Cross-Encoder Reranking (The Context Judge) ──
    let finalRanked = candidates;
    try {
      finalRanked = await rerankCandidates(query, candidates);
    } catch {
      finalRanked = candidates;
    }

    // Select absolute top N blocks to populate context window
    const selected = finalRanked.slice(0, lim);
    const home = os.homedir();
    const lines = [];
    let total = 0;

    for (const r of selected) {
      const snippet = r.snippet || r.text.slice(0, 200);
      const line = '[' + (r.kind || 'doc') + (r.session ? ' ' + r.session : '') + (r.role ? ' ' + r.role : '') + '] ' +
        (r.kind === 'session' ? '' : (r.path || '').replace(home, '~') + ': ') +
        String(snippet).replace(/\s+/g, ' ');

      if (total + line.length > 2000) break;
      lines.push(line);
      total += line.length;
    }

    return lines.join('\n') || 'No matches found.';
  } finally {
    try { db.close(); } catch {}
  }
}

export async function rebuildIndex() {
  for (const suf of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suf); } catch {}
  }
  let db;
  try {
    db = await openDb();
  } catch (e) {
    return 'Error: search index unavailable (' + String((e && e.message) || e).slice(0, 80) + ').';
  }
  try {
    await syncIndex(db);
    return 'Search index rebuilt successfully with Multi-Stage Hybrid Memory (FTS5 + vec0 + Cross-Encoder).';
  } finally {
    try { db.close(); } catch {}
  }
}
