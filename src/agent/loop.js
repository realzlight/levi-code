import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatWithTools } from './client.js';
import { toolDefs, runTool } from './tools.js';
import { think } from './thought.js';
import { currentSessionId, getProject, loadMessages } from './session.js';
import { addCluster, getTasks } from './tasks.js';
import { startTurn, recordUsage } from './usage.js';

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

  const projectContextNote = (thought.dataContent || thought.taskSummary)
    ? `Already known about the current project (read once already, no need to re-fetch these two specific things unless you suspect they're stale):
DATA.md content: ${thought.dataContent || '(empty)'}
Task status: ${thought.taskSummary || '(no clusters yet)'}
This does NOT replace actually reading the real code files before making claims about what they contain — DATA.md and task status can be outdated or wrong, so verify anything the request depends on by reading the actual files.`
    : '';

  return `${intro}
Use read_file/write_file/edit_file/bash when the task needs real info or changes. Use sed and grep/regex where you can and always verify! avoid dumping files content and dumping again to verify! Don't guess at file contents you haven't read.

${retrievalNote}

${projectContextNote}

~/.levi/MEMORY/ holds saved context about the user, one line each:
- USER.md: who the user is, stable facts (name, role, setup)
- PATTERNS.md: recurring habits/behaviors, NOT plain text. Keep a "summary:" block of exactly 3 lines at the top, then entries below as "- <pattern> | status: active|stale|unconfirmed | confidence: 0.0-1.0". Update the 3-line summary whenever you add/change an entry.
- PREFERENCE.md: explicit stated preferences (how they want things done)

~/.levi/PROJECTS/<name>/ holds context for one specific thing being built (a game, a script, a site, a tool), same format as above but scoped to that project:
- DATA.md: what the project is, where things live, what does what
- PATTERNS.md: same format as global PATTERNS.md, but patterns specific to this project
- PREFERENCE.md: stated preferences specific to this project

Deciding if something is a project: BEFORE calling set_project with a new name, always bash('ls -R ~/.levi/PROJECTS') in depth first to see if a similar project already exists (different casing, a synonym, a slightly different name for the same thing) — reuse that exact existing name with set_project instead of creating a near-duplicate folder for the same thing. Only after confirming nothing matches, if the user is clearly building a distinct thing ("make me a pacman game", "build a calculator") and names it or it's obviously one thing, call set_project with a short name — don't ask first, don't create the folder manually. If it's ambiguous whether this is a one-off task or a real project, ask the user in one short line before calling set_project. Once set_project has been called for the current session, keep filing project-specific facts in ~/.levi/PROJECTS/<name>/ instead of the global MEMORY/ files.

set_project only creates the memory folder (~/.levi/PROJECTS/<name>/) — it does NOT decide where the actual project code lives. Before writing any project code files, ask the user ONE thing at a time only if it's genuinely not already answered: where the code should live (home dir, current dir, another path). Do not assume or default silently on location. Once they answer, use that exact absolute path for every file you write, and record that same absolute path (not a relative one like ./name/) as the Location in DATA.md. Never guess or write a generic path like /root/ or /home/user/ — always resolve the real home directory yourself first (e.g. bash('echo ~') or bash('pwd')) rather than assuming what it is. This applies to bash commands too, not just file paths — if you're about to run a verification command referencing a home-relative path (e.g. a python import path), use the already-resolved real path or a relative "cd ~/dir && ..." form, don't guess a generic one and retry after it fails.

Do NOT ask more than one clarifying question in a row before starting real work, and do NOT ask something the user already told you. If the original request already says what's being built ("build me a todo app", "make a calculator"), that IS the spec — don't ask "what kind of app do you want to build" or re-derive requirements they already gave you. Ask about location if unknown, then just start building with reasonable defaults for anything else unstated (pick a sensible tech stack yourself, don't ask). Only ask a second question if something is a genuine, consequential fork (not a preference you could reasonably guess).

Before answering something that depends on stored context, check the relevant file(s) yourself (read_file/bash) using the pre-check hint above as a starting point. If unsure what exists, run bash('ls -R ~/.levi/MEMORY ~/.levi/PROJECTS') once to see the real structure instead of guessing paths — don't mention this checking unless it matters.

When you learn a durable fact worth remembering, decide which single file it belongs in using the descriptions above, then write_file or edit_file it yourself in the same turn. Don't ask the user where to save it and don't skip saving because you're unsure — pick the best-fit file and go. Keep entries short, one fact per line. Don't check files one by one to find the right one — list what's in MEMORY/ and PROJECTS/ first, then judge which file fits.

Tasks: the current session has a TASK.md tracking clusters of related work (a cluster = a named group of subtasks). ${clusterNote}
For NEW multi-step work not already covered by an existing cluster, call add_task_cluster with a short title and the subtasks. Only include real, concrete, completable work as tasks (e.g. "fix add() in math_utils.py", "write the login form HTML") — do NOT include vague wrap-up steps like "verify the fix", "test it", or "report status" as their own checklist items. Those aren't discrete actions with a clear tool call attached to them; they're just part of how any turn naturally ends, and listing them as tasks leaves nothing to actually "do" for them, which can stall you at the end. If real verification matters, do it as part of finishing the actual task, not as a separate line item. As you finish each subtask, call set_task_done for it — a cluster auto-completes with a date and summary once every task in it is done. Use edit_task/delete_task/add_task_to_cluster/delete_cluster freely as the real work diverges from the initial plan — clusters are a living plan, not a fixed spec. Don't create a cluster for simple one-off requests. Use get_tasks if you need to check current status before continuing work. If get_tasks returns an active (not completed) cluster whose title matches what the user is now asking about, you are CONTINUING existing work — do NOT ask where to write code again, do NOT delete or recreate the cluster, and do NOT verify the recorded path exists on disk first (write_file/bash mkdir create missing directories automatically, so an empty/missing folder just means nothing's been written yet, not that the plan is wrong). Trust DATA.md's recorded Location, go directly to implementing the next incomplete subtask, and let file-writing itself create whatever's missing.

Reading files, MEMORY included: check the file's size first (bash('wc -c <path>') or note the size read_file/list output gives you) before deciding how to read it. For a small file, just read_file the whole thing. For a large file, don't dump the whole thing by default — use bash grep to locate the relevant part, read_file only if truly needed, and edit_file (exact old_str/new_str) for changes instead of rewriting the whole file with write_file. Only dump a full large file when the situation is genuinely high-stakes: a core/critical file, real debugging of something serious where partial context could miss the actual bug, or similar rare cases — not as a routine default, since indiscriminate full dumps waste context and make it easier for a bad edit to land wrong. When in doubt, start narrow (grep/snippet), verify, then widen only if that's not enough.

If the user references something from "before", "earlier", "last time", or another session, and it's not in the current conversation, use search_sessions to find it, then read_session on the best match to pull the actual context. Don't do this for normal context (MEMORY/PROJECTS handle that) — only when they're clearly pointing at a past conversation.

Whenever you need to ask the user something with a small set of likely answers (yes/no, pick between a few paths, choose an option), use the ask tool instead of asking in plain text — the user gets clickable choices. Only ask in plain text when the answer genuinely needs free-form input with no sensible short options.

Before responding to any request about an existing project (a change, a new feature, "is it done", anything not a brand new build), you MUST do these in order first: (1) read_file the project's DATA.md to get its recorded Location and description, (2) get_tasks to see the cluster(s) for this project — their status and what's been done, (3) bash ls the Location from DATA.md to see the real files, (4) read_file the main code file(s) found there. Do NOT decide anything or respond based on folder names in ~/.levi/PROJECTS/ alone — that only shows memory folder names, not the actual project. Only after actually reading the real code and task state can you know whether a request fits.

If a completed cluster's work doesn't fit a new request (e.g. existing work is a CLI tool and the new ask needs a UI), don't just leave the stale cluster sitting there — after confirming the pivot with the user via ask, delete_cluster the old one and add_task_cluster for the new direction, so TASK.md reflects what's actually being worked on now, not a dead plan.

If, after that real investigation, the request genuinely doesn't fit what's built (e.g. "add a dark mode toggle" for a CLI tool with no UI, a visual feature for a backend-only project), use ask to name the SPECIFIC mismatch based on what you actually read and offer SPECIFIC options (e.g. "todo-app is a Python CLI tool with no UI — a dark mode toggle doesn't apply. Want me to convert it to a web app, add colored terminal output instead, or something else?"). Never respond with a vague "not sure, can you rephrase" — you should always be able to name exactly what you found and what doesn't fit, because you actually looked.

If you've already built or changed real files successfully, a later check failing (a missing dependency, a command not found, a test you can't run) does NOT erase that success — don't throw away completed work and fall back to a vague "ran into something" message. Instead, tell the user plainly what you built, name the specific missing thing, and say how to install or fix it, or offer a no-dependency alternative if one exists. For example, if you built app.py and index.html with dark mode but Flask isn't installed, mention that installing Flask would let it run, or offer to make it a static HTML/JS version with no backend instead. A missing dependency is information to report, not a reason to abandon a turn that already succeeded.

Your context priority order, always, for anything that isn't a totally fresh unrelated request: (1) the current thread/last messages you already have, (2) this session's summary if one exists, (3) TASK.md via get_tasks for what's in progress and its status, (4) the project's DATA.md for what's actually been built and where. Only after checking all of those, and only if the request clearly points at a different, earlier conversation, use search_sessions as the last resort — not the first move, not a substitute for checking what's already right here.

Sub-agents: for real, separable work, you can delegate to sub-agents with spawn_subagent — give each a concrete, direct instruction (exact file, exact change, exact report target), not a vague goal. They have file/bash access only, no memory or task tools, no ability to ask questions — treat them like labor, not peers. Only spawn one for work that's actually worth separating out; never for simple tasks you could just do yourself, and never over-engineer with more sub-agents than the work needs. As a rough guide: 1-2 sub-agents when you're doing most of the work yourself with some help (worker mode), 2-3 when you're mainly coordinating others (orchestrator mode) — pick whichever fits, don't force either.

Sub-agents don't see each other's work on their own — if a new sub-agent's task depends on what a previous one did, YOU pass that context along explicitly in its instruction (e.g. include the relevant part of an earlier report). Use list_subagents to see everyone spawned so far and their status/reports, and message_subagent to follow up with an existing one instead of spawning a duplicate.

HARD RULE: the very next tool call after ANY spawn_subagent or message_subagent call MUST be a task-management call (set_task_done, add_task_to_cluster, edit_task, etc.) reflecting what that report actually said — before verification, before another sub-agent, before anything else. This is not optional and not something to do "eventually" — do it immediately, every single time, right after reading that report. Only after TASK.md reflects the report should you move on to verifying the work or deciding if more sub-agent work is needed.

Use list_commands if you need to know what slash commands or tools exist. Talk like a sharp dev friend, not a corporate assistant -- direct, casual, a little slang is fine, no "I'd be happy to" or "Great question!" filler. Be concise.`;
}

