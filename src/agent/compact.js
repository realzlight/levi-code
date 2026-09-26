import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chat } from './client.js';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const BUFFER_ROOT = path.join(LEVI_HOME, 'ACTIVE-BUFFER');
const MEMORY_ROOT = path.join(LEVI_HOME, 'MEMORY');
const THRESHOLD = 6000; // chars, past the summary line, triggers buffer compaction
const KEEP_RECENT = 6; // messages kept raw after compaction
const USER_SUMMARY_THRESHOLD = 2000; // chars of facts, triggers a 3-line summary refresh on USER.md/DATA.md

function bufferPath(id) {
  return path.join(BUFFER_ROOT, `SESSION-${id}`, 'BUFFER.MD');
}

function parse(raw) {
  const summaryMatch = raw.match(/^summary:(.*)\n\n?/);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';
  const body = summaryMatch ? raw.slice(summaryMatch[0].length) : raw;

  const parts = body.split(/^@@(user|agent)\n/m).slice(1);
  const messages = [];
  for (let i = 0; i < parts.length; i += 2) {
    const role = parts[i];
    const text = (parts[i + 1] || '').replace(/\n+$/, '');
    if (text) messages.push({ role, text });
  }
  return { summary, messages };
}

function serialize(summary, messages) {
  const head = `summary: ${summary}\n\n`;
  const body = messages.map((m) => `@@${m.role}\n${m.text}\n`).join('\n');
  return head + body + (body ? '\n' : '');
}

const SUMMARY_PROMPT = `Summarize this conversation so far in 2-4 sentences. Cover the key facts, decisions, and what was worked on. End with one line starting "Likely next:" naming what the user might ask about next, based on the pattern of the conversation. Be concise, plain text, no markdown headers.`;

const EXTRACT_PROMPT = `Review this conversation and pull out anything durable worth remembering long-term. Reply with ONLY valid JSON, no markdown fences, in this exact shape:
{
  "user": ["short stable fact, e.g. name/role/setup, or for a project: what it is/where things live/what does what"],
  "preference": ["short explicit stated preference"],
  "patterns": [{"text": "short recurring habit/behavior noticed", "status": "active", "confidence": 0.7}],
  "patterns_summary": ["line 1", "line 2", "line 3"]
}
Only include real, durable info actually present in the conversation. Use empty arrays for anything not present. status is one of active|stale|unconfirmed. confidence is 0.0-1.0, your honest estimate. patterns_summary is exactly 3 short lines summarizing the patterns file as a whole (can be generic like "No strong patterns yet" if patterns is empty).`;

const USER_PERSON_SUMMARY_PROMPT = `You are summarizing USER.md, a file of facts about a real HUMAN user, not a project, system, or app. You will be given a list of facts (one per line, each starting with "-"). Write exactly 3 short factual lines describing this specific person based ONLY on the facts given — do not invent traits, do not describe them as a project/system/tool. If a fact is unclear or filler, ignore it rather than inventing meaning. Plain text, no markdown, no numbering, just 3 lines.`;

const USER_PROJECT_SUMMARY_PROMPT = `You are summarizing DATA.md, a file of facts about a specific software project being built. You will be given a list of facts (one per line, each starting with "-"). Write exactly 3 short factual lines describing what this project is and where things stand, based ONLY on the facts given — do not invent details. Plain text, no markdown, no numbering, just 3 lines.`;

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function mergePlain(file, newFacts) {
  if (!newFacts.length) return;
  const existing = readLines(file);
  const existingLower = existing.map((l) => l.toLowerCase());
  const toAdd = newFacts
    .map((f) => (f.startsWith('-') ? f : `- ${f}`))
    .filter((f) => !existingLower.includes(f.toLowerCase()));
  if (!toAdd.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...existing, ...toAdd].join('\n') + '\n');
}

