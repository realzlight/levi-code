import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CACHE_DIR = path.join(os.homedir(), '.levi', 'cache');
const DB_PATH = path.join(CACHE_DIR, 'code_index.db');

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.cache', '.npm', '.cargo', '.vscode',
  '.idea', 'dist', 'build', '.next', '.levi', '.venv', '__pycache__',
  'coverage', '.turbo', 'vendor'
]);

const DEFAULT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.json',
  '.md', '.html', '.css', '.scss', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.java', '.kt', '.sql', '.env', '.txt', '.vue', '.svelte',
  '.rb', '.php', '.cs'
]);

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'svg', 'zip', 'tar',
  'gz', 'mp3', 'mp4', 'pdf', 'exe', 'so', 'dylib', 'woff', 'woff2',
  'ttf', 'bin', 'lock', 'db', 'sqlite'
]);

const CHUNK_SIZE = 40;
const OVERLAP = 5;
const MAX_FILE_SIZE = 500 * 1024; // 500 KB cap per file

let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  const w = process.emitWarning;
  process.emitWarning = () => {};
  let mod;
  try { mod = await import('node:sqlite'); } finally { process.emitWarning = w; }
  if (!mod || !mod.DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync not available');
  }
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  const db = new mod.DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime REAL,
      size INTEGER,
      root TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks USING fts5(
      filepath,
      line_start UNINDEXED,
      content,
      tokenize="trigram"
    );
  `);
  cachedDb = db;
  return db;
}

function chunkAndIndex(db, relPath, fullPath, insStmt) {
  try {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    if (!lines.length) return;
    for (let i = 0; i < lines.length; i += (CHUNK_SIZE - OVERLAP)) {
      const slice = lines.slice(i, i + CHUNK_SIZE);
      insStmt.run(relPath, i + 1, slice.join('\n'));
      if (i + CHUNK_SIZE >= lines.length) break;
    }
  } catch {}
}

function syncDirectory(db, rootDir, extFilter = null) {
  const normRoot = path.resolve(rootDir);
  const known = new Map(
    db.prepare('SELECT path, mtime, size FROM files WHERE root = ?').all(normRoot).map((r) => [r.path, r])
  );

  const seen = new Set();
  const toIndex = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.env') continue;
      const full = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name)) walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        const baseExt = ext.replace(/^\./, '');
        if (BINARY_EXTS.has(baseExt)) continue;
        if (extFilter && baseExt !== extFilter.toLowerCase().replace(/^\./, '')) continue;
        if (!extFilter && !DEFAULT_EXTS.has(ext)) continue;

        let stat;
        try {
          stat = fs.statSync(full);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }

        seen.add(full);
        const prev = known.get(full);
        if (!prev || prev.mtime !== stat.mtimeMs || prev.size !== stat.size) {
          toIndex.push({ full, mtime: stat.mtimeMs, size: stat.size });
        }
      }
    }
  }

  walk(normRoot);

  if (!toIndex.length && seen.size === known.size) return;

  const insChunk = db.prepare('INSERT INTO code_chunks(filepath, line_start, content) VALUES (?, ?, ?)');
  const insFile = db.prepare('INSERT OR REPLACE INTO files(path, mtime, size, root) VALUES (?, ?, ?, ?)');
  const delChunks = db.prepare('DELETE FROM code_chunks WHERE filepath = ?');
  const delFile = db.prepare('DELETE FROM files WHERE path = ?');

  db.exec('BEGIN TRANSACTION;');
  try {
    for (const item of toIndex) {
      const rel = path.relative(process.cwd(), item.full) || item.full;
      delChunks.run(rel);
      chunkAndIndex(db, rel, item.full, insChunk);
      insFile.run(item.full, item.mtime, item.size, normRoot);
    }
    for (const [p] of known) {
      if (!seen.has(p)) {
        const rel = path.relative(process.cwd(), p) || p;
        delChunks.run(rel);
        delFile.run(p);
      }
    }
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }
}

function buildFts5Query(query) {
  const clean = String(query || '').trim();
  if (!clean) return '';
  const tokens = clean.split(/\s+/).filter((t) => t.length >= 3);
  if (!tokens.length) {
    return clean.length >= 2 ? `"${clean.replace(/"/g, '')}"` : '';
  }
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
}

