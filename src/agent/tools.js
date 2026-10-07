import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { currentSessionId, setProject, searchSessions, readSessionOverview, isSoloOnly, getProject } from './session.js';
import { runSubAgent } from './subagent.js';
import { upsertSubAgent, getSubAgent, loadRegistry } from './subagent-registry.js';
import { recordUsage } from './usage.js';
import { RULES } from './prompts.js';
import { addCluster, setTaskDone, getTasks, editTask, deleteTask, deleteCluster, addTaskToCluster } from './tasks.js';

function resolve(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
export const CATEGORIES = {
  fs: ['read_file','write_file','edit_file','bash'],
  web: ['google_search','fetch'],
  tasks: ['add_task_cluster','get_tasks','set_task_done','edit_task','delete_task','delete_cluster','add_task_to_cluster'],
  memory: ['set_project','search_sessions','read_session'],
  meta: ['list_commands','list_fs_commands','list_web_commands','list_task_commands','list_memory_commands','list_meta_commands','list_subagent_commands','list_mcp_commands','ask'],
  subagent: ['spawn_subagent','list_subagents','message_subagent'],
  mcp: ['mcp_search','mcp_list']
};

function buildUsage(fn) {
  const props = fn.parameters?.properties || {};
  const required = fn.parameters?.required || [];
  const args = Object.keys(props).map(k => required.includes(k)? k : `${k}?`).join(', ');
  return `${fn.name}(${args})`;
}
// OpenAI-style function tool definitions
export const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a text file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path (~ ok)' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file (overwrites; creates parent dirs).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace old_str (must match exactly once) with new_str in a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_str: { type: 'string' },
          new_str: { type: 'string' }
        },
        required: ['path', 'old_str', 'new_str']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      }
    }
  },

  { type: 'function', function: { name: 'list_tools', description: 'Load a tool category and see its usage: fs, web, tasks, memory, meta, subagent, or mcp.', parameters: { type: 'object', properties: { category: { type: 'string', enum: ['fs', 'web', 'tasks', 'memory', 'meta', 'subagent', 'mcp'] } }, required: ['category'] } } },

  {
    type: 'function',
    function: {
      name: 'set_project',
      description: 'Set the current session project. Creates ~/.levi/PROJECTS/<name>/ with DATA.md, PREFERENCE.md, PATTERNS.md; memory writes go there.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Short lowercase name' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_task_cluster',
      description: 'Create a task cluster: a titled, numbered group of concrete subtasks in TASK.md. Use for multi-step work.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short cluster title' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'One string per subtask' }
        },
        required: ['title', 'tasks']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_task_done',
      description: 'Mark a task done or not done by cluster number and 0-based task index. A cluster auto-completes when all its tasks are done.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'number', description: 'Cluster number' },
          taskIndex: { type: 'number', description: '0-based task index' },
          done: { type: 'boolean', description: 'Default true' }
        },
        required: ['cluster', 'taskIndex']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'Read all task clusters in the current session\'s TASK.md, with their status and individual task states.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_task',
      description: 'Change the text of an existing task within a cluster, by cluster number and 0-based task index.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'number' },
          taskIndex: { type: 'number' },
          text: { type: 'string', description: 'New task text' }
        },
        required: ['cluster', 'taskIndex', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Remove a single task from a cluster, by cluster number and 0-based task index.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'number' },
          taskIndex: { type: 'number' }
        },
        required: ['cluster', 'taskIndex']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_cluster',
      description: 'Remove an entire task cluster and all its tasks, by cluster number.',
      parameters: {
        type: 'object',
        properties: { cluster: { type: 'number' } },
        required: ['cluster']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_task_to_cluster',
      description: 'Add a new task to an existing cluster (instead of creating a whole new cluster). Re-opens the cluster if it was already completed.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'number' },
          text: { type: 'string' }
        },
        required: ['cluster', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_sessions',
      description: 'Search other sessions by keyword. Use when the user refers to something from before or another session.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keyword' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_session',
      description: 'Read another session summary or truncated buffer by id. Use after search_sessions.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: 'Session id' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: 'Delegate ONE concrete, self-contained task to a sub-agent (file/bash only; no memory, tasks, or questions). Give exact file(s), change, and what to report. Blocked in solo mode (/alone).',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Short role name, e.g. "bugfixer"' },
          instruction: { type: 'string', description: 'Exact task: file(s), change, what to report' }
        },
        required: ['role', 'instruction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_subagents',
      description: 'List all sub-agents spawned so far this session, with their role, original task, status (done/stuck), and last report.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'message_subagent',
      description: 'Send a follow-up to an existing sub-agent by role instead of spawning a duplicate.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Existing sub-agent role' },
          message: { type: 'string', description: 'The follow-up instruction' }
        },
        required: ['role', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask',
      description: 'Ask the user a question with clickable options (e.g. yes/no). Ends your turn; their pick comes back as the next message.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask' },
          options: { type: 'array', items: { type: 'string' }, description: 'Short option labels, e.g. ["Yes", "No"]' },
          allowCustom: { type: 'boolean', description: 'Also allow a typed answer (default true)' }
        },
        required: ['question', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'google_search',
      description: 'Google search (Serper) for live info, docs, news, examples.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search query' },
          num: { type: 'number', description: 'Result count (default 10)' },
          site: { type: 'string', description: 'Limit to a domain, e.g. github.com' }
        },
        required: ['q']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'serper_search',
      description: 'Search Google via Serper API. Alias for google_search.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          num: { type: 'number', description: 'Number of results (default: 10)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch',
      description: 'Fetch a web page as readable markdown.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          max_length: { type: 'number', description: 'Max chars (default 5000)' },
          start_index: { type: 'number', description: 'Start offset (default 0)' },
          raw: { type: 'boolean', description: 'Raw HTML if true' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save one durable fact to memory. Picks the right file (project or global) and skips duplicates.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['user', 'preference', 'pattern', 'project'], description: 'user=who they are, preference=how they want things, pattern=recurring habit, project=project facts' },
          fact: { type: 'string', description: 'One short fact' }
        },
        required: ['kind', 'fact']
      }
    }
  },
  { type: 'function', function: { name: 'mcp_search', description: 'Search custom MCP tools by keyword and load the matches so you can call them.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Action or tool keyword, e.g. "repos", "pull requests", "issues", "commits"' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'mcp_list', description: 'List configured MCP servers. If server name is provided, lists all tools available on that server.', parameters: { type: 'object', properties: { server: { type: 'string', description: 'Optional MCP server name (e.g. "github", "youtube") to view its full tool catalog' } } } } }
];

