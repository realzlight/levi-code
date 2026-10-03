import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { currentSessionId, getProject } from './session.js';

const LEVI_HOME = path.join(os.homedir(), '.levi');

function readLines(p) {
  try {
    return fs.readFileSync(p, 'utf-8').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  } catch {
    return [];
  }
}

// PATTERNS.md keeps a "summary:" block at the top; only that block goes into context
function patternSummary(p) {
  const lines = readLines(p);
  const i = lines.findIndex((x) => x.toLowerCase().startsWith('summary:'));
  if (i < 0) return [];
  const out = [];
  const first = lines[i].slice(8).trim();
  if (first) out.push(first);
  for (let k = i + 1; k < lines.length && out.length < 3 && !lines[k].startsWith('- '); k++) out.push(lines[k]);
  return out.filter((x) => !/no strong patterns yet/i.test(x));
}

// Capped digest of saved memory for the [context] block. prefsOnly: just preferences (chat/light modes).
export function readMemoryDigest({ prefsOnly = false, maxChars = 1200 } = {}) {
  let project = null;
  try {
    const id = currentSessionId();
    project = id ? getProject(id) : null;
  } catch {}
  const G = path.join(LEVI_HOME, 'MEMORY');
  const P = project ? path.join(LEVI_HOME, 'PROJECTS', project) : null;
  const sections = [];
  const add = (label, lines, cap) => {
    const text = lines.join(' | ').slice(0, cap);
    if (text) sections.push(label + ': ' + text);
  };
  add('preferences', readLines(path.join(G, 'PREFERENCE.md')), 500);
  if (P) add('project ' + project + ' preferences', readLines(path.join(P, 'PREFERENCE.md')), 400);
  if (!prefsOnly) {
    add('user', readLines(path.join(G, 'USER.md')), 500);
    add('patterns', patternSummary(path.join(G, 'PATTERNS.md')), 300);
    if (P) add('project ' + project + ' patterns', patternSummary(path.join(P, 'PATTERNS.md')), 300);
  }
  return sections.join('\n').slice(0, maxChars);
}
