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
    if (fs.existsSync(path.join(MEMORY_ROOT, f))) files.push('~/.levi/MEMORY/' + f);
  }
  if (projectName) {
    for (const f of ['DATA.md', 'PREFERENCE.md', 'PATTERNS.md']) {
      if (fs.existsSync(path.join(PROJECTS_ROOT, projectName, f))) files.push(`~/.levi/PROJECTS/${projectName}/${f}`);
    }
  }
  return files;
}

// free, no AI call: DATA.md snippet + task cluster status for the [context] block
export function readProjectContext(projectName, sessionId) {
  let dataContent = '';
  if (projectName) {
    try {
      dataContent = fs.readFileSync(path.join(PROJECTS_ROOT, projectName, 'DATA.md'), 'utf-8').slice(0, 800);
    } catch {}
  }
  let taskSummary = '';
  if (sessionId) {
    try {
      taskSummary = getTasks(sessionId)
        .map((c) => `Cluster ${c.num} "${c.title}" [${c.status}] ${c.tasks.filter((t) => t.done).length}/${c.tasks.length} done`)
        .join('; ')
        .slice(0, 600);
    } catch {}
  }
  return { dataContent, taskSummary };
}

// constant string on purpose: stays cacheable
const THINK_SYSTEM = `You are a planning aid for a coding agent. You do NOT solve the task and never write code. You only give direction. Output ONLY JSON, no fences:
{"files":[{"path":"<exact candidate path>","confidence":0.0-1.0}],"plan":["short concrete step"],"subagents":null or {"count":1-3,"why":"short"},"ambiguity":null or "what is unclear","question":null or "one short question for the user"}
Rules:
- files: only exact paths from the candidate list, empty if none help.
- plan: 2-6 concrete, completable steps. Never vague wrap-ups like "verify" or "test".
- subagents: only if the work splits into independent chunks, else null.
- ambiguity/question: only for a consequential fork, else null.
- If new results are given, replan: adjust only the remaining steps.`;

const THINK_DESC = 'Get short planning direction: which memory files to read first, a step plan, whether sub-agents help, open questions. Use only for ambiguous, complex multi-file, or replanning moments. Skip for simple tasks.';
const THINK_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'what you are trying to do' },
    situation: { type: 'string', description: 'what is unclear, or new results to replan from' }
  },
  required: ['goal']
};

// matches whatever shape the existing tool defs use
export function thinkToolDef(sample) {
  if (sample && sample.function) return { type: sample.type || 'function', function: { name: 'think', description: THINK_DESC, parameters: THINK_SCHEMA } };
  if (sample && sample.input_schema) return { name: 'think', description: THINK_DESC, input_schema: THINK_SCHEMA };
  return { name: 'think', description: THINK_DESC, parameters: THINK_SCHEMA };
}

export async function think(args, { projectName, sessionId } = {}) {
  let a = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { a = { goal: a }; }
  }
  const goal = String(a?.goal || '').slice(0, 800);
  const situation = String(a?.situation || '').slice(0, 1500);
  const candidates = listCandidateFiles(projectName);
  const { dataContent, taskSummary } = readProjectContext(projectName, sessionId);

  const prompt = `goal: ${goal}
situation / new results: ${situation || '(none)'}
project: ${projectName || '(none)'}
DATA.md: ${dataContent || '(empty)'}
tasks: ${taskSummary || '(none)'}
candidate files:
${candidates.length ? candidates.map((f) => `- ${f}`).join('\n') : '(none)'}`;

  try {
    const res = await chat([{ role: 'user', content: prompt }], { system: THINK_SYSTEM });
    if (sessionId) recordUsage(sessionId, res.usage);
    const d = JSON.parse(res.text.trim().replace(/^```json\s*|```\s*$/g, ''));
    const valid = new Set(candidates);
    const files = (Array.isArray(d.files) ? d.files : [])
      .filter((f) => f && valid.has(f.path))
      .sort((x, y) => (y.confidence || 0) - (x.confidence || 0));
    const plan = Array.isArray(d.plan) ? d.plan.filter((s) => typeof s === 'string') : [];

    const out = [];
    if (files.length) out.push('read first: ' + files.map((f) => `${f.path} (${f.confidence})`).join(', '));
    if (plan.length) out.push('plan:\n' + plan.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    if (d.subagents) out.push(`sub-agents: ${d.subagents.count}, ${d.subagents.why}`);
    if (d.ambiguity) out.push('unclear: ' + d.ambiguity);
    if (d.question) out.push('ask the user: ' + d.question);
    return out.join('\n') || 'no extra direction, proceed with your own judgment';
  } catch {
    return 'think step failed, proceed with your own judgment';
  }
}
