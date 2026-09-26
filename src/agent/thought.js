import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chat } from './client.js';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const MEMORY_ROOT = path.join(LEVI_HOME, 'MEMORY');
const PROJECTS_ROOT = path.join(LEVI_HOME, 'PROJECTS');

function listCandidateFiles(projectName) {
  const files = [];
  for (const f of ['USER.md', 'PREFERENCE.md', 'PATTERNS.md']) {
    const p = path.join(MEMORY_ROOT, f);
    if (fs.existsSync(p)) files.push('~/.levi/MEMORY/' + f);
  }
  if (projectName) {
    const root = path.join(PROJECTS_ROOT, projectName);
    for (const f of ['DATA.md', 'PREFERENCE.md', 'PATTERNS.md']) {
      const p = path.join(root, f);
      if (fs.existsSync(p)) files.push(`~/.levi/PROJECTS/${projectName}/${f}`);
    }
  }
  return files;
}

const THOUGHT_PROMPT = `You are a fast pre-processing step before a coding assistant replies. Given a user message and a list of files that actually exist right now, output ONLY valid JSON, no markdown fences, no explanation, in this exact shape:
{
  "retrieval": true or false,
  "type": "chitchat" or "coding" or "question" or "task" or "other",
  "files": [{"path": "<exact path from the candidate list>", "confidence": 0.0-1.0}],
  "task_cluster": null or {"title": "short title", "tasks": ["task 1", "task 2"]},
  "max_turns": integer 1-20,
  "note": "one short line of reasoning"
}

Rules:
- retrieval: false ONLY for pure chit-chat/greetings/general knowledge that needs nothing about this specific user or project. true for anything that might depend on remembered facts, preferences, or project state.
- files: ONLY pick paths from the candidate list given to you. Never invent a path. Empty array if none seem relevant or retrieval is false. Order doesn't matter, confidence does.
- task_cluster: ONLY set this when the message describes real multi-step build/coding work worth tracking as a checklist. null for anything else, including simple one-off asks.
- max_turns: your honest estimate of how many tool-call round trips this will realistically take. Simple Q&A: 1-3. Small edit: 3-6. Real feature/build: 6-15. Complex multi-file work: 15-20.
- note: brief, for debugging, not shown to the user.`;

export async function think(userMessage, { projectName } = {}) {
  const candidateFiles = listCandidateFiles(projectName);
  const prompt = `User message: "${userMessage}"

Candidate files that exist right now (pick only from this list if any apply):
${candidateFiles.length ? candidateFiles.map((f) => `- ${f}`).join('\n') : '(none exist yet)'}

Current project: ${projectName || '(none)'}`;

  let data;
  try {
    const res = await chat([{ role: 'user', content: prompt }], { system: THOUGHT_PROMPT });
    const cleaned = res.text.trim().replace(/^```json\s*|```\s*$/g, '');
    data = JSON.parse(cleaned);
  } catch {
    return { retrieval: true, type: 'unknown', files: [], task_cluster: null, max_turns: 10, note: 'thought step failed, using safe defaults' };
  }

  const validCandidates = new Set(candidateFiles);
  const maxTurns = Math.min(20, Math.max(1, Number(data.max_turns) || 10));

  return {
    retrieval: !!data.retrieval,
    type: typeof data.type === 'string' ? data.type : 'unknown',
    files: Array.isArray(data.files)
      ? data.files.filter((f) => f && typeof f.path === 'string' && validCandidates.has(f.path))
      : [],
    task_cluster:
      data.task_cluster && typeof data.task_cluster.title === 'string' && Array.isArray(data.task_cluster.tasks) && data.task_cluster.tasks.length
        ? { title: data.task_cluster.title, tasks: data.task_cluster.tasks }
        : null,
    max_turns: maxTurns,
    note: typeof data.note === 'string' ? data.note.slice(0, 200) : ''
  };
}
