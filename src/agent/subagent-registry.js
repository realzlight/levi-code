import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function registryPath(sessionId) {
  return path.join(os.homedir(), '.levi', 'ACTIVE-BUFFER', `SESSION-${sessionId}`, 'SUBAGENTS.json');
}

export function loadRegistry(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(registryPath(sessionId), 'utf-8'));
  } catch {
    return [];
  }
}

function saveRegistry(sessionId, registry) {
  try {
    fs.writeFileSync(registryPath(sessionId), JSON.stringify(registry, null, 2));
  } catch {}
}

// Creates or updates a sub-agent's entry. status is 'done' or 'stuck'
// (best-effort guess from whether the report mentions running out of steps).
export function upsertSubAgent(sessionId, { role, task, report, messages }) {
  const registry = loadRegistry(sessionId);
  const status = /ran out of steps|hit the step limit/i.test(report) ? 'stuck' : 'done';
  const idx = registry.findIndex((s) => s.role === role);
  const entry = { role, task, status, report, messages };
  if (idx === -1) registry.push(entry);
  else registry[idx] = entry;
  saveRegistry(sessionId, registry);
}

export function getSubAgent(sessionId, role) {
  return loadRegistry(sessionId).find((s) => s.role === role) || null;
}
