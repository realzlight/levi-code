import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chat } from './client.js';
import { getTasks } from './tasks.js';
import { recordUsage } from './usage.js';

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

// Reads DATA.md and current task cluster status directly — no AI call, no
// tool-call round trip. This lets both the classification prompt and the
// main loop start already knowing the project's recorded state, instead of
// spending a tool call every turn just to discover it. Capped in size to
// keep this cheap; the actual code files still get verified separately.
function readProjectContext(projectName, sessionId) {
  let dataContent = '';
  if (projectName) {
    try {
      dataContent = fs.readFileSync(path.join(PROJECTS_ROOT, projectName, 'DATA.md'), 'utf-8').slice(0, 800);
    } catch {}
  }

  let taskSummary = '';
  if (sessionId) {
    try {
      const clusters = getTasks(sessionId);
      if (clusters.length) {
        taskSummary = clusters
          .map((c) => {
            const done = c.tasks.filter((t) => t.done).length;
            return `Cluster ${c.num} "${c.title}" [${c.status}] ${done}/${c.tasks.length} tasks done`;
          })
          .join('; ')
          .slice(0, 600);
      }
    } catch {}
  }

  return { dataContent, taskSummary };
}

const THOUGHT_PROMPT = `You are a fast pre-processing step before a coding assistant replies. Given a user message and a list of files that actually exist right now, output ONLY valid JSON, no markdown fences, no explanation, in this exact shape:
{
  "retrieval": true or false,
  "type": "chitchat" or "coding" or "question" or "task" or "other",
  "files": [{"path": "<exact path from the candidate list>", "confidence": 0.0-1.0}],
  "cross_session": true or false,
  "task_cluster": null or {"title": "short title", "tasks": ["task 1", "task 2"]},
  "max_turns": integer 1-20,
  "note": "one short line of reasoning"
}

Rules:
- FIRST check the recent thread given below. If the last assistant message asked a question or presented options, and the current user message looks like an answer to it (e.g. "yes", "homedir", "the second one", a short confirmation), this is a CONTINUATION of that flow, not a new topic — set retrieval to whatever fits continuing that work (usually false, since it's just confirming something already in progress), cross_session: false, task_cluster: null, and note should say it's a continuation. Do NOT treat a short answer like "yes" as a fresh greeting or chit-chat.
- If PROJECT CONTEXT (DATA.md content and task status) is given below, use it to resolve pronouns like "it"/"that" and to judge whether a request fits what's already built. If the request clearly doesn't fit the recorded project type (e.g. a UI feature for a CLI tool with no UI, per DATA.md), still classify it normally (type: coding, task_cluster describing the actual needed work, e.g. "convert X to a web app") — the main loop will confirm the mismatch with the user, you're just routing correctly.
- retrieval: false for pure chit-chat/greetings/general knowledge that needs nothing about this specific user or project, AND for continuations as above. true for anything that might depend on remembered facts, preferences, or project state, OR references a past conversation.
- cross_session: true if the message explicitly or implicitly refers to a PAST CONVERSATION (words like "last time", "earlier", "before", "we talked about", "what did we decide", "you said"), meaning the answer likely lives in another session's history, not in MEMORY/PROJECTS files. false otherwise, including for same-session continuations. If true, also set retrieval: true.
- files: ONLY pick paths from the candidate list given to you. Never invent a path. Empty array if none seem relevant or retrieval is false. Order doesn't matter, confidence does.
- task_cluster: ONLY set this when the message describes real multi-step build/coding work worth tracking as a checklist. null for anything else, including simple one-off asks. Tasks must be concrete, completable actions (e.g. "fix add() in math_utils.py") — never include vague wrap-up steps like "verify", "test", or "report status" as their own task items; those aren't discrete actions and shouldn't be on the checklist.
- max_turns: your honest estimate of how many tool-call round trips this will realistically take. Simple Q&A: 1-3. Small edit: 3-6. Real feature/build: 6-15. Complex multi-file work: 15-20.
- note: brief, for debugging, not shown to the user.`;

export async function think(userMessage, { projectName, recentMessages = [], sessionId } = {}) {
  const candidateFiles = listCandidateFiles(projectName);
  const { dataContent, taskSummary } = readProjectContext(projectName, sessionId);

  const threadBlock = recentMessages.length
    ? recentMessages.map((m) => `${m.role}: ${m.text}`).join('\n')
    : '(no prior messages in this session)';

  const projectContextBlock = projectName
    ? `PROJECT CONTEXT for "${projectName}":
DATA.md: ${dataContent || '(empty or not yet written)'}
Task status: ${taskSummary || '(no task clusters yet)'}`
    : '(no active project for this session)';

  const prompt = `Recent thread in this session, up to the last 3 exchanges (most recent last). Use this to judge whether the current message connects to what's already in progress or is a completely different request — you don't need to use all of it, just as much as actually helps:
${threadBlock}

${projectContextBlock}

Current user message: "${userMessage}"

Candidate files that exist right now (pick only from this list if any apply):
${candidateFiles.length ? candidateFiles.map((f) => `- ${f}`).join('\n') : '(none exist yet)'}

Current project: ${projectName || '(none)'}`;

  let data;
  try {
    const res = await chat([{ role: 'user', content: prompt }], { system: THOUGHT_PROMPT });
    if (sessionId) recordUsage(sessionId, res.usage);
    const cleaned = res.text.trim().replace(/^```json\s*|```\s*$/g, '');
    data = JSON.parse(cleaned);
  } catch {
    return { retrieval: true, type: 'unknown', files: [], cross_session: false, task_cluster: null, max_turns: 10, note: 'thought step failed, using safe defaults', dataContent: '', taskSummary: '' };
  }

  const validCandidates = new Set(candidateFiles);
  const maxTurns = Math.min(60, Math.max(1, Number(data.max_turns) || 10)); // hard ceiling raised — real scaling by task count happens in loop.js

  const crossSession = !!data.cross_session;
  return {
    retrieval: !!data.retrieval,
    type: typeof data.type === 'string' ? data.type : 'unknown',
    cross_session: crossSession,
    files: crossSession
      ? []
      : Array.isArray(data.files)
      ? data.files.filter((f) => f && typeof f.path === 'string' && validCandidates.has(f.path))
      : [],
    task_cluster:
      data.task_cluster && typeof data.task_cluster.title === 'string' && Array.isArray(data.task_cluster.tasks) && data.task_cluster.tasks.length
        ? { title: data.task_cluster.title, tasks: data.task_cluster.tasks }
        : null,
    max_turns: maxTurns,
    note: typeof data.note === 'string' ? data.note.slice(0, 200) : '',
    dataContent,
    taskSummary
  };
}
