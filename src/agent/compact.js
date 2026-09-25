import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chat } from './client.js';

const BUFFER_ROOT = path.join(os.homedir(), '.levi', 'ACTIVE-BUFFER');
const THRESHOLD = 6000; // chars, past the summary line
const KEEP_RECENT = 6; // messages kept raw after compaction

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

export async function maybeCompact(id) {
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
}
