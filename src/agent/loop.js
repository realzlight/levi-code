import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatWithTools } from './client.js';
import { toolDefs, runTool, CATEGORIES } from './tools.js';
import { think, readProjectContext, thinkToolDef } from './thought.js';
import { currentSessionId, getProject, loadMessages, isSoloOnly } from './session.js';
import { getTasks } from './tasks.js';
import { startTurn, recordUsage } from './usage.js';
import { route } from './router.js';
import { readMemoryDigest } from './memory.js';
import { CONVO_PROMPT, LIGHT_PROMPT, agentPrompt, buildContext, litePrompt } from './prompts.js';

const LIST_COMMANDS = ['list_commands','list_fs_commands','list_web_commands','list_task_commands','list_memory_commands','list_meta_commands','list_subagent_commands'];
const TRIVIAL = new Set(['bash','read_file','write_file','edit_file','find','list_dir','read_lines','grep_search',...LIST_COMMANDS]);


const BASE_TOOLS = [...toolDefs.filter((t) => TRIVIAL.has(t.function.name) || ['ask', 'remember', 'list_tools', 'set_project'].includes(t.function.name)), thinkToolDef(toolDefs[0])];

function currentUserName() {
  try {
    const configPath = path.join(os.homedir(), '.levi', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config?.auth?.user?.name || null;
  } catch {
    return null;
  }
}

function buildSystem() {
  return agentPrompt(isSoloOnly());
}

const PLAYWRIGHT_WEB_TOOLS = [
  'web_launch', 'web_close', 'web_new_tab',
  'web_goto', 'web_back', 'web_reload',
  'web_click', 'web_dblclick', 'web_fill', 'web_press', 'web_hover', 'web_drag', 'web_scroll',
  'web_screenshot', 'web_get_text', 'web_get_url', 'web_wait'
];

// messages = [{ role: 'user'|'assistant', content: string }]
// onStep(kind, data) — optional progress callback: 'tool_call' | 'tool_result' | 'done' | 'thought'
const LITE_NAMES = ['bash', 'read_file', 'write_file', 'edit_file', 'find', 'list_dir', 'read_lines', 'grep_search', 'google_search', 'fetch', ...PLAYWRIGHT_WEB_TOOLS, 'ask', 'remember', 'get_tasks', 'set_task_done', 'add_task_cluster', 'mcp_search', 'mcp_list'];
const LITE_TOOLS = toolDefs.filter((t) => LITE_NAMES.includes(t.function.name));
const LITE_GROUPS = {
  none: [],
  memory: ['remember'],
  web: ['google_search', 'fetch', ...PLAYWRIGHT_WEB_TOOLS],
  shell: ['bash', 'read_file', 'write_file', 'edit_file', 'find', 'list_dir', 'read_lines', 'grep_search', 'ask'],
  all: ['bash', 'read_file', 'write_file', 'edit_file', 'find', 'list_dir', 'read_lines', 'grep_search', 'google_search', 'fetch', ...PLAYWRIGHT_WEB_TOOLS, 'ask', 'remember'],
  tasks: ['get_tasks', 'set_task_done', 'add_task_cluster'],
  mcp: ['mcp_search', 'mcp_list', 'bash', 'read_file', 'write_file', 'edit_file', 'find', 'list_dir', 'read_lines', 'grep_search', 'ask']
};
const MORE_TOOL = { type: 'function', function: { name: 'more_tools', description: 'Load all light tools (shell, files, web, ask, remember) when your current tools are not enough.', parameters: { type: 'object', properties: {} } } };
const WEB_NAMES = ['google_search', 'fetch'];
const WEB_BUDGET = 3;
const RESULT_CAP = 1500;
const LITE_TOKEN_BUDGET = 30000;
const AGENT_WEB_BUDGET = 6;
const AGENT_WEB_CAP = 3000;
const AGENT_OUTPUT_CAP = 8000;
const OUTPUT_TOOLS = ['read_file', 'bash', 'find', 'list_dir', 'read_lines', 'grep_search', 'web_get_text', 'web_screenshot', 'web_get_url'];
async function runToolGuarded(call, state) {
  if (state.over) return 'Error: token budget for this message is used up. Answer now with what you have and say what you would check next.';
  if (!WEB_NAMES.includes(call.name)) {
    const out = await runTool(call.name, call.args);
    const s = typeof out === 'string' ? out : String(out);
    if ((OUTPUT_TOOLS.includes(call.name) || !toolDefs.some((t) => t.function.name === call.name)) && s.length > AGENT_OUTPUT_CAP) return s.slice(0, AGENT_OUTPUT_CAP) + '\n...[truncated ' + (s.length - AGENT_OUTPUT_CAP) + ' chars shortened to save tokens; the file is intact. use grep -n, sed -n or wc to read other parts]';
    return out;
  }
  if (state.web >= AGENT_WEB_BUDGET) return 'Error: web budget used up for this message. Answer with what you have and say plainly what you could not confirm.';
  state.web++;
  const r = String(await runTool(call.name, call.args));
  return r.length > AGENT_WEB_CAP ? r.slice(0, AGENT_WEB_CAP) + '\n...[truncated]' : r;
}


// shared by chat (conversation) and light modes: small prompt, small tool set, no agent prompt
async function runLite(routed, sessionId, onStep, system) {
  const mcpNames = routed.mcp ? getMcpNames() : undefined;
  if (routed.mcp) {
    if (!mcpMod) mcpMod = await import('../mcp.js');
    mcpMod.resetLoadedMcp();
    const query = typeof routed.mcp === 'string' ? `${routed.mcp} ${routed.query}` : routed.query;
    await mcpMod.searchMcp(query);
  }
  const preloaded = mcpMod ? mcpMod.getLoadedMcpDefs() : [];
  const preloadedNames = preloaded.map((t) => t.function.name);
  let mcpHint = undefined;
  if (preloadedNames.length) {
    mcpHint = `MCP server "${routed.mcp}" active. Relevant tools already loaded: ${preloadedNames.join(', ')}. Call them directly, or call mcp_search("<action>") if you need different tools.`;
  } else if (typeof routed.mcp === 'string') {
    mcpHint = `Use MCP server "${routed.mcp}" — call mcp_search("<action>") to load tools.`;
  }
  const context = buildContext({ userName: currentUserName(), insight: routed.insight, hint: mcpHint, recent: routed.recentMessages, exchange: routed.exchange, memory: readMemoryDigest({ prefsOnly: true }), mcpServers: mcpNames });
  const messages = [{ role: 'user', content: context + routed.query }];
  let webCalls = 0;
  let budgetNoted = false;
  let liteTokens = 0;
  let expanded = (routed.tools || 'all') === 'all';
  const mcpToolNames = routed.mcp ? ['mcp_search', 'mcp_list'] : [];
  const pickLite = () => {
    let names = expanded ? LITE_GROUPS.all : (LITE_GROUPS[routed.tools] || LITE_GROUPS.all);
    if (routed.mcp && !expanded) names = [...new Set([...names, ...mcpToolNames])];
    let tools = LITE_TOOLS.filter((t) => names.includes(t.function.name));
    if (mcpMod) tools = [...tools, ...mcpMod.getLoadedMcpDefs()];
    if (!expanded) tools = [...tools, MORE_TOOL];
    return webCalls >= WEB_BUDGET ? tools.filter((t) => !WEB_NAMES.includes(t.function.name)) : tools;
  };
  for (let step = 0; step < 12; step++) {
    if (liteTokens > LITE_TOKEN_BUDGET) return 'Stopped: light-mode token budget (' + LITE_TOKEN_BUDGET + ') reached for this message. Send another message to continue from here.';
    const liteResults = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
    for (const i of liteResults.slice(0, -4)) {
      if (String(messages[i].content).length > 300) messages[i] = { ...messages[i], content: String(messages[i].content).slice(0, 300) + '\n...[older result trimmed]' };
    }
    if (webCalls >= WEB_BUDGET && !budgetNoted) {
        messages.push({ role: 'user', content: '(web budget used up. answer now with what you found and say plainly what you could not confirm. do not guess.)' });
        budgetNoted = true;
    }
    let text = '', toolCalls = [], message = {}, usage = {};
      try {
        const res = await chatWithTools(messages, { system: litePrompt(system, expanded ? 'all' : routed.tools), tools: pickLite() });
        text = res.text;
        toolCalls = res.toolCalls;
        message = res.message;
        usage = res.usage;
      } catch (err) {
        return `API error: ${err.message}. Please try again.`;
      }
    liteTokens += (usage && usage.inputTokens) || 0;
    if (sessionId) recordUsage(sessionId, usage);
    if (!toolCalls.length) {
      const out = (text || '').trim();
      return !out || out.includes('[[AGENT]]') ? null : out;
    }
    messages.push(message);
    const askCall = toolCalls.find((c) => c.name === 'ask');
    if (askCall) {
      onStep?.('tool_call', askCall);
      const result = await runTool(askCall.name, askCall.args);
      onStep?.('tool_result', { call: askCall, result });
      return JSON.parse(result);
    }
    for (const call of toolCalls) {
      onStep?.('tool_call', call);
      const ok = LITE_NAMES.includes(call.name) || (mcpMod && mcpMod.isMcpTool(call.name));
      let result = call.name === 'more_tools' ? (expanded = true, 'All light tools are now available.') : ok ? await runTool(call.name, call.args) : 'Error: tool not available here';
      if (WEB_NAMES.includes(call.name)) webCalls++;
      result = String(result);
      const cap = ['read_file', 'bash'].includes(call.name) ? 6000 : RESULT_CAP;
      if (result.length > cap) result = result.slice(0, cap) + '\n...[output shortened to save tokens; the file is intact. use grep -n or sed -n to read other parts]';
      onStep?.('tool_result', { call, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }
  return null;
}

function buildExchange(stored) {
  const idx = stored.map((m, i) => ({ m, i })).filter((x) => x.m && x.m.text && x.m.text !== '...');
  const us = idx.filter((x) => x.m.role === 'user').slice(-3);
  const as = idx.filter((x) => x.m.role === 'agent').slice(-3);
  return [...us, ...as]
    .sort((p, q) => p.i - q.i)
    .map((x) => ({ role: x.m.role, text: String(x.m.text).slice(0, x === as[as.length - 1] ? 900 : 350) }));
}

let mcpMod = null;
function hasCustomMcp() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.levi', 'mcp.json'), 'utf-8'));
    return Object.entries(c.mcpServers || {}).some(([k, v]) => !v.disabled && !['serper', 'fetch', 'playwright'].includes(k));
  } catch {
    return false;
  }
}

function getMcpNames() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.levi', 'mcp.json'), 'utf-8'));
    return Object.entries(c.mcpServers || {}).filter(([, v]) => !v.disabled && !v._disabled).map(([k]) => k);
  } catch { return []; }
}