export async function runTool(name, args) {
  try {
    if (name === 'read_file') {
      const p = resolve(args.path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return `Error: ${p} is a directory, not a file`;
      return fs.readFileSync(p, 'utf-8');
    }

    if (name === 'write_file') {
      const p = resolve(args.path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return `Error: ${p} is a directory, not a file. Pick a different filename or remove the directory first.`;
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content);
      return `Wrote ${args.content.length} bytes to ${p}`;
    }

    if (name === 'edit_file') {
      const p = resolve(args.path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return `Error: ${p} is a directory, not a file`;
      const content = fs.readFileSync(p, 'utf-8');
      const count = content.split(args.old_str).length - 1;
      if (count === 0) return `Error: old_str not found in ${p}`;
      if (count > 1) return `Error: old_str matches ${count} times in ${p}, must be unique`;
      fs.writeFileSync(p, content.replace(args.old_str, args.new_str));
      return `Edited ${p}`;
    }

if (name === 'mcp_search') {
      const { searchMcp } = await import('../mcp.js');
      return await searchMcp(args?.query);
    }

    if (name === 'mcp_list') {
      const { getMcpServerNames, connectedServers, getServerTools } = await import('../mcp.js');
      const names = getMcpServerNames();
      const connected = connectedServers();
      if (!names.length) return 'No MCP servers configured. Add with /mcp:add <name> <command> [args]';
      if (args?.server) {
        const s = String(args.server).toLowerCase().trim();
        if (!names.includes(s)) return `MCP server "${s}" not found. Configured servers: ${names.join(', ')}`;
        const tools = getServerTools(s);
        if (!tools.length) return `No tools indexed for server "${s}". Run mcp_search("${s}") to connect and discover.`;
        return `Tools on MCP server "${s}" (${tools.length} available):\n` +
          tools.map(t => `- ${t.n}: ${(t.d || '').slice(0, 100)}`).join('\n') +
          '\n\nUse mcp_search("<tool_name>") to load any of these tools into active context.';
      }
      return names.map(n => `${connected.includes(n) ? '🟢' : '⚪'} ${n}`).join('\n') +
        '\n\nTip: call mcp_list(server: "<name>") to see all tools available on a specific server.';
    }

    if (name === 'list_tools') {
      const cat = String(args?.category || '').toLowerCase().replace(/^task$/, 'tasks');
      const alias = { fs: 'list_fs_commands', web: 'list_web_commands', tasks: 'list_task_commands', memory: 'list_memory_commands', meta: 'list_meta_commands', subagent: 'list_subagent_commands', mcp: 'list_mcp_commands' }[cat];
      if (!alias) return 'Error: category must be fs, web, tasks, memory, meta, subagent, or mcp';
      const out = await runTool(alias, {});
      return RULES[cat] && !out.startsWith('[SOLO') ? out + '\n\n' + RULES[cat] : out;
    }

    if (name === 'list_commands' || name === 'list_fs_commands' || name === 'list_web_commands' || name === 'list_task_commands' || name === 'list_memory_commands' || name === 'list_meta_commands' || name === 'list_subagent_commands' || name === 'list_mcp_commands') {

  // category filtering
  let filtered = toolDefs;
  if (name!== 'list_commands') {
    const cat = name.replace('list_','').replace('_commands','').replace(/^task$/, 'tasks'); // fs, web, tasks, memory, meta, subagent
    const names = CATEGORIES[cat] || [];
    if (cat === 'subagent' && isSoloOnly()) {
      return '[SOLO MODE ON - subagent tools hidden, /solo off to enable]';
    }
    filtered = toolDefs.filter(t => names.includes(t.function.name));
  } else {
    // index only - cheap
    return JSON.stringify(getAllCategoriesSummary(), null, 2);
  }

  const tools = filtered.map((t) => {
    const fn=t.function;
    const u = buildUsage(fn);
    return u;
  }).join('\n');

  return `Tools [${name}] now loaded, call them directly:\n${tools}`;
}
    if (name === 'remember') {
      const kind = String(args.kind || '').toLowerCase();
      const fact = String(args.fact || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!fact) return 'Error: fact required';
      if (!['user', 'preference', 'pattern', 'project'].includes(kind)) return 'Error: kind must be user, preference, pattern, or project';
      const sid = currentSessionId();
      const project = sid ? getProject(sid) : null;
      if (kind === 'project' && !project) return 'Error: no project set for this session. Use set_project first, or save as user or preference.';
      const home = path.join(os.homedir(), '.levi');
      const fileName = { user: 'USER.md', preference: 'PREFERENCE.md', pattern: 'PATTERNS.md', project: 'DATA.md' }[kind];
      const dir = kind !== 'user' && project ? path.join(home, 'PROJECTS', project) : path.join(home, 'MEMORY');
      const p = path.join(dir, fileName);
      fs.mkdirSync(dir, { recursive: true });
      const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
      if (existing.length > 8000) return `Error: ${fileName} is large (${existing.length} chars); condense it with edit_file first.`;
      const norm = (s) => s.toLowerCase().replace(/^[-*\s]+/, '').replace(/\|.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
      if (existing.split('\n').some((l) => norm(l) === norm(fact))) return 'Already saved.';
      const line = kind === 'pattern' ? `- ${fact} | status: unconfirmed | confidence: 0.5` : `- ${fact}`;
      fs.appendFileSync(p, (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n');
      return `Saved to ${path.relative(home, p)}: ${fact}`;
    }

    if (name === 'bash') {
      const r = await execa(args.command, { shell: true, reject: false, all: true });
      return r.all || `(exit ${r.exitCode}, no output)`;
    }

    if (name === 'set_project') {
      const projectName = (args.name || '').trim().toLowerCase().replace(/\s+/g, '-');
      if (!projectName) return 'Error: project name required';
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      setProject(id, projectName);
      const root = path.join(os.homedir(), '.levi', 'PROJECTS', projectName);
      fs.mkdirSync(root, { recursive: true });
      const seed = {
        'DATA.md': '# DATA\n',
        'PREFERENCE.md': '# PREFERENCES\n',
        'PATTERNS.md': 'summary:\nNo strong patterns yet.\n\n\n'
      };
      for (const [f, content] of Object.entries(seed)) {
        const p = path.join(root, f);
        if (!fs.existsSync(p)) fs.writeFileSync(p, content);
      }
      return `Project set to "${projectName}". Future memory facts go to ~/.levi/PROJECTS/${projectName}/`;
    }

    if (name === 'add_task_cluster') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      if (!args.title || !Array.isArray(args.tasks) || !args.tasks.length) return 'Error: title and non-empty tasks array required';
      const num = addCluster(id, args.title, args.tasks);
      return `Created cluster ${num} — "${args.title}" with ${args.tasks.length} task(s)`;
    }

    if (name === 'set_task_done') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const done = args.done === undefined ? true : !!args.done;
      const ok = setTaskDone(id, args.cluster, args.taskIndex, done);
      if (!ok) return `Error: cluster ${args.cluster} or task index ${args.taskIndex} not found`;
      return `Task ${args.taskIndex} in cluster ${args.cluster} marked ${done ? 'done' : 'not done'}`;
    }

    if (name === 'get_tasks') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const clusters = getTasks(id);
      if (!clusters.length) return '(no task clusters yet)';
      return JSON.stringify(clusters, null, 2);
    }

    if (name === 'edit_task') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const ok = editTask(id, args.cluster, args.taskIndex, args.text);
      if (!ok) return `Error: cluster ${args.cluster} or task index ${args.taskIndex} not found`;
      return `Task ${args.taskIndex} in cluster ${args.cluster} updated`;
    }

    if (name === 'delete_task') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const ok = deleteTask(id, args.cluster, args.taskIndex);
      if (!ok) return `Error: cluster ${args.cluster} or task index ${args.taskIndex} not found`;
      return `Task ${args.taskIndex} removed from cluster ${args.cluster}`;
    }

    if (name === 'delete_cluster') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const ok = deleteCluster(id, args.cluster);
      if (!ok) return `Error: cluster ${args.cluster} not found`;
      return `Cluster ${args.cluster} deleted`;
    }

    if (name === 'add_task_to_cluster') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const ok = addTaskToCluster(id, args.cluster, args.text);
      if (!ok) return `Error: cluster ${args.cluster} not found`;
      return `Task added to cluster ${args.cluster}`;
    }

    if (name === 'search_sessions') {
      const currentId = currentSessionId();
      const results = searchSessions(args.query, { excludeId: currentId });
      if (!results.length) return 'No matching sessions found.';
      return JSON.stringify(results, null, 2);
    }

    if (name === 'read_session') {
      const overview = readSessionOverview(args.id);
      if (!overview) return `Error: session ${args.id} not found`;
      return JSON.stringify(overview, null, 2);
    }

    if (name === 'spawn_subagent') {
      if (isSoloOnly()) return 'Error: solo mode is on (/alone) — sub-agents are disabled. Do this work yourself.';

      const role = (args.role || 'subagent').trim();
      const id = currentSessionId();

      if (id && getSubAgent(id, role)) {
        return `Error: a sub-agent named "${role}" already exists this session. Use message_subagent to follow up with it instead of spawning a duplicate.`;
      }

      const { report, messages, usage } = await runSubAgent(role, args.instruction);

      if (id) {
        recordUsage(id, usage);
        upsertSubAgent(id, { role, task: args.instruction, report, messages });
        const reportPath = path.join(os.homedir(), '.levi', 'ACTIVE-BUFFER', `SESSION-${id}`, 'REPORT.MD');
        try {
          fs.appendFileSync(reportPath, `@${role}: ${report}\n\n`);
        } catch {}
      }

      return report;
    }

    if (name === 'list_subagents') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const registry = loadRegistry(id);
      if (!registry.length) return '(no sub-agents spawned yet this session)';
      return registry
        .map((s) => `@${s.role} [${s.status}] — task: ${s.task}\nlast report: ${s.report}`)
        .join('\n\n');
    }

    if (name === 'message_subagent') {
      if (isSoloOnly()) return 'Error: solo mode is on (/alone) — sub-agents are disabled.';
      const id = currentSessionId();
      if (!id) return 'Error: no active session';

      const existing = getSubAgent(id, args.role);
      if (!existing) return `Error: no sub-agent named "${args.role}" found this session. Use spawn_subagent to create one first.`;

      const { report, messages, usage } = await runSubAgent(args.role, args.message, { existingMessages: existing.messages });
      recordUsage(id, usage);
      upsertSubAgent(id, { role: args.role, task: existing.task, report, messages });

      const reportPath = path.join(os.homedir(), '.levi', 'ACTIVE-BUFFER', `SESSION-${id}`, 'REPORT.MD');
      try {
        fs.appendFileSync(reportPath, `@${args.role} (follow-up): ${report}\n\n`);
      } catch {}

      return report;
    }

    if (name === 'ask') {
      // no filesystem side effect — this is a structured marker the UI layer
      // renders specially; runAgent detects it and surfaces it via onStep
      return JSON.stringify({
        __ask: true,
        question: args.question,
        options: Array.isArray(args.options) ? args.options : [],
        allowCustom: args.allowCustom !== false
      });
    }

    if (name === 'google_search' || name === 'serper_search' || name === 'brave_web_search') {
      const { runMcpTool, getSearchApiKey } = await import('../mcp.js');
      const apiKey = getSearchApiKey();
      if (!apiKey) {
        return 'Error: Serper API key is not configured. Set it using the slash command: /search:api <your-api-key>';
      }
      return await runMcpTool(name, args);
    }

    if (name === 'fetch') {
      const { runMcpTool } = await import('../mcp.js');
      return await runMcpTool(name, args);
    }

    const { isMcpTool, runMcpTool } = await import('../mcp.js');
    if (isMcpTool(name)) {
      return await runMcpTool(name, args);
    }

    return `Error: unknown tool ${name}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

export function getToolsByCategory(cat) {
  const names = CATEGORIES[cat] || [];
  if (isSoloOnly() && cat === 'subagent') return [];
  return toolDefs.filter(t => {
    const name = t.function.name;
    if (name.startsWith('/')) return false; // <-- exclude user commands
    return names.includes(name);
  }).map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    usage: buildUsage(t.function)
  }));
}

// new — for list_commands
export function getUserCommands() {
  return toolDefs.filter(t => t.function.name.startsWith('/')).map(t => ({
    name: t.function.name,
    description: t.function.description,
    usage: buildUsage(t.function)
  }));
}

export function getAllCategoriesSummary() {
  const solo = isSoloOnly();
  return {
    solo_mode: solo? "ON" : "OFF",
    usage: "Run list_<category>_commands to see tools with params, /commands for user commands",
    categories: {
      fs: "use list_fs_commands -> 4 tools",
      web: "use list_web_commands -> 2 tools",
      tasks: "use list_task_commands -> 7 tools",
      memory: "use list_memory_commands -> 3 tools",
      meta: "use list_meta_commands -> 9 tools",
      subagent: solo? "HIDDEN (solo ON) - /solo off to enable" : "use list_subagent_commands -> 3 tools",
      mcp: "use list_mcp_commands -> 2 tools (mcp_search, mcp_list)",
      user: "use list_commands -> slash commands"
    }
  };
}
