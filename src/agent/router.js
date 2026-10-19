import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chat } from './client.js';
import { recordUsage } from './usage.js';
import { getEffort } from './effort.js';

// Generate a compact directory tree preview (max ~50 tokens) to skip find/list_dir calls
function dirPreview(dirPath) {
  try {
    const resolved = dirPath.startsWith('~') ? path.join(os.homedir(), dirPath.slice(1)) : path.resolve(dirPath);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
    const IGNORE = new Set(['.git', 'node_modules', '.cache', '.npm', '.next', 'dist', 'build', '.levi']);
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
      .slice(0, 20);
    if (!entries.length) return `[${path.basename(resolved)}/ is empty]`;
    const items = entries.map(e => {
      if (e.isDirectory()) return `${e.name}/`;
      try {
        const s = fs.statSync(path.join(resolved, e.name)).size;
        const sz = s < 1024 ? `${s} B` : s < 1048576 ? `${(s/1024).toFixed(1)} KB` : `${(s/1048576).toFixed(1)} MB`;
        return `${e.name} (${sz})`;
      } catch { return e.name; }
    });
    return `[${path.basename(resolved)}/ contains: ${items.join(', ')}]`;
  } catch { return null; }
}
function getMcpNames() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.levi', 'mcp.json'), 'utf-8'));
    return Object.entries(c.mcpServers || {}).filter(([, v]) => !v.disabled && !v._disabled).map(([k]) => k);
  } catch { return []; }
}

// The system prompt is rebuilt only when MCP server list changes (rare).
// Per-turn data goes in the user message only (cacheable prefix).
let cachedNames = null;
let cachedSystem = null;

function routerSystem() {
  const names = getMcpNames();
  const key = names.join(',');
  if (cachedSystem && cachedNames === key) return cachedSystem;
  cachedNames = key;

  const mcpLine = names.length
    ? `mcp: the name of the MCP server if the request needs one, or false. Available MCP servers: ${names.join(', ')}. Examples: github = repos/PRs/issues/code search, cua-driver = desktop automation (mouse, keyboard, window, apps), serper = web search, fetch = read a URL, youtube = video info, playwright = browser automation. Return the server name string when the user wants to use one, false otherwise.`
    : `mcp: always false (no MCP servers configured).`;

  cachedSystem = `Route a message for a coding assistant. Output ONLY JSON: {"route":"conversation"|"light"|"agent","tools":"none"|"memory"|"web"|"desktop"|"shell"|"tasks"|"all","mcp":"<server>"|false,"insight":"max 12 words"}
agent = a project or big job: building or scaffolding an app, big fixes or refactors across 3+ files, complex reasoning or debugging, git workflows, deep multi-source research, planning or reorganizing task plans, sub-agents, or continues agent work (e.g. "yes", "the second one" when last_route is agent).
light = any other job that needs tools, up to about 10 tool calls: code reviews, small fixes and edits (1-2 files), running commands, web lookups, saving facts, recalling past sessions, notes, or conversations, task cluster views, using MCP tools. Mixed jobs: tools = all.
conversation = plain casual chat, simple questions/explanations without tools, short follow-ups.
tools (conversation or light): none = plain chat or thanks, memory = ONLY for passive queries about past facts/sessions ("what did we talk about", "remember this"), web = live info/browser, desktop = mouse/keyboard/window/app control, shell = one file or shell action, tasks = show or tick off task clusters, all = continuation, completion, building, unsure or mixed.
${mcpLine}
When unsure between light and agent, choose light unless a project, big refactor, or complex reasoning is involved.
Recalling past sessions, notes, or past conversations passively must route light with tools=memory.
CRITICAL: Continuing, finishing, completing, or building work (e.g. "continue", "finish it", "complete my request", "do it") must ALWAYS route with tools=all or tools=shell, NEVER tools=memory.
we are in testing period so never router to agent mode for now.`;
  return cachedSystem;
}

const GREETING = /^(hi+|hey+|yo|hello|sup|thanks|thank you|thx|ty|cool|nice|lol|gm|gn|bye)[\s!.?]*$/i;
const FILE_HINT = /```/; // only multi-line code skips the router call

const TASK_VIEW = /^(show|list|check|see|get|what)\b.*\b(my|the|current) (task clusters?|tasks)\b/i;
let lastRoute = 'conversation';

export function resetRouter() {
  lastRoute = 'conversation';
  cachedSystem = null;
  cachedNames = null;
}

function parseMcp(val) {
  if (!val || val === false || val === 'false' || val === 'none') return false;
  if (typeof val === 'string') return val;
  if (val === true) return true;
  return false;
}

async function classify(query, recent, sessionId, signal) {
  const prompt = `last_route: ${lastRoute}
