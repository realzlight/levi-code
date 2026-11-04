import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const UNDO_DIR = path.join(os.homedir(), '.levi', 'UNDO');

let currentTurnSnapshots = new Map(); // path -> { exists, content }
let currentTurnActive = false;

function ensureUndoDir() {
  try { fs.mkdirSync(UNDO_DIR, { recursive: true }); } catch {}
}

export function startTurnSnapshot() {
  currentTurnSnapshots = new Map();
  currentTurnActive = true;
}

export function snapshotFileBeforeEdit(filePath) {
  if (!filePath) return;
  const resolved = path.resolve(filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : filePath);
  
  // Only capture the file's initial state at the start of the turn
  if (currentTurnSnapshots.has(resolved)) return;

  try {
    if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
      const content = fs.readFileSync(resolved, 'utf-8');
      currentTurnSnapshots.set(resolved, { exists: true, content });
    } else {
      currentTurnSnapshots.set(resolved, { exists: false });
    }
  } catch {}
}

export function commitTurnSnapshot(sessionId) {
  currentTurnActive = false;
  if (!currentTurnSnapshots.size) return;

  ensureUndoDir();
  const records = [];
  for (const [filePath, snap] of currentTurnSnapshots.entries()) {
    records.push({ path: filePath, exists: snap.exists, content: snap.content });
  }

  const payload = {
    timestamp: new Date().toISOString(),
    sessionId: sessionId || 'default',
    files: records
  };

  try {
    fs.writeFileSync(path.join(UNDO_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
    if (sessionId) {
      fs.writeFileSync(path.join(UNDO_DIR, `session-${sessionId}.json`), JSON.stringify(payload, null, 2));
    }
  } catch {}
}

export function undoLastTurn(sessionId) {
  ensureUndoDir();
  let snapFile = path.join(UNDO_DIR, 'latest.json');
  if (sessionId && fs.existsSync(path.join(UNDO_DIR, `session-${sessionId}.json`))) {
    snapFile = path.join(UNDO_DIR, `session-${sessionId}.json`);
  }

  if (!fs.existsSync(snapFile)) {
    return { ok: false, error: 'No recent file modifications to undo.' };
  }

  try {
    const data = JSON.parse(fs.readFileSync(snapFile, 'utf-8'));
    const reverted = [];

    for (const item of data.files || []) {
      if (item.exists) {
        fs.mkdirSync(path.dirname(item.path), { recursive: true });
        fs.writeFileSync(item.path, item.content, 'utf-8');
        reverted.push({ path: item.path, action: 'restored' });
      } else {
        if (fs.existsSync(item.path)) {
          fs.unlinkSync(item.path);
          reverted.push({ path: item.path, action: 'deleted (new file rolled back)' });
        }
      }
    }

    // Move undone snapshot to prevent repeated double-undo
    try { fs.unlinkSync(snapFile); } catch {}
    if (snapFile !== path.join(UNDO_DIR, 'latest.json')) {
      try { fs.unlinkSync(path.join(UNDO_DIR, 'latest.json')); } catch {}
    }

    return { ok: true, timestamp: data.timestamp, reverted };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