function mergePatterns(file, newEntries, summaryLines) {
  let existingEntries = [];
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    existingEntries = raw
      .split('\n')
      .filter((l) => l.trim().startsWith('- '))
      .map((l) => l.trim());
  } catch {}

  const byText = new Map(existingEntries.map((l) => [l.replace(/^-\s*/, '').split('|')[0].trim().toLowerCase(), l]));

  for (const e of newEntries) {
    const line = `- ${e.text} | status: ${e.status || 'unconfirmed'} | confidence: ${e.confidence ?? 0.5}`;
    byText.set(e.text.trim().toLowerCase(), line);
  }

  const entries = [...byText.values()];
  const summary = (summaryLines && summaryLines.length ? summaryLines : ['No strong patterns yet.', '', '']).slice(0, 3);
  while (summary.length < 3) summary.push('');

  const content = `summary:\n${summary.join('\n')}\n\n${entries.join('\n')}${entries.length ? '\n' : ''}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Parses a USER.md/DATA.md file that may or may not already have a
// "summary:\n<3 lines>\n\n" header on top, returning just the fact lines.
function parseUserFacts(raw) {
  const summaryMatch = raw.match(/^summary:\n(.*\n){3}\n?/);
  const body = summaryMatch ? raw.slice(summaryMatch[0].length) : raw;
  return body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-'));
}

// Cheap path (append only) under the size threshold; full rewrite with a
// regenerated 3-line summary once the fact list is big enough that scanning
// it raw stops being practical.
async function mergeUserFacts(file, newFacts, isProject = false) {
  if (!newFacts.length) return;
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {}

  const existing = parseUserFacts(raw);
  const existingLower = existing.map((l) => l.toLowerCase());
  const toAdd = newFacts
    .map((f) => (f.startsWith('-') ? f : `- ${f}`))
    .filter((f) => !existingLower.includes(f.toLowerCase()));
  if (!toAdd.length) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const combined = [...existing, ...toAdd];
  const bodySize = combined.join('\n').length;

  if (bodySize < USER_SUMMARY_THRESHOLD) {
    // cheap: append new lines only, no read-back of full content needed beyond what we already parsed, no AI call
    const alreadyHasSummary = /^summary:\n/.test(raw);
    if (!raw || (!alreadyHasSummary && !raw.trim())) {
      fs.writeFileSync(file, toAdd.join('\n') + '\n');
    } else {
      const sep = raw.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(file, sep + toAdd.join('\n') + '\n');
    }
    return;
  }

  // important: full dump, regenerate the top summary so a big file stays scannable
  let summaryLines;
  try {
    const res = await chat([{ role: 'user', content: combined.join('\n') }], { system: isProject ? USER_PROJECT_SUMMARY_PROMPT : USER_PERSON_SUMMARY_PROMPT });
    summaryLines = res.text.trim().split('\n').filter(Boolean).slice(0, 3);
  } catch {
    summaryLines = [];
  }
  while (summaryLines.length < 3) summaryLines.push('');

  const content = `summary:\n${summaryLines.join('\n')}\n\n${combined.join('\n')}\n`;
  fs.writeFileSync(file, content);
}

async function extractToMemory(transcript, projectName = null) {
  let data;
  try {
    const res = await chat([{ role: 'user', content: transcript }], { system: EXTRACT_PROMPT });
    const cleaned = res.text.trim().replace(/^```json\s*|```\s*$/g, '');
    data = JSON.parse(cleaned);
  } catch {
    return; // skip extraction silently if the call or parse fails, compaction itself still proceeds
  }

  const root = projectName ? path.join(LEVI_HOME, 'PROJECTS', projectName) : MEMORY_ROOT;
  const dataFile = projectName ? 'DATA.md' : 'USER.md';

  await mergeUserFacts(path.join(root, dataFile), data.user || [], !!projectName);
  mergePlain(path.join(root, 'PREFERENCE.md'), data.preference || []);
  if ((data.patterns || []).length) {
    mergePatterns(path.join(root, 'PATTERNS.md'), data.patterns, data.patterns_summary);
  }
}

export async function maybeCompact(id, projectName = null) {
  const file = bufferPath(id);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return;
  }

  const { summary, messages } = parse(raw);
  const bodySize = messages.reduce((n, m) => n + m.text.length, 0);
  if (bodySize < THRESHOLD || messages.length <= KEEP_RECENT) return;

  const toCompact = messages.slice(0, -KEEP_RECENT);
  const keep = messages.slice(-KEEP_RECENT);

  const transcript = toCompact.map((m) => `${m.role}: ${m.text}`).join('\n');
  const prompt = summary
    ? `Previous summary:\n${summary}\n\nNew messages to fold in:\n${transcript}`
    : `Conversation:\n${transcript}`;

  let newSummary;
  try {
    newSummary = (await chat([{ role: 'user', content: prompt }], { system: SUMMARY_PROMPT })).text.trim();
  } catch {
    return; // leave buffer as-is if the summarization call fails
  }

  fs.writeFileSync(file, serialize(newSummary, keep));

  await extractToMemory(transcript, projectName);
}