export async function searchCode({ query, path: targetPath, folder, extension, limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return 'Error: query parameter is required for code_search';

  const rawPath = folder || targetPath || '.';
  const resolvedDir = rawPath.startsWith('~')
    ? path.join(os.homedir(), rawPath.slice(1))
    : path.resolve(rawPath);

  if (!fs.existsSync(resolvedDir)) {
    return `Error: directory does not exist: ${resolvedDir}`;
  }

  let db;
  try {
    db = await getDb();
  } catch (err) {
    return `Error: SQLite FTS5 search unavailable (${err.message}). Use grep_search instead.`;
  }

  try {
    syncDirectory(db, resolvedDir, extension);
  } catch (syncErr) {
    return `Error indexing code: ${syncErr.message}`;
  }

  const ftsQ = buildFts5Query(q);
  if (!ftsQ) return 'Error: search query too short (must be at least 2-3 characters)';

  const lim = Math.min(Math.max(Number(limit) || 8, 1), 15);

  let rows = [];
  try {
    const stmt = db.prepare(`
      SELECT filepath, line_start, content
      FROM code_chunks
      WHERE code_chunks MATCH ?
      ORDER BY bm25(code_chunks)
      LIMIT ?
    `);
    rows = stmt.all(ftsQ, lim * 2);
  } catch (sqlErr) {
    // If strict match fails, try single quoted query
    try {
      const fallbackStmt = db.prepare(`
        SELECT filepath, line_start, content
        FROM code_chunks
        WHERE code_chunks MATCH ?
        ORDER BY bm25(code_chunks)
        LIMIT ?
      `);
      rows = fallbackStmt.all(`"${q.replace(/"/g, '')}"`, lim * 2);
    } catch {
      return `Error in FTS5 query: ${sqlErr.message}`;
    }
  }

  if (!rows.length) {
    return `No code matches found for "${q}" in ${rawPath}`;
  }

  const queryTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  const seenLines = new Set();
  const MAX_CHARS = 2400;
  let totalChars = 0;

  for (const row of rows) {
    if (results.length >= lim) break;
    const chunkLines = row.content.split(/\r?\n/);
    const startNum = Number(row.line_start) || 1;

    for (let i = 0; i < chunkLines.length; i++) {
      if (results.length >= lim) break;
      const lineText = chunkLines[i];
      const lower = lineText.toLowerCase();
      const matches = queryTerms.some((t) => lower.includes(t));
      if (matches) {
        const lineNum = startNum + i;
        const lineKey = `${row.filepath}:${lineNum}`;
        if (seenLines.has(lineKey)) continue;
        seenLines.add(lineKey);

        const trimmed = lineText.trim();
        const snippet = trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
        const lineOutput = `${row.filepath}:${lineNum}: ${snippet}`;

        if (totalChars + lineOutput.length > MAX_CHARS) {
          results.push(`... [more matches capped to save tokens]`);
          break;
        }

        results.push(lineOutput);
        totalChars += lineOutput.length;
      }
    }
  }

  if (!results.length) {
    // If exact lines didn't highlight, show chunk summaries
    for (const row of rows.slice(0, lim)) {
      const preview = row.content.split(/\r?\n/).slice(0, 3).map((l) => l.trim()).join(' ').slice(0, 100);
      results.push(`${row.filepath}:${row.line_start}: ${preview}`);
    }
  }

  return `[code_search: ${results.length} matches in ${rawPath} for "${q}"]\n` + results.join('\n');
}