// messages = [{ role: 'user'|'assistant', content: string }]
// onStep(kind, data) — optional progress callback: 'tool_call' | 'tool_result' | 'done' | 'thought'
export async function runAgent(userMessage, { onStep, maxSteps } = {}) {
  const sessionId = currentSessionId();
  if (sessionId) startTurn(sessionId);
  const projectName = sessionId ? getProject(sessionId) : null;

  // up to the last 3 exchanges (user+agent pairs), so think() can judge whether
  // this message connects to recent work or is a completely different request
  const recentMessages = sessionId ? loadMessages(sessionId).slice(-6) : [];
  const thought = await think(userMessage, { projectName, recentMessages, sessionId });
  onStep?.('thought', thought);

  if (thought.task_cluster && sessionId) {
    const existingActive = getTasks(sessionId).some((c) => c.status !== 'completed');
    if (!existingActive) {
      const num = addCluster(sessionId, thought.task_cluster.title, thought.task_cluster.tasks);
      thought.clusterCreated = { num, title: thought.task_cluster.title };
    }
    // if an active cluster already exists, trust that instead of creating a duplicate —
    // Levi's own add_task_cluster/add_task_to_cluster tools handle genuinely new work from here
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
  // static floors, not fully trusting the AI's own turn estimate: 30 for anything
  // normal, 100 whenever real multi-step work is involved, so a run doesn't cut off
  // mid-work just because a guess came in low — TASK.md progress persists either way
  const isHardWork = pendingTasks > 0 || !!thought.task_cluster || thought.type === 'coding' || thought.type === 'task';
  const staticFloor = isHardWork ? 100 : 30;
  const effectiveMaxSteps = maxSteps || Math.max(thought.max_turns || 20, autoMax, crossSessionFloor, staticFloor);
  const system = buildSystem(thought);
  // give the tool-calling loop real conversation history, not just a hint via
  // the system prompt — this is what lets it resolve "it"/"that"/pronouns
  // directly instead of guessing and going searching for something it already knows
  const history = recentMessages.map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text }));
  const messages = [...history, { role: 'user', content: userMessage }];

  const MAX_BLANK_RETRIES = 3; // independent of effectiveMaxSteps — don't silently burn the whole step budget on invisible retries
  let blankRetries = 0;

  for (let step = 0; step < effectiveMaxSteps; step++) {
    const { text, toolCalls, message, usage } = await chatWithTools(messages, { system, tools: toolDefs });
    if (sessionId) recordUsage(sessionId, usage);

    if (!toolCalls.length) {
      if (!text || !text.trim()) {
        blankRetries++;
        onStep?.('blank_retry', { attempt: blankRetries, step });

        if (blankRetries <= MAX_BLANK_RETRIES && step < effectiveMaxSteps - 1) {
          messages.push(message);

          // context-aware nudge: don't push generic "go investigate files"
          // language when the real issue is more likely an un-updated task —
          // that was actively pointing the model in the wrong direction before
          let nudge;
          const pendingCluster = sessionId ? getTasks(sessionId).find((c) => c.status !== 'completed') : null;
          if (pendingCluster) {
            const undone = pendingCluster.tasks.filter((t) => !t.done);
            nudge = `(that came back empty. You have an active task cluster "${pendingCluster.title}" with ${undone.length} task(s) not yet marked done: ${undone.map((t) => t.text).join(', ')}. If you just got a sub-agent report back, call set_task_done for it now. If the work is actually finished, mark the remaining tasks done and give a real summary. Don't stop blank.)`;
          } else {
            nudge = "(that came back empty. Before answering: have you actually read the project's DATA.md for its Location, ls'd that real directory, and read the actual code file? If not, do that now. If you have and something genuinely doesn't fit, use ask to name the specific mismatch you found. Don't stop without either doing more investigation or giving a real specific answer.)";
          }

          messages.push({ role: 'user', content: nudge });
          continue;
        }

        // build a fallback from real task status instead of a generic apology,
        // so even a failed wrap-up tells the user something true and useful
        let fallback = "Ran into something that didn't fit and didn't manage to explain it well — send that again and I'll actually look into what's there and tell you specifically what the issue is.";
        if (sessionId) {
          const clusters = getTasks(sessionId);
          if (clusters.length) {
            const summary = clusters
              .map((c) => {
                const done = c.tasks.filter((t) => t.done).length;
                return `"${c.title}" — ${done}/${c.tasks.length} tasks done`;
              })
              .join('; ');
            fallback = `Couldn't put together a clean final summary, but here's the real status: ${summary}. Check list_subagents or the files directly for specifics — send another message if you want me to keep going or explain further.`;
          }
        }
        onStep?.('done', fallback);
        return fallback;
      }
      onStep?.('done', text);
      return text;
    }

    messages.push(message);

    const askCall = toolCalls.find((c) => c.name === 'ask');
    if (askCall) {
      onStep?.('tool_call', askCall);
      const result = await runTool(askCall.name, askCall.args);
      onStep?.('tool_result', { call: askCall, result });
      const payload = JSON.parse(result);
      onStep?.('done', payload);
      return payload;
    }

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

export { buildSystem };
