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

// Score a preference line based on explicit weights, priority tags, and keywords
export function scorePreference(raw, isProject = false) {
  let score = 0;
  const line = raw.replace(/^[-*•]\s*/, '').trim();
  if (!line) return { line: '', score: -999 };

  // Explicit weight tag: "weight: 10", "w: 8"
  const mWeight = line.match(/\b(?:weight|w):\s*(\d+)/i);
  if (mWeight) score += parseInt(mWeight[1], 10) * 2;

  // Priority tags: [critical], priority: high, etc.
  if (/\[(?:critical|high|urgent|p0)\]|\bpriority:\s*(?:critical|high|urgent)\b/i.test(line)) {
    score += 8;
  } else if (/\[(?:medium|normal|p1)\]|\bpriority:\s*(?:medium|normal)\b/i.test(line)) {
    score += 4;
  } else if (/\[(?:low|p2)\]|\bpriority:\s*low\b/i.test(line)) {
    score += 1;
  }

  // Prefix exclamation mark: ! Important rule
  if (/^!/.test(line)) score += 4;

  // Directive & rule keywords
  if (/\b(always|never|must|do not|don't|stop|strictly|require|critical|important|avoid)\b/i.test(line)) {
    score += 6;
  }

  // Preference verbs
  if (/\b(prefers?|wants?|likes?|favor|rule)\b/i.test(line)) {
    score += 3;
  }

  // Dev & workflow relevance
  if (/\b(npm|pnpm|yarn|install|globally|code|summary|concise|short|direct|dark mode|light mode|ui|terminal|mobile|clean|format|test|directory|git)\b/i.test(line)) {
    score += 3;
  }

  // Deprioritize casual food / chit-chat items compared to dev rules
  if (/\b(pizza|ramen|tacos|pasta)\b/i.test(line)) {
    score -= 3;
  }

  // Project-specific preferences are more localized and take precedence
  if (isProject) score += 4;

  // Strip metadata tags for clean, token-efficient prompt inclusion
  const cleanLine = line
    .replace(/\b(?:weight|w):\s*\d+\b/gi, '')
    .replace(/\[(?:critical|high|urgent|medium|normal|low|p0|p1|p2)\]/gi, '')
    .replace(/\bpriority:\s*(?:critical|high|urgent|medium|normal|low)\b/gi, '')
    .replace(/^!\s*/, '')
    .trim();

  return { line: cleanLine, score };
}

function packItems(items, budget) {
  const selected = [];
  let currentLen = 0;
  for (const item of items) {
    if (!item) continue;
    const cost = (selected.length > 0 ? 3 : 0) + item.length;
    if (currentLen + cost <= budget) {
      selected.push(item);
      currentLen += cost;
    }
  }
  return selected;
}

function getTopUserFacts(filePath, budget = 140) {
  const lines = readLines(filePath);
  const facts = [];
  for (const l of lines) {
    if (l.toLowerCase().startsWith('summary:')) continue;
    const clean = l.replace(/^[-*•]\s*/, '').trim();
    if (!clean) continue;
    let score = 1;
    if (/\b(termux|android|npm|node|python|linux|username|name:)\b/i.test(clean)) score += 5;
    if (/\b(project|working directory|setup|calc|game)\b/i.test(clean)) score += 2;
    if (/\b(tacos|ramen|pasta|pizza|gandhi)\b/i.test(clean)) score -= 3;
    facts.push({ line: clean, score });
  }
  facts.sort((a, b) => b.score - a.score);
  return packItems(facts.map((f) => f.line), budget);
}

function getTopPatterns(filePath, isProject = false, budget = 130) {
  const lines = readLines(filePath);
  const patterns = [];
  let inSummary = false;
  for (const l of lines) {
    if (l.toLowerCase().startsWith('summary:')) {
      inSummary = true;
      const s = l.slice(8).trim();
      if (s && !/no strong patterns yet/i.test(s)) patterns.push({ line: s, score: 8 });
      continue;
    }
    if (inSummary && !l.startsWith('-')) {
      if (!/no strong patterns yet/i.test(l)) patterns.push({ line: l, score: 7 });
      continue;
    }
    inSummary = false;
    const clean = l.replace(/^[-*•]\s*/, '').trim();
    if (!clean || /no strong patterns yet/i.test(clean)) continue;
    let score = 2 + (isProject ? 2 : 0);
    const confMatch = clean.match(/confidence:\s*([\d.]+)/i);
    if (confMatch) score += Math.round(parseFloat(confMatch[1], 10) * 5);
    if (/status:\s*active/i.test(clean)) score += 2;
    const display = clean.replace(/\s*\|\s*status:[^|]+/i, '').replace(/\s*\|\s*confidence:[^|]+/i, '').trim();
    patterns.push({ line: display, score });
  }
  patterns.sort((a, b) => b.score - a.score);
  return packItems(patterns.map((p) => p.line), budget);
}

// Memory digest strictly bounded to 100-150 tokens (~400-550 characters)
// Always loads weighted PREFERENCE.md, USER.md, and PATTERNS.md
export function readMemoryDigest({ prefsOnly = false, maxChars = 540 } = {}) {
  let project = null;
  try {
    const id = currentSessionId();
    project = id ? getProject(id) : null;
  } catch {}

  const G = path.join(LEVI_HOME, 'MEMORY');
  const P = project ? path.join(LEVI_HOME, 'PROJECTS', project) : null;

  // Gather & score all preferences (project + global)
  const allPrefs = [
    ...(P ? readLines(path.join(P, 'PREFERENCE.md')).map((l) => scorePreference(l, true)) : []),
    ...readLines(path.join(G, 'PREFERENCE.md')).map((l) => scorePreference(l, false))
  ].filter((p) => p.line.length > 0);

  allPrefs.sort((a, b) => b.score - a.score);

  const sections = [];

  if (prefsOnly) {
    const topPrefs = packItems(allPrefs.map((p) => p.line), maxChars - 15);
    if (topPrefs.length) sections.push('preferences: ' + topPrefs.join(' | '));
    return sections.join('\n').slice(0, maxChars);
  }

  // Allocate token budget (~100-150 tokens = ~400-550 chars):
  // Preferences: ~250 chars (~60 tokens)
  // User facts: ~140 chars (~35 tokens)
  // Patterns: ~130 chars (~35 tokens)
  const topPrefs = packItems(allPrefs.map((p) => p.line), 250);
  if (topPrefs.length) sections.push('preferences: ' + topPrefs.join(' | '));

  const userFacts = getTopUserFacts(path.join(G, 'USER.md'), 140);
  if (userFacts.length) sections.push('user: ' + userFacts.join(' | '));

  const allPatterns = [
    ...(P ? getTopPatterns(path.join(P, 'PATTERNS.md'), true, 60) : []),
    ...getTopPatterns(path.join(G, 'PATTERNS.md'), false, 120)
  ];
  const topPatterns = packItems(allPatterns, 130);
  if (topPatterns.length) sections.push('patterns: ' + topPatterns.join(' | '));

  return sections.join('\n').slice(0, maxChars);
}
