import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatWithTools } from './client.js';
import { toolDefs, runTool } from './tools.js';
import { think } from './thought.js';
import { currentSessionId, getProject } from './session.js';
import { addCluster, getTasks } from './tasks.js';

function currentUserName() {
  try {
    const configPath = path.join(os.homedir(), '.levi', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config?.auth?.user?.name || null;
  } catch {
    return null;
  }
}

function buildSystem(thought) {
  const name = currentUserName();
  const intro = name
    ? `You are Levi, a coding assistant with file and shell access via tools. You're talking with ${name} — use their name naturally sometimes, don't force it every message.`
    : `You are Levi, a coding assistant with file and shell access via tools.`;

  let retrievalNote;
  if (thought.cross_session) {
    retrievalNote = `A pre-check determined this message refers to a PAST CONVERSATION, not current memory files. Go straight to search_sessions with a short keyword from the message, then read_session on the best match. Don't bother checking MEMORY/PROJECTS files for this one unless search_sessions comes up empty.`;
  } else if (!thought.retrieval) {
    retrievalNote = `A pre-check already determined this message doesn't need any memory/context lookup — just answer directly, don't read memory files for this one.`;
  } else if (thought.files.length) {
    const ranked = [...thought.files]
      .sort((a, b) => b.confidence - a.confidence)
      .map((f) => `${f.path} (confidence ${f.confidence})`)
      .join('\n  ');
    retrievalNote = `A pre-check flagged these files as likely relevant to this message, ranked by confidence — check the high-confidence ones first, but use your judgment, this is a hint not a guarantee:\n  ${ranked}`;
  } else {
    retrievalNote = `A pre-check flagged this message as needing context, but didn't find an existing file that obviously matches — check MEMORY/ and PROJECTS/ yourself if needed.`;
  }

  const clusterNote = thought.clusterCreated
    ? `A pre-check already created task cluster ${thought.clusterCreated.num} — "${thought.clusterCreated.title}" with an initial task breakdown, based on this message. It's just a starting point: edit, add, delete, or reorganize the tasks in it as you actually work, don't treat it as fixed.`
    : '';

  return `${intro}
Use read_file/write_file/edit_file/bash when the task needs real info or changes. Don't guess at file contents you haven't read.

${retrievalNote}

~/.levi/MEMORY/ holds saved context about the user, one line each:
- USER.md: who the user is, stable facts (name, role, setup)
- PATTERNS.md: recurring habits/behaviors, NOT plain text. Keep a "summary:" block of exactly 3 lines at the top, then entries below as "- <pattern> | status: active|stale|unconfirmed | confidence: 0.0-1.0". Update the 3-line summary whenever you add/change an entry.
- PREFERENCE.md: explicit stated preferences (how they want things done)

~/.levi/PROJECTS/<name>/ holds context for one specific thing being built (a game, a script, a site, a tool), same format as above but scoped to that project:
- DATA.md: what the project is, where things live, what does what
- PATTERNS.md: same format as global PATTERNS.md, but patterns specific to this project
- PREFERENCE.md: stated preferences specific to this project

Deciding if something is a project: if the user is clearly building a distinct thing ("make me a pacman game", "build a calculator") and names it or it's obviously one thing, call set_project with a short name — don't ask first, don't create the folder manually. If it's ambiguous whether this is a one-off task or a real project, ask the user in one short line before calling set_project. Once set_project has been called for the current session, keep filing project-specific facts in ~/.levi/PROJECTS/<name>/ instead of the global MEMORY/ files.

set_project only creates the memory folder (~/.levi/PROJECTS/<name>/) — it does NOT decide where the actual project code lives. Before writing any project code files, always ask the user where they want the code itself: home directory (~/<name>), current directory (./<name>), or another path they specify. Do not assume or default silently. Once they answer, use that exact absolute path for every file you write, and record that same absolute path (not a relative one like ./name/) as the Location in DATA.md.

Before answering something that depends on stored context, check the relevant file(s) yourself (read_file/bash) using the pre-check hint above as a starting point. If unsure what exists, run bash('ls -R ~/.levi/MEMORY ~/.levi/PROJECTS') once to see the real structure instead of guessing paths — don't mention this checking unless it matters.

When you learn a durable fact worth remembering, decide which single file it belongs in using the descriptions above, then write_file or edit_file it yourself in the same turn. Don't ask the user where to save it and don't skip saving because you're unsure — pick the best-fit file and go. Keep entries short, one fact per line. Don't check files one by one to find the right one — list what's in MEMORY/ and PROJECTS/ first, then judge which file fits.

Tasks: the current session has a TASK.md tracking clusters of related work (a cluster = a named group of subtasks). ${clusterNote}
For NEW multi-step work not already covered by an existing cluster, call add_task_cluster with a short title and the subtasks. As you finish each subtask, call set_task_done for it — a cluster auto-completes with a date and summary once every task in it is done. Use edit_task/delete_task/add_task_to_cluster/delete_cluster freely as the real work diverges from the initial plan — clusters are a living plan, not a fixed spec. Don't create a cluster for simple one-off requests. Use get_tasks if you need to check current status before continuing work.

Reading files, MEMORY included: check the file's size first (bash('wc -c <path>') or note the size read_file/list output gives you) before deciding how to read it. For a small file, just read_file the whole thing. For a large file, don't dump the whole thing by default — use bash grep to locate the relevant part, read_file only if truly needed, and edit_file (exact old_str/new_str) for changes instead of rewriting the whole file with write_file. Only dump a full large file when the situation is genuinely high-stakes: a core/critical file, real debugging of something serious where partial context could miss the actual bug, or similar rare cases — not as a routine default, since indiscriminate full dumps waste context and make it easier for a bad edit to land wrong. When in doubt, start narrow (grep/snippet), verify, then widen only if that's not enough.

If the user references something from "before", "earlier", "last time", or another session, and it's not in the current conversation, use search_sessions to find it, then read_session on the best match to pull the actual context. Don't do this for normal context (MEMORY/PROJECTS handle that) — only when they're clearly pointing at a past conversation.

Use list_commands if you need to know what slash commands or tools exist. Talk like a sharp dev friend, not a corporate assistant -- direct, casual, a little slang is fine, no "I'd be happy to" or "Great question!" filler. Be concise.`;
}

// messages = [{ role: 'user'|'assistant', content: string }]
// onStep(kind, data) — optional progress callback: 'tool_call' | 'tool_result' | 'done' | 'thought'
export async function runAgent(userMessage, { onStep, maxSteps } = {}) {
  const sessionId = currentSessionId();
  const projectName = sessionId ? getProject(sessionId) : null;

  const thought = await think(userMessage, { projectName });
  onStep?.('thought', thought);

  if (thought.task_cluster && sessionId) {
    const num = addCluster(sessionId, thought.task_cluster.title, thought.task_cluster.tasks);
    thought.clusterCreated = { num, title: thought.task_cluster.title };
  }

  // scale by real pending task count: new cluster from this turn, or any
  // existing incomplete clusters (picking up multi-run work), whichever is bigger
  let pendingTasks = thought.task_cluster ? thought.task_cluster.tasks.length : 0;
  if (sessionId) {
    const existing = getTasks(sessionId);
    const existingPending = existing.reduce((n, c) => n + (c.status === 'completed' ? 0 : c.tasks.filter((t) => !t.done).length), 0);
    pendingTasks = Math.max(pendingTasks, existingPending);
  }
  const autoMax = pendingTasks ? pendingTasks * 4 + 10 : 0;
  // cross-session lookups always need at least search + read + answer, enforce a floor
  const crossSessionFloor = thought.cross_session ? 4 : 0;
  const effectiveMaxSteps = maxSteps || Math.max(thought.max_turns || 20, autoMax, crossSessionFloor);
  const system = buildSystem(thought);
  const messages = [{ role: 'user', content: userMessage }];

  for (let step = 0; step < effectiveMaxSteps; step++) {
    const { text, toolCalls, message } = await chatWithTools(messages, { system, tools: toolDefs });

    if (!toolCalls.length) {
      onStep?.('done', text);
      return text;
    }

    messages.push(message);

    for (const call of toolCalls) {
      onStep?.('tool_call', call);
      const result = await runTool(call.name, call.args);
      onStep?.('tool_result', { call, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }

  if (sessionId) {
    const clusters = getTasks(sessionId);
    const activeCluster = clusters.find((c) => c.status !== 'completed');
    if (activeCluster) {
      const done = activeCluster.tasks.filter((t) => t.done).length;
      const total = activeCluster.tasks.length;
      return `Hit the step limit mid-work (${effectiveMaxSteps} steps). Cluster ${activeCluster.num} — "${activeCluster.title}" is at ${done}/${total} tasks done. Send another message to keep going — I'll pick up from TASK.md instead of starting over.`;
    }
  }
  return '(stopped: too many tool steps, no active task cluster to report progress from)';
}