export async function runAgent(userMessage, { onStep, maxSteps, forceAgent } = {}) {
  const sessionId = currentSessionId();
  if (sessionId) startTurn(sessionId);
  const projectName = sessionId ? getProject(sessionId) : null;
  const stored = sessionId ? loadMessages(sessionId) : [];

  // router is mandatory: every message goes through it first
  const routed = await route(userMessage, {
    recentUser: stored.filter((m) => m.role === 'user').map((m) => m.text),
    forceAgent,
    sessionId
  });
  onStep?.('route', routed);
  try { fs.appendFileSync(path.join(os.homedir(), '.levi', 'ROUTE.log'), JSON.stringify({ t: new Date().toISOString(), route: routed.route, tools: routed.tools, insight: routed.insight, q: String(userMessage).slice(0, 50) }) + '\n'); } catch {}
  const exchange = buildExchange(stored);
  routed.exchange = exchange;

  // conversation mode: tiny prompt, no tools, no thought step
  if (routed.route === 'light') {
    const reply = await runLite(routed, sessionId, onStep, 'light');
    if (reply) {
      onStep?.('done', reply);
      return reply;
    }
    routed.insight = 'escalated from light mode';
  }

  if (routed.route === 'conversation') {
    const reply = await runLite(routed, sessionId, onStep, 'convo');
    if (reply) {
      onStep?.('done', reply);
      return reply;
    }
    routed.insight = 'escalated from conversation mode';
  }

  // agent mode: existing flow
  const recentMessages = stored.slice(-6);
  const project = readProjectContext(projectName, sessionId);
  let pendingTasks = 0;
  if (sessionId) {
    pendingTasks = getTasks(sessionId).reduce((n, c) => n + (c.status === 'completed' ? 0 : c.tasks.filter((t) => !t.done).length), 0);
  }
  // a cap, not spend: agent mode is real work, so keep a high ceiling
  const effectiveMaxSteps = maxSteps || Math.max(pendingTasks * 4 + 10, 30);
  let tokenBudget = 50000 + pendingTasks * 10000;
  const system = buildSystem();
  const SUB = ['spawn_subagent', 'list_subagents', 'message_subagent'];
  const unlocked = new Set(routed.tools === 'web' || routed.tools === 'all' ? CATEGORIES.web : []);
  const customMcp = hasCustomMcp();
  if (customMcp && !mcpMod) mcpMod = await import('../mcp.js');
  if (mcpMod) {
    mcpMod.resetLoadedMcp();
    if (routed.mcp) {
      const mcpQuery = typeof routed.mcp === 'string' ? `${routed.mcp} ${userMessage}` : userMessage;
      await mcpMod.searchMcp(mcpQuery);
    }
  }
  const pickTools = () => {
    const all = [...BASE_TOOLS, ...toolDefs.filter((t) => unlocked.has(t.function.name) && !BASE_TOOLS.includes(t)), ...(customMcp ? toolDefs.filter((t) => t.function.name === 'mcp_search' || t.function.name === 'mcp_list') : []), ...(mcpMod ? mcpMod.getLoadedMcpDefs() : [])];
    return isSoloOnly() ? all.filter((t) => !SUB.includes(t.function?.name || t.name)) : all;
  };
  // give the tool-calling loop real conversation history, not just a hint via
  // the system prompt — this is what lets it resolve "it"/"that"/pronouns
  // directly instead of guessing and going searching for something it already knows
  const history = [];
  for (const m of exchange) {
    const role = m.role === 'agent' ? 'assistant' : 'user';
    const prev = history[history.length - 1];
    if (prev && prev.role === role) prev.content += '\n\n' + m.text;
    else history.push({ role, content: m.text });
  }
  while (history.length && history[0].role === 'assistant') history.shift();
  const mcpNames = customMcp ? getMcpNames() : undefined;
  const preloaded = mcpMod ? mcpMod.getLoadedMcpDefs() : [];
  const preloadedNames = preloaded.map((t) => t.function.name);
  let mcpHint = undefined;
  if (preloadedNames.length) {
    mcpHint = `MCP server "${routed.mcp}" active. Relevant tools already loaded: ${preloadedNames.join(', ')}. Call them directly, or call mcp_search("<action>") if you need different tools.`;
  } else if (typeof routed.mcp === 'string') {
    mcpHint = `Use MCP server "${routed.mcp}" — call mcp_search("<action>") to load tools.`;
  }
  const context = buildContext({ userName: currentUserName(), insight: routed.insight, dataContent: project.dataContent, taskSummary: project.taskSummary, hint: mcpHint, memory: readMemoryDigest(), mcpServers: mcpNames });
  const messages = [...history];
  const cur = context + userMessage;
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1] = { role: 'user', content: messages[messages.length - 1].content + '\n\n' + cur };
  else messages.push({ role: 'user', content: cur });

  const MAX_BLANK_RETRIES = 3; // independent of effectiveMaxSteps — don't silently burn the whole step budget on invisible retries
  let blankRetries = 0;
  let stallNudges = 0;
  const webState = { web: 0, tokens: 0, over: false, noted: false, overSteps: 0 };

  for (let step = 0; step < effectiveMaxSteps; step++) {
    if (sessionId) {
      try {
        const pendingNow = getTasks(sessionId).reduce((a, c) => a + (c.status === 'completed' ? 0 : c.tasks.filter((t) => !t.done).length), 0);
        tokenBudget = Math.max(tokenBudget, 50000 + pendingNow * 10000);
      } catch {}
    }
    webState.over = webState.tokens >= tokenBudget;
    if (webState.over) {
      webState.overSteps++;
      if (webState.overSteps > 4) return 'Stopped: token budget (' + tokenBudget + ') reached for this message. Send another message to continue from here.';
      if (!webState.noted) {
        messages.push({ role: 'user', content: '(token budget for this message is used up. answer now with what you found and say what you would check next. do not call more tools.)' });
        webState.noted = true;
      }
    }
    const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
    for (const i of toolIdx.slice(0, -5)) {
      if (String(messages[i].content).length > 300) messages[i] = { ...messages[i], content: String(messages[i].content).slice(0, 300) + '\n...[older result trimmed]' };
    }
    let text = '', toolCalls = [], message = {}, usage = {};
    try {
      const res = await chatWithTools(messages, { system, tools: pickTools() });
      text = res.text;
      toolCalls = res.toolCalls;
      message = res.message;
      usage = res.usage;
    } catch (err) {
      onStep?.('error', err);
      const errMsg = `API error: ${err.message}. Please try again.`;
      onStep?.('done', errMsg);
      return errMsg;
    }
    webState.tokens += (usage && usage.inputTokens) || 0;
    if (webState.tokens >= tokenBudget) webState.over = true;
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
      if (stallNudges < 2 && step < effectiveMaxSteps - 1 && !messages.some((m) => m.role === 'tool') && !text.trim().slice(-160).includes('?') && /\b(i'll|i will|let me|going to|gonna|about to|setting (it )?up)\b/i.test(text)) {
        stallNudges++;
        onStep?.('stall_nudge', { attempt: stallNudges, step });
        messages.push(message);
        messages.push({ role: 'user', content: '(you announced a plan but made no tool call. the instruction was clear, so do it now with your tools. only ask if there is a real fork.)' });
        continue;
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
      const result = call.name === 'think'
        ? await think(call.args, { projectName, sessionId })
        : await runToolGuarded(call, webState);
      const lc = call.name === 'list_tools' ? [null, String(call.args?.category || '').toLowerCase()] : call.name.match(/^list_(\w+)_commands$/);
      if (lc) for (const n of CATEGORIES[lc[1] === 'task' ? 'tasks' : lc[1]] || []) unlocked.add(n);
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
