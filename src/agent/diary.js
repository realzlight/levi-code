import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const BUFFER_ROOT = path.join(LEVI_HOME, 'ACTIVE-BUFFER');

const MAX_TOTAL_CHARS = 2000;
const MAX_NOTE_CHARS = 200;

function diaryPath(sessionId) {
  if (!sessionId) return null;
  return path.join(BUFFER_ROOT, `SESSION-${sessionId}`, 'DIARY.TXT');
}

export function writeDiary(sessionId, text) {
  if (!sessionId) return 'Error: no active session';
  const rawText = String(text || '').trim();
  if (!rawText) return 'Error: note text is empty';

  // Cap single note at 200 characters and collapse newlines into single line
  const note = rawText.replace(/[\r\n]+/g, ' ').slice(0, MAX_NOTE_CHARS).trim();
  if (!note) return 'Error: note text is empty';

  const fp = diaryPath(sessionId);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let lines = [];
  if (fs.existsSync(fp)) {
    try {
      lines = fs.readFileSync(fp, 'utf-8').split(/\r?\n/).filter(Boolean);
    } catch {
      lines = [];
    }
  }

  lines.push(note);

  // Cap at 2000 characters: drop oldest lines first
  while (lines.join('\n').length > MAX_TOTAL_CHARS && lines.length > 1) {
    lines.shift();
  }

  if (lines.length === 1 && lines[0].length > MAX_TOTAL_CHARS) {
    lines[0] = lines[0].slice(-MAX_TOTAL_CHARS);
  }

  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');
  return 'Note saved to session diary.';
}

export function readDiary(sessionId) {
  if (!sessionId) return 'Error: no active session';
  const fp = diaryPath(sessionId);
  if (!fp || !fs.existsSync(fp)) return '(Diary is empty)';

  try {
    const content = fs.readFileSync(fp, 'utf-8').trim();
    return content || '(Diary is empty)';
  } catch (err) {
    return `Error reading diary: ${err.message}`;
  }
}

export function handleDiary(args = {}, { sessionId } = {}) {
  const noteText = args.text || args.note;
  const isRead = Boolean(args.read);

  if (noteText) {
    const res = writeDiary(sessionId, noteText);
    if (res.startsWith('Error')) return res;
    if (isRead) {
      return readDiary(sessionId);
    }
    return res;
  }

  return readDiary(sessionId);
}