recent user messages:
${recent.length ? recent.map((m) => `- ${m}`).join('\n') : '(none)'}
current: ${query.slice(0, 600)}`;
  try {
    const res = await chat([{ role: 'user', content: prompt }], { system: routerSystem(), signal });
    if (sessionId) recordUsage(sessionId, res.usage);
    const data = JSON.parse(res.text.trim().replace(/^```json\s*|```\s*$/g, ''));
    const mcpServer = parseMcp(data.mcp);
    let route = ['conversation', 'light'].includes(data.route) ? data.route : 'agent';
    let tools = ['none', 'memory', 'web', 'desktop', 'shell', 'tasks', 'all'].includes(data.tools) ? data.tools : 'all';
    if (mcpServer) {
      if (route === 'conversation') route = 'light';
      if (tools === 'none') tools = 'all';
    }
    return {
      route,
      tools,
      mcp: mcpServer,
      insight: String(data.insight || '').slice(0, 120)
    };
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError' || e.message === 'Interrupted') throw e;
    return { route: 'light', tools: 'all', mcp: false, insight: 'router failed, using light: ' + String((e && e.message) || e).slice(0, 80) };
  }
}

// recentUser = last user messages only (no AI replies), excluding the current one
export async function route(query, { recentUser = [], forceAgent = false, sessionId, signal } = {}) {
  const q = query.trim();
  const recent = recentUser.slice(-2).map((m) => String(m).slice(0, 150));

  let r;
  if (forceAgent) r = { route: 'agent', insight: 'agent mode forced' };
  else if (GREETING.test(q)) r = { route: 'conversation', tools: 'none', mcp: false, insight: 'greeting or thanks' };
  else if (/^(continue|keep going|finish(\s+\w+)?|complete(\s+\w+)?|com0lete(\s+\w+)?|proceed|go ahead|do it|next)\b/i.test(q)) r = { route: 'light', tools: 'all', mcp: false, insight: 'fast-path: continue/complete request' };
  else if (/^git\s+(status|diff|log|branch|checkout|add|commit|pull|push|stash)\b/i.test(q)) r = { route: 'light', tools: 'shell', mcp: false, insight: 'fast-path: git command' };
  else if (/^(ls|pwd|cat|cd|mkdir|touch|grep|find|rm|mv|cp|which|where|head|tail|sed|awk|echo|curl)\b/i.test(q)) r = { route: 'light', tools: 'shell', mcp: false, insight: 'fast-path: shell utility' };
  else if (/^(read|view|show|check|cat|inspect|open)\s+([a-zA-Z0-9_\-./~]+\.[a-zA-Z0-9]+)$/i.test(q)) r = { route: 'light', tools: 'shell', mcp: false, insight: 'fast-path: read single file' };
  else if (/^(go to|open|check|show|cd|look at|work on)\s+([~/a-zA-Z0-9_\-. ]+)$/i.test(q)) {
    const m = q.match(/^(?:go to|open|check|show|cd|look at|work on)\s+(.+)$/i);
    const target = m ? m[1].trim() : q;
    const preview = dirPreview(target);
    if (preview) r = { route: 'light', tools: 'shell', mcp: false, insight: 'fast-path: directory entry — ' + preview };
  }
  else if (/^(search|google|lookup)\s+(about|for|how|what|why|who)\b/i.test(q)) r = { route: 'light', tools: 'web', mcp: false, insight: 'fast-path: web lookup' };
  else if (FILE_HINT.test(q)) r = { route: 'agent', insight: 'mentions code or file paths' };
  else if (/^(remember|note that|from now on|btw|fyi)\b|\bi (always|never|usually|prefer|like|love|hate|enjoy|use|play|work (as|at|on)|live in) |\bmy (name is|favou?rite|setup is)/i.test(q)) r = { route: 'conversation', tools: 'memory', mcp: false, insight: 'durable fact or preference: save with remember' };
  else if (TASK_VIEW.test(q)) r = { route: 'light', tools: 'tasks', mcp: false, insight: 'show or update task clusters' };
  else r = await classify(q, recent, sessionId, signal);

  const effort = getEffort();
  if (effort.id === 'eternal' && r.route === 'agent') {
    // Eternal (low) uses light mode with low effort or conversational mode
    r.route = 'light';
    r.insight = (r.insight ? r.insight + ' · ' : '') + 'eternal: light mode';
  }

  // Auto-attach directory preview when query mentions a recognizable path
  if (!r.insight?.includes('directory entry') && !r.insight?.includes('fast-path')) {
    const pathMatch = q.match(/(?:^|\s)(~\/[\w\-./]+|\.\/[\w\-./]+|\/[\w\-./]+)/i);
    if (pathMatch) {
      const preview = dirPreview(pathMatch[1]);
      if (preview) r.insight = (r.insight || '') + ' · ' + preview;
    }
  }

  lastRoute = r.route;
  return { route: r.route, tools: r.tools || 'all', mcp: r.mcp || false, query: q, recentMessages: recent, insight: r.insight };
}
