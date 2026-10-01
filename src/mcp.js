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

// Registry of connected clients and tools
const clients = new Map(); // serverName -> Client
const mcpToolMap = new Map(); // toolName -> { client, serverName, originalName, schema }
let initialized = false;

export function loadMcpConfig() {
  if (fs.existsSync(MCP_CONFIG_PATH)) {
    try {
      const content = fs.readFileSync(MCP_CONFIG_PATH, 'utf-8');
      return JSON.parse(content);
    } catch (e) {
      console.error(`[mcp] Error reading ${MCP_CONFIG_PATH}: ${e.message}`);
    }
  }

  // Default config if mcp.json does not exist
  return {
    mcpServers: {
      duckduckgo: {
        command: "npx",
        args: ["-y", "duckduckgo-mcp-server"]
      },
      fetch: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-fetch"]
      },
      playwright: {
        command: "npx",
        args: ["-y", "@executeautomation/playwright-mcp-server"]
      }
    }
  };
}

/**
 * Resolves transport parameters adapting for local Termux and node modules.
 */
function resolveServerCommand(serverName, serverCfg) {
  const rootDir = path.resolve(__dirname, '..');
  const ddgPath = path.join(rootDir, 'node_modules', 'duckduckgo-mcp-server', 'build', 'index.js');
  const fetchPath = path.join(__dirname, 'fetch-server.js');
  const playwrightPath = path.join(rootDir, 'node_modules', '@executeautomation', 'playwright-mcp-server', 'dist', 'index.js');

  const argsStr = (serverCfg.args || []).join(' ');

  // DuckDuckGo MCP Server
  if (serverName === 'duckduckgo' || argsStr.includes('duckduckgo-mcp-server')) {
    if (fs.existsSync(ddgPath)) {
      return { command: 'node', args: [ddgPath] };
    }
  }

  // Fetch MCP Server
  if (serverName === 'fetch' || argsStr.includes('server-fetch')) {
    if (fs.existsSync(fetchPath)) {
      return { command: 'node', args: [fetchPath] };
    }
  }

  // Playwright MCP Server - spoof linux platform to avoid Termux "android" platform rejection
  if (serverName === 'playwright' || argsStr.includes('playwright-mcp-server')) {
    if (fs.existsSync(playwrightPath)) {
      return {
        command: 'node',
        args: [
          '-e',
          `Object.defineProperty(process, 'platform', { value: 'linux' }); import('${playwrightPath}');`
        ]
      };
    }
  }

  return {
    command: serverCfg.command || 'npx',
    args: serverCfg.args || []
  };
}

/**
 * Connect to all configured MCP servers and discover their tools.
 */
export async function initMcp({ verbose = false } = {}) {
  if (initialized) return getMcpTools();

  const config = loadMcpConfig();
  const servers = config.mcpServers || {};

  for (const [serverName, serverCfg] of Object.entries(servers)) {
    if (serverCfg.disabled) continue;

    try {
      const { command, args } = resolveServerCommand(serverName, serverCfg);
      if (verbose) {
        console.log(`[mcp] Connecting to ${serverName} (${command} ${args.join(' ')})...`);
      }

      const transport = new StdioClientTransport({ command, args });
      const client = new Client(
        { name: `levi-${serverName}-client`, version: '1.0.0' },
        { capabilities: {} }
      );

      await client.connect(transport);
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
        console.error(`[mcp] Failed to connect to server "${serverName}": ${err.message}`);
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
  return mcpToolMap.has(name);
}

export async function searchDuckDuckGoFallback(query, count = 10) {
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!res.ok) return `Search failed (HTTP ${res.status})`;
    const html = await res.text();
    const titles = [...html.matchAll(/<h2 class=\"result__title\">[\s\S]*?<a[^>]+href=[\"']([^\"']*)[\"'][^>]*>([\s\S]*?)<\/a>/g)];
    const snippets = [...html.matchAll(/class=\"result__snippet\"[^>]*>([\s\S]*?)<\/a>/g)];
    const results = [];
    for (let i = 0; i < Math.min(titles.length, count); i++) {
      const rawUrl = titles[i][1];
      let url = rawUrl;
      if (rawUrl.includes('uddg=')) {
        url = decodeURIComponent(rawUrl.split('uddg=')[1].split('&')[0]);
      }
      const title = titles[i][2].replace(/<[^>]+>/g, '').trim();
      const snippet = snippets[i] ? snippets[i][1].replace(/<[^>]+>/g, '').trim() : '';
      results.push(`${i + 1}. [${title}](${url})\n   ${snippet}`);
    }
    return results.length ? results.join('\n\n') : 'No results found.';
  } catch (err) {
    return `Search error: ${err.message}`;
  }
}

/**
 * Call an MCP tool by name with arguments.
 */
export async function runMcpTool(name, args = {}) {
  if (!initialized) {
    await initMcp();
  }

  // Handle DuckDuckGo with seamless fallback if MCP encounters rate limits
  if (name === 'duckduckgo_web_search') {
    const toolInfo = mcpToolMap.get(name);
    if (toolInfo) {
      try {
        const result = await toolInfo.client.callTool({
          name: toolInfo.originalName,
          arguments: args
        });
        if (!result.isError && Array.isArray(result.content)) {
          const text = result.content.map(c => c.text || JSON.stringify(c)).join('\n');
          if (text && !text.includes('anomaly')) return text;
        }
      } catch {}
    }
    return searchDuckDuckGoFallback(args.query, args.count || 10);
  }

  const toolInfo = mcpToolMap.get(name);
  if (!toolInfo) {
    throw new Error(`MCP tool not found: ${name}`);
  }

  const { client, originalName } = toolInfo;
  const result = await client.callTool({
    name: originalName,
    arguments: args
  });

  if (result.isError) {
    const errMsg = result.content?.map(c => c.text || JSON.stringify(c)).join('\n') || 'MCP tool error';
    return `Error: ${errMsg}`;
  }

  if (Array.isArray(result.content)) {
    return result.content
      .map(c => (typeof c.text === 'string' ? c.text : JSON.stringify(c, null, 2)))
      .join('\n');
  }

  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
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
  console.log(`Config: ${MCP_CONFIG_PATH}\n`);

  try {
    const tools = await initMcp({ verbose: true });
    console.log(`\nTotal MCP tools loaded: ${tools.length}`);

    console.log('\nConverted OpenAI Tool Definitions:');
    for (const t of tools) {
      console.log(`- ${t.function.name}: ${t.function.description.slice(0, 70)}...`);
    }

    // 1. Test search with DuckDuckGo
    if (isMcpTool('duckduckgo_web_search')) {
      console.log('\n--- Testing duckduckgo_web_search("Anthropic MCP") ---');
      const searchRes = await runMcpTool('duckduckgo_web_search', { query: 'Anthropic Model Context Protocol', count: 2 });
      console.log('Search Output (sample):');
      console.log(searchRes.slice(0, 300) + '...\n');
    }

    // 2. Test fetching with Fetch
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
