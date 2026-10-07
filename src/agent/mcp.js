import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MCP_FILE = path.join(os.homedir(), '.levi', 'mcp.json');
export const MCP_INDEX_PATH = path.join(os.homedir(), '.levi', 'mcp-index.json');

const clients = new Map(); // name -> { client, transport, defs }
let mcpIndex = null;

function loadCfg() {
  if (!fs.existsSync(MCP_FILE)) return { mcpServers: {} };
  return JSON.parse(fs.readFileSync(MCP_FILE, 'utf-8'));
}

export function connectedServers() { return [...clients.keys()]; }

function getTransport(serverCfg) {
  // REMOTE MCP - new part
  if (serverCfg.url) {
    // dynamic import so you don't need to install if not used
    return { type: 'remote', url: serverCfg.url, headers: serverCfg.headers || {} };
  }
  // STDIO MCP - old
  return {
    type: 'stdio',
    command: serverCfg.command,
    args: serverCfg.args || [],
    env: {...process.env,...(serverCfg.env || {}) }
  };
}

export async function ensureServer(name) {
  if (clients.has(name)) return clients.get(name);
  const cfg = loadCfg();
  const serverCfg = cfg.mcpServers?.[name];
  if (!serverCfg) throw new Error(`MCP server ${name} not found`);
  if (serverCfg._disabled) throw new Error(`${name} disabled`);

  let transport, client;

  if (serverCfg.url) {
    // --- REMOTE ---
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js').catch(async () => {
      // fallback for older sdk = SSE
      const mod = await import('@modelcontextprotocol/sdk/client/sse.js');
      return { StreamableHTTPClientTransport: mod.SSEClientTransport };
    });
    transport = new StreamableHTTPClientTransport(new URL(serverCfg.url), {
      requestInit: { headers: serverCfg.headers || {} }
    });
    client = new Client({ name: 'levi', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
  } else {
    // --- STDIO ---
    transport = new StdioClientTransport({
      command: serverCfg.command,
      args: serverCfg.args || [],
      env: {...process.env,...(serverCfg.env || {}) }
    });
    client = new Client({ name: 'levi', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
  }

  // load tools
  const { tools } = await client.listTools().catch(() => ({ tools: [] }));
  const defs = (tools || []).map(t => ({
    name: `${name}__${t.name}`,
    originalName: t.name,
    server: name,
    description: t.description || '',
    function: {
      name: `${name}__${t.name}`,
      description: t.description,
      parameters: t.inputSchema
    }
  }));

  const entry = { client, transport, defs, serverCfg };
  clients.set(name, entry);
  await saveIndex();
  return entry;
}

async function saveIndex() {
  const allDefs = [];
  for (const [, v] of clients) allDefs.push(...v.defs);
  fs.writeFileSync(MCP_INDEX_PATH, JSON.stringify(allDefs, null, 2));
}

export async function reloadMcpServers() {
  for (const [name, { client, transport }] of clients) {
    try { await client.close(); } catch {}
    try { await transport.close?.(); } catch {}
  }
  clients.clear();
  mcpIndex = null;
  if (fs.existsSync(MCP_INDEX_PATH)) fs.unlinkSync(MCP_INDEX_PATH);

  const cfg = loadCfg();
  for (const name of Object.keys(cfg.mcpServers || {})) {
    const s = cfg.mcpServers[name];
    if (s._disabled) continue;
    try { await ensureServer(name); } catch (e) { console.error(`Failed ${name}:`, e.message); }
  }
}

export function getLoadedMcpDefs() {
  if (!fs.existsSync(MCP_INDEX_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(MCP_INDEX_PATH, 'utf-8')); } catch { return []; }
}

export async function searchMcp(query = '') {
  if (!fs.existsSync(MCP_INDEX_PATH)) {
    // lazy load first time
    await reloadMcpServers();
  }
  const defs = getLoadedMcpDefs();
  const q = query.toLowerCase();
  if (!q) return defs;
  return defs.filter(d => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
}

export async function callMcpTool(fullName, args) {
  const [serverName,...toolParts] = fullName.split('__');
  const toolName = toolParts.join('__');
  const entry = clients.get(serverName) || await ensureServer(serverName);
  return await entry.client.callTool({ name: toolName, arguments: args });
}

export function disconnectServer(name) {
  const e = clients.get(name);
  if (!e) return;
  e.client.close().catch(()=>{});
  e.transport.close?.().catch(()=>{});
  clients.delete(name);
}

export function setSearchApiKey(key) {
  const file = path.join(os.homedir(), '.levi', 'config.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf-8'));
  c.serper_api_key = key;
  fs.writeFileSync(file, JSON.stringify(c, null, 2));
}
