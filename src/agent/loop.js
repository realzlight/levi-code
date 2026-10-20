import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatWithTools } from './client.js';
import { toolDefs, runTool, CATEGORIES } from './tools.js';
import { think, readProjectContext, thinkToolDef } from './thought.js';
import { currentSessionId, getProject, loadMessages, isSoloOnly, isDiaryEnabled } from './session.js';
import { getTasks } from './tasks.js';
import { startTurn, recordUsage } from './usage.js';
import { route } from './router.js';
import { readMemoryDigest } from './memory.js';
import { CONVO_PROMPT, LIGHT_PROMPT, agentPrompt, buildContext, litePrompt, loopPrompt } from './prompts.js';
import { getEffort } from './effort.js';

// Strip ANSI escape codes, carriage returns, progress bars, and collapse whitespace from CLI output
function cleanCliOutput(raw) {
  if (typeof raw !== 'string' || raw.length < 80) return raw;
  return raw
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')   // ANSI escape sequences
    .replace(/\x1B\][^\x07]*\x07/g, '')       // OSC sequences
    .replace(/\r+/g, '')                       // carriage returns
    .replace(/^.*\[([=#>]+ *| *[=#>]+)\].*$/gm, '')  // progress bars like [=====>  ]
    .replace(/\n{3,}/g, '\n\n')                // collapse 3+ newlines to 2
    .trim();
}

// After a write_file/edit_file, collapse any earlier read_file result for the same path
// to a short summary. Saves 2,000–5,000 tokens on multi-step turns.
function compactSupersededReads(messages, writtenPath) {
  if (!writtenPath) return;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // Find assistant messages with tool_calls that read this path
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const fn = tc.function?.name || tc.name;
        if (fn === 'read_file') {
          const p = tc.function?.arguments ? JSON.parse(tc.function.arguments || '{}').path : tc.args?.path;
          if (p && (p === writtenPath || p.endsWith('/' + writtenPath.split('/').pop()))) {
            // Find the matching tool result message and compact it
            const toolId = tc.id;
            for (let j = i + 1; j < messages.length; j++) {
              if (messages[j].role === 'tool' && messages[j].tool_call_id === toolId) {
                const content = String(messages[j].content);
                if (content.length > 200) {
                  const lines = content.split('\n').length;
                  messages[j] = { ...messages[j], content: `[read ${writtenPath} (${lines} lines) — now superseded by edit, content omitted to save tokens]` };
                }
                break;
              }
            }
          }
        }
      }
    }
  }
}

// Minimal tool set for pure coding steps (step > 0 in coding loops).
// Strips ~400 tokens of unused tool schemas per step.
const CODING_ONLY_NAMES = new Set(['bash', 'read_file', 'write_file', 'edit_file', 'list_dir', 'find', 'read_lines', 'grep_search', 'code_search', 'ask']);

// Generate a brief, human-readable narration from a tool call when the model
// doesn't provide its own text alongside tool_calls (common with Gemini).
function synthNarration(calls) {
  if (!calls?.length) return null;
  const parts = calls.map(c => {
    const p = c.args?.path || c.args?.file || c.args?.folder || '';
    const base = p ? path.basename(p) : '';
    switch (c.name) {
      case 'read_file': return `reading ${base || 'a file'}`;
      case 'write_file': return `writing ${base || 'a file'}`;
      case 'edit_file': return `editing ${base || 'a file'}`;
      case 'bash': return `running \`${String(c.args?.command || '').slice(0, 40)}\``;
      case 'list_dir': return `listing ${base || c.args?.path || 'directory'}`;
      case 'find': return `searching for ${c.args?.query || 'files'}`;
      case 'grep_search': return `searching for "${String(c.args?.query || '').slice(0, 30)}"`;
      case 'code_search': return `searching code for "${String(c.args?.query || '').slice(0, 30)}"`;
      case 'read_lines': return `reading lines from ${base || 'a file'}`;
      case 'google_search': return `searching the web`;
      case 'fetch': return `fetching a URL`;
      case 'remember': return `saving a note`;
      case 'retrieve': return `looking up memory`;
      case 'raw_memory_search': return `searching raw memory for "${c.args?.query || ''}"`;
      case 'read_raw_memory': return `reading raw memory ${c.args?.type || ''} ${c.args?.name || (c.args?.session_id ? '#' + c.args?.session_id : '')}`.trim();
      case 'diary': return c.args?.read ? `reading session diary` : `writing note to diary`;
      case 'spawn_subagent': return `spawning sub-agent "${c.args?.role || 'worker'}"`;
      case 'message_subagent': return `messaging sub-agent`;
      default: return `calling ${c.name}`;
    }
  });
  return parts.join(', ') + '...';
}

