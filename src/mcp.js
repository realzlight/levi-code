import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEVI_HOME = path.join(os.homedir(), '.levi');
const MCP_CONFIG_PATH = path.join(LEVI_HOME, 'mcp.json');
const CONFIG_PATH = path.join(LEVI_HOME, 'config.json');

// Registry of connected clients and tools
const clients = new Map(); // serverName -> Client
const mcpToolMap = new Map(); // toolName -> { client, serverName, originalName, schema }
let initialized = false;

// --- Search API key helpers ---------------------------------------------------

/**
 * Read the Serper API key from ~/.levi/config.json or environment.
 * Returns the key string or null. Never creates files.
 */
export function getSearchApiKey() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return process.env.SERPER_API_KEY || null;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return cfg.search?.api_key || cfg.search?.api || process.env.SERPER_API_KEY || null;
  } catch {
    return process.env.SERPER_API_KEY || null;
  }
}

/**
 * Read the GitHub token from ~/.levi/config.json auth (obtained during login).
 * Returns the token string or null.
 */
export function getGithubToken() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return process.env.GITHUB_TOKEN || null;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return cfg.auth?.token || process.env.GITHUB_TOKEN || null;
  } catch {
    return process.env.GITHUB_TOKEN || null;
  }
}

/**
 * Store a Serper API key into ~/.levi/config.json.
 * Never creates config.json or ~/.levi — returns an error string if missing.
 */
