import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BUFFER_ROOT = path.join(os.homedir(), '.levi', 'ACTIVE-BUFFER');
const MAX_ENTRIES = 500; // cap so this can't grow unbounded over a very long session

function sessionDir(id) {
  return path.join(BUFFER_ROOT, `SESSION-${id}`);
}

function usagePath(id) {
  return path.join(sessionDir(id), 'USAGE.json');
}

function turnMarkerPath(id) {
  return path.join(sessionDir(id), 'CURRENT_TURN.txt');
}

function readEntries(id) {
  try {
    return JSON.parse(fs.readFileSync(usagePath(id), 'utf-8'));
  } catch {
    return [];
  }
}

function writeEntries(id, entries) {
  try {
    fs.writeFileSync(usagePath(id), JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2));
  } catch {}
}

// Call once at the start of a runAgent() call — marks a new "turn" so every
// usage-recording call made during that turn (thought step, main loop steps,
// sub-agent calls) gets grouped together for /usage to sum up later.
export function startTurn(id) {
  const turnId = Date.now();
  try {
    fs.writeFileSync(turnMarkerPath(id), String(turnId));
  } catch {}
  return turnId;
}

function currentTurnId(id) {
  try {
    return Number(fs.readFileSync(turnMarkerPath(id), 'utf-8').trim()) || 0;
  } catch {
    return 0;
  }
}

// Records one API call's token usage against the session's current turn.
// Never throws — usage tracking should never break the actual work.
export function recordUsage(id, usage) {
  if (!id || !usage) return;
  try {
    const entries = readEntries(id);
    entries.push({
      turnId: currentTurnId(id),
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      at: Date.now()
    });
    writeEntries(id, entries);
  } catch {}
}

function sum(entries) {
  return entries.reduce(
    (acc, e) => ({ inputTokens: acc.inputTokens + e.inputTokens, outputTokens: acc.outputTokens + e.outputTokens }),
    { inputTokens: 0, outputTokens: 0 }
  );
}

// Total usage across the whole session so far.
export function getTotalUsage(id) {
  const entries = readEntries(id);
  const totals = sum(entries);
  const turnCount = new Set(entries.map((e) => e.turnId)).size;
  return { ...totals, turnCount, callCount: entries.length };
}

// Usage for just the most recent turn (the latest runAgent() call).
export function getLastTurnUsage(id) {
  const entries = readEntries(id);
  if (!entries.length) return { inputTokens: 0, outputTokens: 0, callCount: 0 };
  const latestTurnId = Math.max(...entries.map((e) => e.turnId));
  const turnEntries = entries.filter((e) => e.turnId === latestTurnId);
  return { ...sum(turnEntries), callCount: turnEntries.length };
}