// Detect and extract pseudo tool calls written as text, e.g. [find: query: foo] or [read_file(bar)]
const PSEUDO_TOOL_NAMES = 'find|read_file|code_search|grep_search|list_dir|read_lines|bash|write_file|edit_file|google_search|fetch|retrieve|raw_memory_search|read_raw_memory|diary';

function extractPseudoToolCall(str) {
  if (!str || typeof str !== 'string') return null;

  // Format 1: [tool_name: key: val, ...] or [tool_name: val]
  const m1 = str.match(new RegExp(`\\[(${PSEUDO_TOOL_NAMES}):\\s*([^\\]]+)\\]`, 'i'));
  if (m1) {
    const name = m1[1].toLowerCase();
    const rawArgs = m1[2].trim();
    const args = {};

    if (name === 'google_search') {
      const qm = rawArgs.match(/(?:q|query):\s*([^,\n]+)/i);
      args.q = (qm ? qm[1] : rawArgs).replace(/^["']|["']$/g, '').trim();
    } else if (name === 'fetch') {
      const um = rawArgs.match(/url:\s*([^,\n]+)/i);
      args.url = (um ? um[1] : rawArgs).replace(/^["']|["']$/g, '').trim();
    } else if (name === 'retrieve' || name === 'raw_memory_search') {
      const qm = rawArgs.match(/query:\s*([^,\n]+)/i);
      args.query = (qm ? qm[1] : rawArgs).replace(/^["']|["']$/g, '').trim();
    } else if (name === 'diary') {
      args.text = rawArgs.replace(/^text:\s*/i, '').replace(/^["']|["']$/g, '').trim();
    } else if (name === 'find' || name === 'grep_search' || name === 'code_search') {
      const qm = rawArgs.match(/query:\s*([^,\n]+)/i);
      args.query = (qm ? qm[1] : rawArgs).replace(/^["']|["']$/g, '').trim();
      const pm = rawArgs.match(/(?:path|folder):\s*([^,\n]+)/i);
      if (pm) args.path = pm[1].replace(/^["']|["']$/g, '').trim();
    } else if (name === 'read_file' || name === 'list_dir' || name === 'read_raw_memory') {
      const pm = rawArgs.match(/path:\s*([^,\n]+)/i);
      args.path = (pm ? pm[1] : rawArgs).replace(/^["']|["']$/g, '').trim();
    } else if (name === 'bash') {
      const cm = rawArgs.match(/command:\s*(.+)/i);
      args.command = (cm ? cm[1] : rawArgs).replace(/^["']|["']$/g, '').trim();
    } else if (name === 'edit_file') {
      const pm = rawArgs.match(/path:\s*([^,\n]+)/i);
      if (pm) args.path = pm[1].replace(/^["']|["']$/g, '').trim();
    }
    return { name, args, rawMatch: m1[0] };
  }

  // Format 2: [tool_name(args)]
  const m2 = str.match(new RegExp(`\\[(${PSEUDO_TOOL_NAMES})\\(([^)]*)\\)\\]`, 'i'));
  if (m2) {
    const name = m2[1].toLowerCase();
    const raw = m2[2].trim().replace(/^["']|["']$/g, '');
    let args;
    if (name === 'google_search') args = { q: raw };
    else if (name === 'fetch') args = { url: raw };
    else if (name === 'find' || name === 'grep_search' || name === 'code_search' || name === 'retrieve' || name === 'raw_memory_search') args = { query: raw };
    else if (name === 'diary') args = { text: raw };
    else if (name === 'bash') args = { command: raw };
    else args = { path: raw };
    return { name, args, rawMatch: m2[0] };
  }

  return null;
}

const STALL_REGEX = /\b(i'll|i will|let me|lemme|going to|gonna|about to|setting (it )?up|inspecting|checking|examining|looking into|looking for|looking up|diving into|diving in|searching|fetching|running|scanning|investigating|reading|editing|writing|pulling up|digging into|gathering|on it|working on it|let's (dive|check|see|find|search|look|inspect)|hold on|hang on|give me a (sec|second|moment)|one sec)\b|\.{3,}$|…$/i;

const TRIVIAL = new Set(['bash', 'read_file', 'write_file', 'edit_file', 'find', 'list_dir', 'read_lines', 'grep_search', 'code_search']);

const BASE_TOOLS = [
  ...toolDefs.filter((t) => TRIVIAL.has(t.function.name) || ['ask', 'remember', 'list_tools', 'set_project', 'retrieve', 'diary', 'set_task_done', 'get_tasks'].includes(t.function.name)),
  thinkToolDef(toolDefs[0])
];

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

function buildLoopSystem() {
  return loopPrompt(isSoloOnly());
}

const PLAYWRIGHT_WEB_TOOLS = [
  'web_launch', 'web_close', 'web_new_tab',
  'web_goto', 'web_back', 'web_reload',
  'web_click', 'web_dblclick', 'web_fill', 'web_press', 'web_hover', 'web_drag', 'web_scroll',
  'web_screenshot', 'web_get_text', 'web_get_url', 'web_wait'
];

const DESKTOP_TOOLS = [
  'desktop_click', 'desktop_type', 'desktop_press',
  'desktop_scroll', 'desktop_drag', 'desktop_screenshot',
  'desktop_get_window_state', 'desktop_list_apps', 'desktop_launch_app'
];

// messages = [{ role: 'user'|'assistant', content: string }]
// onStep(kind, data) — optional progress callback: 'tool_call' | 'tool_result' | 'done' | 'thought'
const LITE_NAMES = ['bash', 'read_file', 'write_file', 'edit_file', 'find', 'list_dir', 'read_lines', 'grep_search', 'code_search', 'google_search', 'fetch', ...PLAYWRIGHT_WEB_TOOLS, ...DESKTOP_TOOLS, 'ask', 'remember', 'retrieve', 'raw_memory_search', 'read_raw_memory', 'diary', 'get_tasks', 'set_task_done', 'add_task_cluster', 'mcp_search', 'mcp_list'];
const LITE_TOOLS = toolDefs.filter((t) => LITE_NAMES.includes(t.function.name));
const LITE_GROUPS = {
  none: [],
  memory: ['remember', 'retrieve', 'raw_memory_search', 'read_raw_memory', 'diary'],
  web: ['google_search', 'fetch', ...PLAYWRIGHT_WEB_TOOLS],
  desktop: [...DESKTOP_TOOLS],
  shell: ['bash', 'read_file', 'write_file', 'edit_file', 'find', 'list_dir', 'read_lines', 'grep_search', 'code_search', 'ask', 'diary'],
  all: ['bash', 'read_file', 'write_file', 'edit_file', 'find', 'list_dir', 'read_lines', 'grep_search', 'code_search', 'google_search', 'fetch', 'ask', 'remember', 'retrieve', 'raw_memory_search', 'read_raw_memory', 'diary', 'get_tasks', 'set_task_done'],
  tasks: ['get_tasks', 'set_task_done', 'add_task_cluster'],
  mcp: ['mcp_search', 'mcp_list', 'bash', 'read_file', 'write_file', 'edit_file', 'find', 'list_dir', 'read_lines', 'grep_search', 'code_search', 'ask', 'diary']
};
const MORE_TOOL = { type: 'function', function: { name: 'more_tools', description: 'Load browser automation and desktop tools when web browser or GUI automation is needed.', parameters: { type: 'object', properties: {} } } };
const WEB_NAMES = ['google_search', 'fetch'];
const WEB_BUDGET = 3;
const RESULT_CAP = 1500;
const LITE_TOKEN_BUDGET = 80000;
const AGENT_WEB_BUDGET = 6;
const AGENT_WEB_CAP = 3000;
const AGENT_OUTPUT_CAP = 8000;
const OUTPUT_TOOLS = ['read_file', 'bash', 'find', 'list_dir', 'read_lines', 'grep_search', 'code_search', 'raw_memory_search', 'read_raw_memory', 'diary', 'web_get_text', 'web_screenshot', 'web_get_url', 'desktop_screenshot', 'desktop_get_window_state', 'desktop_list_apps'];
async function runToolGuarded(call, state, opts = {}) {
  if (state.over) return 'Error: token budget for this message is used up. Answer now with what you have and say what you would check next.';
  if (!WEB_NAMES.includes(call.name)) {
    const out = await runTool(call.name, call.args, opts);
    const toolCap = call.name === 'read_file' ? 65000 : AGENT_OUTPUT_CAP;
    if ((OUTPUT_TOOLS.includes(call.name) || !toolDefs.some((t) => t.function.name === call.name)) && out.length > toolCap) return String(out).slice(0, toolCap) + '\n...[truncated ' + (out.length - toolCap) + ' chars shortened to save tokens; the file is intact. use grep -n, sed -n or wc to read other parts]';
    return out;
  }
  if (state.web >= AGENT_WEB_BUDGET) return 'Error: web budget used up for this message. Answer with what you have and say plainly what you could not confirm.';
  state.web++;
  const r = String(await runTool(call.name, call.args, opts));
  return r.length > AGENT_WEB_CAP ? r.slice(0, AGENT_WEB_CAP) + '\n...[truncated]' : r;
}


// shared by chat (conversation) and light modes: small prompt, small tool set, no agent prompt
async function runLite(routed, sessionId, onStep, system, { signal } = {}) {
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
  let expanded = false;
  const mcpToolNames = routed.mcp ? ['mcp_search', 'mcp_list'] : [];
  // Detect direct-action mode: if router insight says [action] or request is clearly a mutation
  const ACTION_INSIGHT = /\[action\]|\bedit_file\b|\bwrite_file\b|\bfix\b|\bupdate\b|\bchange\b|\badd\b|\bremove\b/i;
  const isActionMode = ACTION_INSIGHT.test(routed.insight || '') || /^(fix|update|change|add|remove|edit|delete|rename|refactor|rewrite|improve)\b/i.test(routed.query || '');

  const pickLite = (step, hasCodingContext) => {
    let names = LITE_GROUPS[routed.tools] || LITE_GROUPS.all;
    // JIT tool stripping: after step 0, if we've been doing file/shell work,
    // strip to bare essentials (~400 tokens saved per step)
    if (step > 0 && hasCodingContext && ['shell', 'all'].includes(routed.tools) && !routed.mcp && !expanded) {
      names = names.filter(n => CODING_ONLY_NAMES.has(n));
    }
    if (expanded) names = [...new Set([...names, ...LITE_GROUPS.all, ...PLAYWRIGHT_WEB_TOOLS, ...DESKTOP_TOOLS])];
    if (routed.mcp) names = [...new Set([...names, ...mcpToolNames])];
    if (!isDiaryEnabled()) names = names.filter(n => n !== 'diary');
    // Direct-action mode: suppress list_dir at step 0 to force surgical edits
    if (step === 0 && isActionMode) names = names.filter(n => n !== 'list_dir');
    let tools = LITE_TOOLS.filter((t) => names.includes(t.function.name));
    if (!isDiaryEnabled()) tools = tools.filter(t => (t.function?.name || t.name) !== 'diary');
    if (mcpMod) tools = [...tools, ...mcpMod.getLoadedMcpDefs()];
    if (!expanded && !['web', 'desktop'].includes(routed.tools)) tools = [...tools, MORE_TOOL];
    return webCalls >= WEB_BUDGET ? tools.filter((t) => !WEB_NAMES.includes(t.function.name)) : tools;
  };
  const effort = getEffort();
  const maxLiteSteps = effort?.maxLiteSteps || 12;
  const liteTokenBudget = Math.floor(LITE_TOKEN_BUDGET * (effort?.tokenBudgetMult || 1.0));
  const callCounts = new Map();
  let listDirCount = 0;
  let lastText = '';
  let lastEditedPath = null;
  let earlyStop = false;
  for (let step = 0; step < maxLiteSteps; step++) {
    if (signal?.aborted) return '[Interrupted]';
    if (liteTokens > liteTokenBudget) return 'Stopped: light-mode token budget (' + liteTokenBudget + ') reached for this message. Send another message to continue from here.';
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
        const activeSystem = step === 0 ? litePrompt(system, expanded ? 'all' : routed.tools) : buildLoopSystem();
        const hasCodingContext = messages.some(m => m.role === 'tool');
        const res = await chatWithTools(messages, { system: activeSystem, tools: pickLite(step, hasCodingContext), maxTokens: 8192, signal });
        text = res.text;
        lastText = text;
        toolCalls = res.toolCalls;
        message = res.message;
        usage = res.usage;
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError' || err.message === 'Interrupted') return '[Interrupted]';
        return `API error: ${err.message}. Please try again.`;
      }
    if (signal?.aborted) return '[Interrupted]';
    liteTokens += (usage && (usage.inputTokens + usage.outputTokens)) || 0;
    if (sessionId) recordUsage(sessionId, usage);
    if (!toolCalls.length) {
      const pseudo = extractPseudoToolCall(text);
      if (pseudo) {
        toolCalls = [{ id: 'call_pseudo_' + Date.now(), name: pseudo.name, args: pseudo.args }];
        text = text.replace(pseudo.rawMatch, '').trim();
        message = {
          role: 'assistant',
          content: text,
          tool_calls: [{ id: toolCalls[0].id, type: 'function', function: { name: pseudo.name, arguments: JSON.stringify(pseudo.args) } }]
        };
      } else {
        const out = (text || '').trim();
        if (!out && messages.some((m) => m.role === 'tool') && step < maxLiteSteps - 1) {
          messages.push({ role: 'user', content: '(that came back empty. You already inspected the files above. Proceed directly to writing or editing them with write_file or edit_file now to fulfill the request. Do not stop blank.)' });
          continue;
        }
        const isAnnouncement = STALL_REGEX.test(out) && !out.slice(-160).includes('?');
        if (step < 3 && isAnnouncement && (out.length < 250 || !messages.some((m) => m.role === 'tool'))) {
          if (out.length > 8) onStep?.('narrate', out);
          messages.push({ role: 'assistant', content: out });
          messages.push({ role: 'user', content: '(you announced or narrated doing this, but made no tool call. Call the relevant tool now using function calling to execute the action. Do not stop with only narration.)' });
          continue;
        }
        return !out || out.includes('[[AGENT]]') ? null : out;
      }
    }
    messages.push(message);

    // Emit narration text when the model writes prose alongside tool calls.
    // If the model didn't narrate (common with Gemini), generate one from the tool calls.
    if (text && text.trim().length > 12) onStep?.('narrate', text.trim());
    else { const synth = synthNarration(toolCalls); if (synth) onStep?.('narrate', synth); }

    const askCall = toolCalls.find((c) => c.name === 'ask');
    if (askCall) {
      if (signal?.aborted) return '[Interrupted]';
      onStep?.('tool_call', askCall);
      const result = await runTool(askCall.name, askCall.args);
      onStep?.('tool_result', { call: askCall, result });
      return JSON.parse(result);
    }
    for (const call of toolCalls) {
      if (signal?.aborted) return '[Interrupted]';
      onStep?.('tool_call', call);
      const isReadOnly = ['read_file', 'list_dir', 'find', 'read_lines', 'grep_search', 'code_search', 'retrieve', 'raw_memory_search', 'read_raw_memory'].includes(call.name);
      const callKey = `${call.name}:${JSON.stringify(call.args || {})}`;
      const seenCount = callCounts.get(callKey) || 0;
      let result;
      if (call.name === 'list_dir') listDirCount++;
      if (isReadOnly && seenCount >= 1) {
        callCounts.set(callKey, seenCount + 1);
        result = seenCount === 1
          ? (call.name === 'list_dir'
              ? 'Notice: You already listed this directory. To find specific files across subdirectories, use find(query, path) or code_search(query, path) instead of repeatedly listing directories.'
              : 'Notice: You already called this exact tool with identical arguments earlier in this turn. See earlier result in conversation history. Do not repeat; proceed with your edit or answer.')
          : 'Error: Redundant call aborted to save tokens. Proceed with the data already retrieved.';
      } else if (call.name === 'list_dir' && listDirCount > 2) {
        result = 'Notice: Multiple list_dir calls detected in this turn. Do not wander directories with list_dir; use find(query, path) or code_search(query, path) to locate target files across all subfolders directly in 1 step, or proceed to edit_file/read_file.';
      } else {
        if (isReadOnly) callCounts.set(callKey, 1);
        const ok = LITE_NAMES.includes(call.name) || (mcpMod && mcpMod.isMcpTool(call.name));
        result = call.name === 'more_tools' ? (expanded = true, 'All light tools including file, shell, web and desktop are now available.') : ok ? await runTool(call.name, call.args) : 'Error: tool not available here';
      }
      if (WEB_NAMES.includes(call.name)) webCalls++;
      result = String(result);
      if (call.name === 'bash') result = cleanCliOutput(result);
      const cap = call.name === 'read_file' ? 65000 : call.name === 'bash' ? 12000 : RESULT_CAP;
      if (result.length > cap) result = result.slice(0, cap) + '\n...[output shortened to save tokens; the file is intact. use grep -n or sed -n to read other parts]';
      // Compact earlier read_file results for paths we just wrote/edited
      if ((call.name === 'write_file' || call.name === 'edit_file') && call.args?.path) {
        compactSupersededReads(messages, call.args.path);
        lastEditedPath = call.args.path;
      }
      // Early stop: if bash verify passes (exit 0) after a write/edit, we're done
      if (call.name === 'bash' && lastEditedPath && typeof result === 'string' && !result.includes('Error') && !result.includes('error') && !result.match(/exit.*[1-9]/)) {
        earlyStop = true;
      }
      onStep?.('tool_result', { call, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      if (signal?.aborted) return '[Interrupted]';
    }

    // Early stop: edit/write succeeded and bash verify passed — terminate cleanly
    if (earlyStop) {
      earlyStop = false;
      const nextRes = await chatWithTools(messages, { system: '(Final reply only. State what was done in 1-2 casual lines. No tool calls.)', tools: [], maxTokens: 256, signal });
      const finalText = nextRes.text?.trim() || lastText?.trim() || 'done.';
      onStep?.('done', finalText);
      return finalText;
    }
    // Dead-loop detection: if we've accumulated too many duplicate read-only calls, we're stuck
    const totalDupes = [...callCounts.values()].reduce((sum, v) => sum + Math.max(0, v - 1), 0);
    if (totalDupes >= 3) {
      const dupeList = [...callCounts.entries()].filter(([, v]) => v > 1).map(([k, v]) => `${k.split(':')[0]} (${v}x)`).join(', ');
      const breakMsg = `alright, i'm going in circles — re-reading the same things (${dupeList}). what exactly should i do here? give me a specific instruction or path and i'll get it done.`;
      onStep?.('done', breakMsg);
      return breakMsg;
    }
  }
  return (lastText || '').trim() || `Completed ${maxLiteSteps} steps in light mode. Check the updated files, or let me know if you want me to keep going.`;
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

export async function runAgent(userMessage, { onStep, maxSteps, forceAgent, signal } = {}) {
  if (signal?.aborted) return '[Interrupted]';
  const sessionId = currentSessionId();
  if (sessionId) startTurn(sessionId);
  const projectName = sessionId ? getProject(sessionId) : null;
  const stored = sessionId ? loadMessages(sessionId) : [];

  // router is mandatory: every message goes through it first
  const routed = await route(userMessage, {
    recentUser: stored.filter((m) => m.role === 'user').map((m) => m.text),
    forceAgent,
    sessionId,
    signal
  });
  if (signal?.aborted) return '[Interrupted]';
  onStep?.('route', routed);
  try { fs.appendFileSync(path.join(os.homedir(), '.levi', 'ROUTE.log'), JSON.stringify({ t: new Date().toISOString(), route: routed.route, tools: routed.tools, insight: routed.insight, q: String(userMessage).slice(0, 50) }) + '\n'); } catch {}
  const exchange = buildExchange(stored);
  routed.exchange = exchange;

  // conversation mode: tiny prompt, no tools, no thought step
  if (routed.route === 'light') {
    const reply = await runLite(routed, sessionId, onStep, 'light', { signal });
    if (reply) {
      onStep?.('done', reply);
      return reply;
    }
    routed.insight = 'escalated from light mode';
  }

  if (routed.route === 'conversation') {
    const reply = await runLite(routed, sessionId, onStep, 'convo', { signal });
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
  const effort = getEffort();
  // a cap, not spend: agent mode is real work, scaled by active effort
  const effectiveMaxSteps = maxSteps || Math.max(pendingTasks * 4 + 10, effort?.maxAgentSteps || 30);
  let tokenBudget = Math.floor((50000 + pendingTasks * 10000) * (effort?.tokenBudgetMult || 1.0));
  const system = buildSystem();
  const loopSystem = buildLoopSystem();
  const SUB = ['spawn_subagent', 'list_subagents', 'message_subagent'];
  const unlocked = new Set([
    ...(routed.tools === 'web' ? CATEGORIES.web : []),
    ...(routed.tools === 'desktop' ? CATEGORIES.desktop : [])
  ]);
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
    let all = [...BASE_TOOLS, ...toolDefs.filter((t) => unlocked.has(t.function.name) && !BASE_TOOLS.includes(t)), ...(customMcp ? toolDefs.filter((t) => t.function.name === 'mcp_search' || t.function.name === 'mcp_list') : []), ...(mcpMod ? mcpMod.getLoadedMcpDefs() : [])];
    if (isSoloOnly()) all = all.filter((t) => !SUB.includes(t.function?.name || t.name));
    if (!isDiaryEnabled()) all = all.filter((t) => (t.function?.name || t.name) !== 'diary');
    return all;
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
  const callCounts = new Map();
  let listDirCount = 0;

  for (let step = 0; step < effectiveMaxSteps; step++) {
    if (signal?.aborted) return '[Interrupted]';
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
      const activeSystem = step === 0 ? system : loopSystem;
      const res = await chatWithTools(messages, { system: activeSystem, tools: pickTools(), maxTokens: 8192, signal });
      text = res.text;
      toolCalls = res.toolCalls;
      message = res.message;
      usage = res.usage;
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError' || err.message === 'Interrupted') {
        return '[Interrupted]';
      }
      onStep?.('error', err);
      const errMsg = `API error: ${err.message}. Please try again.`;
      onStep?.('done', errMsg);
      return errMsg;
    }
    if (signal?.aborted) return '[Interrupted]';
    webState.tokens += (usage && (usage.inputTokens + usage.outputTokens)) || 0;
    if (webState.tokens >= tokenBudget) webState.over = true;
    if (sessionId) recordUsage(sessionId, usage);

    if (!toolCalls.length) {
      const pseudo = extractPseudoToolCall(text);
      if (pseudo) {
        toolCalls = [{ id: 'call_pseudo_' + Date.now(), name: pseudo.name, args: pseudo.args }];
        text = text.replace(pseudo.rawMatch, '').trim();
        message = {
          role: 'assistant',
          content: text,
          tool_calls: [{ id: toolCalls[0].id, type: 'function', function: { name: pseudo.name, arguments: JSON.stringify(pseudo.args) } }]
        };
      } else if (!text || !text.trim()) {
        blankRetries++;
        onStep?.('blank_retry', { attempt: blankRetries, step });

        if (blankRetries <= MAX_BLANK_RETRIES && step < effectiveMaxSteps - 1) {
          messages.push(message);

          let nudge;
          const hasInspected = messages.some((m) => m.role === 'tool');
          const pendingCluster = sessionId ? getTasks(sessionId).find((c) => c.status !== 'completed') : null;
          if (hasInspected) {
            nudge = "(that came back empty. You already inspected the files above. Do NOT call read_file or list_dir again — write or edit the files directly with write_file or edit_file now to fulfill the user's request. Do not stop blank.)";
          } else if (pendingCluster) {
            const undone = pendingCluster.tasks.filter((t) => !t.done);
            nudge = `(that came back empty. You have an active task cluster "${pendingCluster.title}" with ${undone.length} task(s) not yet marked done: ${undone.map((t) => t.text).join(', ')}. If you just got a sub-agent report back, call set_task_done for it now. If the work is actually finished, mark the remaining tasks done and give a real summary. Don't stop blank.)`;
          } else {
            nudge = "(that came back empty. Before answering: inspect the relevant files directly using read_file, list_dir, or grep_search, and proceed with the requested work or give a clear specific answer. Don't stop blank.)";
          }

          messages.push({ role: 'user', content: nudge });
          continue;
        }

        // build a dynamic fallback from what actually happened in this turn
        let fallback;
        const toolMsgs = messages.filter(m => m.role === 'tool');
        const toolCallMsgs = messages.filter(m => m.role === 'assistant' && m.tool_calls?.length);
        const uniqueTools = [...new Set(toolCallMsgs.flatMap(m => (m.tool_calls || []).map(t => t.function?.name || 'unknown')))];

        if (sessionId) {
          const clusters = getTasks(sessionId);
          if (clusters.length) {
            const summary = clusters
              .map((c) => {
                const done = c.tasks.filter((t) => t.done).length;
                return `"${c.title}" — ${done}/${c.tasks.length} tasks done`;
              })
              .join('; ');
            fallback = `alright, got stuck mid-work. here's where things stand: ${summary}. used ${toolMsgs.length} tool calls (${uniqueTools.join(', ') || 'none'}). send another message to keep going or tell me what to focus on.`;
          }
        }
        if (!fallback) {
          if (toolMsgs.length) {
            fallback = `alright, tried ${toolMsgs.length} tool call${toolMsgs.length > 1 ? 's' : ''} (${uniqueTools.join(', ')}) but couldn't finish cleanly. what specifically do you want me to do next?`;
          } else {
            fallback = `alright, got stuck before making any tool calls — the request might need more context. can you rephrase or tell me exactly what file/folder to work with?`;
          }
        }
        onStep?.('done', fallback);
        return fallback;
      }
      const isAnnouncement = STALL_REGEX.test(text.trim()) && !text.trim().slice(-160).includes('?');
      if (stallNudges < 3 && step < effectiveMaxSteps - 1 && isAnnouncement && (text.trim().length < 250 || !messages.some((m) => m.role === 'tool'))) {
        stallNudges++;
        onStep?.('stall_nudge', { attempt: stallNudges, step });
        if (text.trim().length > 8) onStep?.('narrate', text.trim());
        messages.push(message);
        messages.push({ role: 'user', content: '(you announced a plan or narrated doing this, but made no tool call. The instruction was clear, so execute it now using your tools. Do not stop with only narration.)' });
        continue;
      }
      onStep?.('done', text);
      return text;
    }

    messages.push(message);

    // Emit narration text when the model writes prose alongside tool calls.
    // If the model didn't narrate (common with Gemini), generate one from the tool calls.
    if (text && text.trim().length > 12) onStep?.('narrate', text.trim());
    else { const synth = synthNarration(toolCalls); if (synth) onStep?.('narrate', synth); }

    const askCall = toolCalls.find((c) => c.name === 'ask');
    if (askCall) {
      if (signal?.aborted) return '[Interrupted]';
      onStep?.('tool_call', askCall);
      const result = await runTool(askCall.name, askCall.args);
      onStep?.('tool_result', { call: askCall, result });
      const payload = JSON.parse(result);
      onStep?.('done', payload);
      return payload;
    }

    for (const call of toolCalls) {
      if (signal?.aborted) return '[Interrupted]';
      onStep?.('tool_call', call);
      const isReadOnly = ['read_file', 'list_dir', 'find', 'read_lines', 'grep_search', 'code_search', 'retrieve', 'raw_memory_search', 'read_raw_memory'].includes(call.name);
      const callKey = `${call.name}:${JSON.stringify(call.args || {})}`;
      const seenCount = callCounts.get(callKey) || 0;
      let result;
      if (call.name === 'list_dir') listDirCount++;
      if (isReadOnly && seenCount >= 1) {
        callCounts.set(callKey, seenCount + 1);
        result = seenCount === 1
          ? (call.name === 'list_dir'
              ? 'Notice: You already listed this directory. To find specific files across subdirectories, use find(query, path) or code_search(query, path) instead of repeatedly listing directories.'
              : 'Notice: You already called this exact tool with identical arguments earlier in this turn. See earlier result in conversation history. Do not repeat; proceed with your edit or answer.')
          : 'Error: Redundant call aborted to save tokens. Proceed with the data already retrieved.';
      } else if (call.name === 'list_dir' && listDirCount > 2) {
        result = 'Notice: Multiple list_dir calls detected in this turn. Do not wander directories with list_dir; use find(query, path) or code_search(query, path) to locate target files across all subfolders directly in 1 step, or proceed to edit_file/read_file.';
      } else {
        if (isReadOnly) callCounts.set(callKey, 1);
          result = call.name === 'think'
            ? await think(call.args, { projectName, sessionId })
            : await runToolGuarded(call, webState, { onStep });
      }
      const lc = call.name === 'list_tools' ? [null, String(call.args?.category || '').toLowerCase()] : call.name.match(/^list_(\w+)_commands$/);
      if (lc) for (const n of CATEGORIES[lc[1] === 'task' ? 'tasks' : lc[1]] || []) unlocked.add(n);
      if (call.name === 'bash') result = cleanCliOutput(String(result));
      // Compact earlier read_file results for paths we just wrote/edited
      if ((call.name === 'write_file' || call.name === 'edit_file') && call.args?.path) {
        compactSupersededReads(messages, call.args.path);
      }
      onStep?.('tool_result', { call, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      if (signal?.aborted) return '[Interrupted]';
    }

    // Dead-loop detection: if we've accumulated too many duplicate read-only calls, we're stuck
    const totalDupes = [...callCounts.values()].reduce((sum, v) => sum + Math.max(0, v - 1), 0);
    if (totalDupes >= 4) {
      const dupeList = [...callCounts.entries()].filter(([, v]) => v > 1).map(([k, v]) => `${k.split(':')[0]} (${v}x)`).join(', ');
      const breakMsg = `alright, i'm going in circles — re-reading the same things (${dupeList}). what exactly should i do here? give me a specific instruction or path and i'll get it done.`;
      onStep?.('done', breakMsg);
      return breakMsg;
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