export function setSearchApiKey(apiKey) {
  if (!fs.existsSync(LEVI_HOME)) return 'Error: ~/.levi directory not found. Run levi first to bootstrap.';
  if (!fs.existsSync(CONFIG_PATH)) return 'Error: ~/.levi/config.json not found. Run levi first to bootstrap.';

  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    cfg.search = {
      provider: 'serper',
      api_key: apiKey.trim()
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    initialized = false;
    return null; // success
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// --- MCP config ---------------------------------------------------------------

export function loadMcpConfig() {
  if (fs.existsSync(MCP_CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'));
    } catch (e) {
      console.error(`[mcp] Error reading ${MCP_CONFIG_PATH}: ${e.message}`);
    }
  }

  return {
    mcpServers: {
      serper: {
        command: "npx",
        args: ["-y", "mcp-server-serper"],
        env: { SERPER_API_KEY: "" }
      },
      fetch: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-fetch"]
      }
    }
  };
}

/**
 * Resolves transport params adapting for local Termux and node modules.
 */
function resolveServerCommand(serverName, serverCfg) {
  const rootDir = path.resolve(__dirname, '..');
  const fetchPath = path.join(__dirname, 'fetch-server.js');
  const everythingPath = path.join(rootDir, 'node_modules', '@modelcontextprotocol', 'server-everything', 'dist', 'index.js');
  const everythingPath2 = path.join(rootDir, 'node_modules', '@modelcontextprotocol', 'server-everything', 'dist', 'everything.js');
  const serperPath = path.join(rootDir, 'node_modules', 'mcp-server-serper', 'build', 'index.js');

  const argsStr = (serverCfg.args || []).join(' ');

  // Serper MCP Server
  if (serverName === 'serper' || argsStr.includes('serper')) {
    if (fs.existsSync(serperPath)) {
      return { command: 'node', args: [serperPath], env: serverCfg.env };
    }
  }

  // Fetch MCP Server
  if (serverName === 'fetch' || argsStr.includes('server-fetch')) {
    if (fs.existsSync(fetchPath)) {
      return { command: 'node', args: [fetchPath] };
    }
  }

  // Everything MCP Server - bypass npx
  if (serverName === 'everything' || argsStr.includes('server-everything')) {
    if (fs.existsSync(everythingPath)) {
      return { command: 'node', args: [everythingPath], env: serverCfg.env };
    }
    if (fs.existsSync(everythingPath2)) {
      return { command: 'node', args: [everythingPath2], env: serverCfg.env };
    }
    const dir = path.join(rootDir, 'node_modules', '@modelcontextprotocol', 'server-everything', 'dist');
    if (fs.existsSync(dir)) {
      const file = fs.readdirSync(dir).find(f => f.endsWith('.js'));
      if (file) return { command: 'node', args: [path.join(dir, file)], env: serverCfg.env };
    }
  }

  return { command: serverCfg.command || 'npx', args: serverCfg.args || [] };
}

/**
 * Connect to all configured MCP servers and discover their tools.
 */
export async function initMcp({ verbose = false } = {}) {
  if (initialized) return getMcpTools();

  const config = loadMcpConfig();
  const servers = { ...(config.mcpServers || {}) };
  delete servers.playwright;

  // Inject Serper API key from config.json into environment
  const serperKey = getSearchApiKey();

  for (const [serverName, serverCfg] of Object.entries(servers)) {
    if (serverCfg.disabled || serverCfg._disabled) continue;
    if (clients.has(serverName)) continue;

    // Skip serper if no API key is configured
    if (serverName === 'serper' || (serverCfg.args || []).join(' ').includes('serper')) {
      const envKey = serverCfg.env?.SERPER_API_KEY || serperKey;
      if (!envKey) {
        if (verbose) console.log(`[mcp] Skipping ${serverName} — no SERPER_API_KEY. Set it with /search:api <key>`);
        continue;
      }
      serverCfg.env = { ...serverCfg.env, SERPER_API_KEY: envKey };
    }

    // Inject GitHub auth token from config.json into headers
    if (serverName === 'github' && serverCfg.url) {
      const ghToken = serverCfg.headers?.Authorization ? null : getGithubToken();
      if (ghToken) {
        serverCfg.headers = { ...serverCfg.headers, Authorization: `Bearer ${ghToken}` };
      } else if (!serverCfg.headers?.Authorization) {
        if (verbose) console.log(`[mcp] Skipping ${serverName} — no GitHub token. Login first.`);
        continue;
      }
    }

    try {
      let transport, client;

      if (serverCfg.url) {
        // --- REMOTE (Streamable HTTP / SSE fallback) ---
        if (verbose) console.log(`[mcp] Connecting to ${serverName} (${serverCfg.url})...`);
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js').catch(async () => {
          const mod = await import('@modelcontextprotocol/sdk/client/sse.js');
          return { StreamableHTTPClientTransport: mod.SSEClientTransport };
        });
        const headers = { ...(serverCfg.headers || {}) };
        transport = new StreamableHTTPClientTransport(new URL(serverCfg.url), {
          requestInit: { headers }
        });
        client = new Client({ name: `levi-${serverName}-client`, version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
      } else {
        // --- STDIO ---
        const resolved = resolveServerCommand(serverName, serverCfg);
        if (verbose) {
          console.log(`[mcp] Connecting to ${serverName} (${resolved.command} ${resolved.args.join(' ').slice(0, 60)})...`);
        }
        const transportOpts = { command: resolved.command, args: resolved.args };
        if (resolved.env || serverCfg.env) {
          transportOpts.env = { ...process.env, ...(resolved.env || serverCfg.env) };
        }
        transport = new StdioClientTransport(transportOpts);
        client = new Client({ name: `levi-${serverName}-client`, version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
      }

      clients.set(serverName, client);

      const listRes = await client.listTools();
      const tools = listRes?.tools || [];

      for (const tool of tools) {
        mcpToolMap.set(tool.name, {
          client,
          serverName,
          originalName: tool.name,
          schema: tool
        });
      }

      if (verbose) {
        console.log(`[mcp] Connected ${serverName} — ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
      }
    } catch (err) {
      if (verbose) {
        console.error(`[mcp] Failed to connect to "${serverName}": ${err.message}`);
      }
    }
  }

  initialized = true;
  return getMcpTools();
}

/**
 * Returns all MCP tools converted to OpenAI tool format.
 */
export function getMcpTools() {
  const tools = [];
  for (const [toolName, info] of mcpToolMap.entries()) {
    tools.push({
      type: 'function',
      function: {
        name: toolName,
        description: info.schema.description || `Tool from ${info.serverName} MCP server`,
        parameters: info.schema.inputSchema || { type: 'object', properties: {} }
      }
    });
  }
  return tools;
}

/**
 * Check if a tool name belongs to an MCP server.
 */
export function isMcpTool(name) {
  if (name === 'serper_search' && mcpToolMap.has('google_search')) return true;
  return mcpToolMap.has(name);
}

/**
 * Call an MCP tool by name with arguments.
 */
const INDEX_PATH = path.join(path.dirname(MCP_CONFIG_PATH), 'mcp-index.json');
const STATIC_SERVER = { google_search: 'serper', serper_search: 'serper', fetch: 'fetch' };
const STATIC_NAMES = ['serper', 'fetch'];
const connecting = new Map();
const loadedMcp = new Set();

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8')); } catch { return {}; }
}

function saveIndexFor(server, tools) {
  if (STATIC_NAMES.includes(server)) return;
  const idx = readIndex();
  idx[server] = tools.map((t) => ({ n: t.name, d: String(t.description || '').replace(/\s+/g, ' ').slice(0, 140) }));
  try { fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 1)); } catch {}
}

export function connectedServers() {
  return [...clients.keys()];
}

/** Returns just the names of enabled MCP servers from config, without connecting. */
export function getMcpServerNames() {
  try {
    const config = loadMcpConfig();
    return Object.entries(config.mcpServers || {})
      .filter(([, v]) => !v.disabled && !v._disabled)
      .map(([k]) => k);
  } catch { return []; }
}

// connect exactly one configured server on demand
async function ensureServer(serverName) {
  if (clients.has(serverName)) return true;
  if (connecting.has(serverName)) return connecting.get(serverName);
  const p = (async () => {
    const config = loadMcpConfig();
    const base = (config.mcpServers || {})[serverName];
    if (!base || base.disabled || base._disabled) return false;
    const serverCfg = { ...base };
    if (serverName === 'serper' || (serverCfg.args || []).join(' ').includes('serper')) {
      const envKey = serverCfg.env?.SERPER_API_KEY || getSearchApiKey();
      if (!envKey) return false;
      serverCfg.env = { ...serverCfg.env, SERPER_API_KEY: envKey };
    }
    // Inject GitHub auth token from config.json into headers
    if (serverName === 'github' && serverCfg.url) {
      const ghToken = serverCfg.headers?.Authorization ? null : getGithubToken();
      if (ghToken) {
        serverCfg.headers = { ...serverCfg.headers, Authorization: `Bearer ${ghToken}` };
      } else if (!serverCfg.headers?.Authorization) {
        return false;
      }
    }
    try {
      let transport, client;

      if (serverCfg.url) {
        // --- REMOTE (Streamable HTTP / SSE fallback) ---
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js').catch(async () => {
          const mod = await import('@modelcontextprotocol/sdk/client/sse.js');
          return { StreamableHTTPClientTransport: mod.SSEClientTransport };
        });
        const headers = { ...(serverCfg.headers || {}) };
        transport = new StreamableHTTPClientTransport(new URL(serverCfg.url), {
          requestInit: { headers }
        });
        client = new Client({ name: `levi-${serverName}-client`, version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
      } else {
        // --- STDIO ---
        const resolved = resolveServerCommand(serverName, serverCfg);
        const transportOpts = { command: resolved.command, args: resolved.args };
        if (resolved.env || serverCfg.env) transportOpts.env = { ...process.env, ...(resolved.env || serverCfg.env) };
        transport = new StdioClientTransport(transportOpts);
        client = new Client({ name: `levi-${serverName}-client`, version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
      }

      clients.set(serverName, client);
      const tools = (await client.listTools())?.tools || [];
      for (const tool of tools) mcpToolMap.set(tool.name, { client, serverName, originalName: tool.name, schema: tool });
      saveIndexFor(serverName, tools);
      return true;
    } catch {
      return false;
    } finally {
      connecting.delete(serverName);
    }
  })();
  connecting.set(serverName, p);
  return p;
}

// make sure the server that owns this tool is connected, without starting the others
async function ensureForTool(name) {
  if (mcpToolMap.has(name) || (name === 'serper_search' && mcpToolMap.has('google_search'))) return;
  const server = STATIC_SERVER[name];
  if (server) {
    await ensureServer(server);
    if (mcpToolMap.has(name) || mcpToolMap.has('google_search')) return;
  }
  const hit = Object.entries(readIndex()).find(([, tools]) => tools.some((t) => t.n === name));
  if (hit) {
    await ensureServer(hit[0]);
    if (mcpToolMap.has(name)) return;
  }
  if (!initialized) await initMcp();
}

export function resetLoadedMcp() {
  loadedMcp.clear();
}

export function getLoadedMcpDefs() {
  return getMcpTools().filter((t) => loadedMcp.has(t.function.name));
}

// keyword search over the custom MCP tool index; connects and loads only the matches
export async function searchMcp(query) {
  const config = loadMcpConfig();
  const names = Object.entries(config.mcpServers || {}).filter(([k, v]) => !v.disabled && !v._disabled && !STATIC_NAMES.includes(k)).map(([k]) => k);
  if (!names.length) return 'No custom MCP servers configured. Add servers in ~/.levi/mcp.json.';
  let idx = readIndex();
  for (const s of names) if (!idx[s]) await ensureServer(s);
  idx = readIndex();
  const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const scored = [];
  for (const s of names) {
    for (const t of idx[s] || []) {
      const hay = (s + ' ' + t.n + ' ' + t.d).toLowerCase();
      const score = words.reduce((a, w) => a + (hay.includes(w) ? 1 : 0), 0);
      if (score > 0 || !words.length) scored.push({ s, t, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 6);
  if (!top.length) return 'No matching MCP tools. Custom servers: ' + names.join(', ');
  for (const s of new Set(top.map((x) => x.s))) await ensureServer(s);
  for (const x of top) loadedMcp.add(x.t.n);
  return 'Loaded, call them now:\n' + top.map((x) => x.t.n + ' (' + x.s + '): ' + x.t.d).join('\n');
}

export async function runMcpTool(name, args = {}) {
  await ensureForTool(name);

  // Handle serper / google_search aliases and query normalization
  let targetTool = name;
  let callArgs = { ...args };

  if (name === 'serper_search' || name === 'google_search') {
    targetTool = mcpToolMap.has('google_search') ? 'google_search' : name;
    if (callArgs.query && !callArgs.q) {
      callArgs.q = callArgs.query;
      delete callArgs.query;
    }
  }

  const toolInfo = mcpToolMap.get(targetTool);
  if (!toolInfo) {
    throw new Error(`MCP tool not found: ${name}`);
  }

  const { client, originalName } = toolInfo;
  try {
    const result = await client.callTool({
      name: originalName,
      arguments: callArgs
    });

    if (result.isError) {
      const errMsg = result.content?.map(c => c.text || JSON.stringify(c)).join('\n') || 'MCP tool error';
      return `Error: ${errMsg}`;
    }

    let outputText = '';
    if (Array.isArray(result.content)) {
      outputText = result.content
        .map(c => (typeof c.text === 'string' ? c.text : JSON.stringify(c, null, 2)))
        .join('\n');
    } else {
      outputText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }

    // Summarize search results, fetched pages, and web activities using active model from config.json
    return await summarizeWebOutput(outputText, { toolName: name, args });
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

/**
 * Summarizes web search, fetch, and browsing results before returning them to the agent.
 * Uses the active model selected in ~/.levi/config.json with a concise prompt.
 */
async function summarizeWebOutput(content, { toolName, args = {} } = {}) {
  if (!content || typeof content !== 'string') return content;
  if (content.startsWith('Error:') || content.trim().length < 1500) return content;

  // Tools that should have their output summarized
  const isSearch = toolName === 'google_search' || toolName === 'serper_search' || toolName === 'brave_web_search';
  const isFetch = toolName === 'fetch' || toolName === 'scrape';
  const isWebActivity = toolName.startsWith('playwright_') || isSearch || isFetch;

  if (!isWebActivity) return content;

  let context = '';
  if (isSearch) {
    const q = args.q || args.query || '';
    context = q ? `Web Search Query: "${q}"` : 'Web Search';
  } else if (isFetch) {
    const url = args.url || '';
    context = url ? `Fetched URL: ${url}` : 'Web Page Content';
  } else {
    context = `Browser Activity: ${toolName}`;
  }

  // Cap content length to prevent model context limits
  const maxChars = 8000;
  const truncated = content.length > maxChars
    ? content.slice(0, maxChars) + '\n\n[... Remaining content truncated for summary]'
    : content;

  const system = `You are an expert, concise web content summarizer for an AI assistant.
Summarize the key information, factual answers, data, and relevant URLs from the provided raw web content.
Rules:
- Be dense, direct, and factual.
- Retain important specifics (names, code snippets, numbers, versions, URLs).
- Do NOT include unnecessary filler, conversational intro, or boilerplate.`;

  const prompt = `Context: ${context}

Raw Content:
${truncated}

Provide a concise, high-signal summary of the above content focusing on the key information. Max 150 words.`;

  try {
    const { chat } = await import('./agent/client.js');
    const res = await chat([{ role: 'user', content: prompt }], {
      system,
      maxTokens: 450
    });
    try {
      const { currentSessionId } = await import('./agent/session.js');
      const { recordUsage } = await import('./agent/usage.js');
      const sid = currentSessionId();
      if (sid && res && res.usage) recordUsage(sid, res.usage);
    } catch {}
    if (res?.text && res.text.trim()) {
      return res.text.trim();
    }
  } catch (err) {
    // If summarization fails (e.g. offline, rate limit), return raw output gracefully
    return content;
  }

  return content;
}

/**
 * Disconnect from all MCP servers.
 */
export async function closeMcp() {
  for (const [serverName, client] of clients.entries()) {
    try {
      await client.close();
    } catch {}
  }
  clients.clear();
  mcpToolMap.clear();
  initialized = false;
}

process.on('exit', () => {
  closeMcp();
});

// Standalone execution: node src/mcp.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('=== Levi MCP Integration Tester ===');
  console.log(`Config: ${MCP_CONFIG_PATH}`);
  console.log(`Serper API key: ${getSearchApiKey() ? '*** (set)' : '(not set — use /search:api <key>)'}\n`);

  try {
    const tools = await initMcp({ verbose: true });
    console.log(`\nTotal MCP tools loaded: ${tools.length}`);

    console.log('\nConverted OpenAI Tool Definitions:');
    for (const t of tools) {
      console.log(`- ${t.function.name}: ${t.function.description.slice(0, 70)}...`);
    }

    // Test search with Serper
    if (isMcpTool('google_search') || isMcpTool('serper_search')) {
      console.log('\n--- Testing google_search("Anthropic MCP") ---');
      const searchRes = await runMcpTool('google_search', { q: 'Anthropic Model Context Protocol' });
      console.log('Search Output (sample):');
      console.log(searchRes.slice(0, 300) + '...\n');
    }

    // Test fetching with Fetch
    if (isMcpTool('fetch')) {
      console.log('--- Testing fetch("https://example.com") ---');
      const fetchRes = await runMcpTool('fetch', { url: 'https://example.com', max_length: 200 });
      console.log('Fetch Output:');
      console.log(fetchRes + '\n');
    }

    console.log('✓ All MCP tests passed successfully.');
  } catch (err) {
    console.error('MCP test error:', err);
  } finally {
    await closeMcp();
    process.exit(0);
  }
}
