# Levi Model Context Protocol (MCP) — Walkthrough & Reference

Welcome to the **Levi MCP System Guide**. The Model Context Protocol (MCP) is an open standard that allows Levi to securely connect to external tools, databases, APIs, and enterprise contexts without writing custom plugin code.

---

## 1. Overview & Architecture

Levi's MCP client communicates with any MCP-compliant server over two standard transports:

| Transport | Communication | Common Use Cases | Configuration Key |
| :--- | :--- | :--- | :--- |
| **STDIO** | Local subprocess via standard I/O streams | Local CLI tools, database connectors, npx/python packages | `command`, `args`, `env` |
| **REMOTE** | HTTP with Server-Sent Events (SSE) or Streamable HTTP | Hosted services, microservices, remote team infrastructure | `url`, `headers` |

### Configuration File: `~/.levi/mcp.json`
All MCP servers and credentials are saved in your user home directory:
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    },
    "remote-tools": {
      "url": "https://mcp.internal.company.com/sse",
      "headers": {
        "Authorization": "Bearer ssk_live_12345"
      }
    }
  }
}
```

---

## 2. Command Reference

Use these slash commands inside the Levi terminal to manage your MCP servers:

| Command | Syntax | Description |
| :--- | :--- | :--- |
| `/mcp` | `/mcp` | Opens this fullscreen interactive walkthrough guide. |
| `/mcp:list` | `/mcp:list` | Lists all configured servers, connection status, and active tools. |
| `/mcp:add` | `/mcp:add <name> <cmd> [args...]` | Quickly registers a new stdio MCP server. |
| `/mcp:disable` | `/mcp:disable <name>` | Temporarily disables a server without deleting its credentials. |
| `/mcp:enable` | `/mcp:enable <name>` | Re-enables a disabled MCP server. |
| `/mcp:reload` | `/mcp:reload` | Reconnects to all active servers and refreshes the tool catalog. |
| `/mcp:remove` | `/mcp:remove <name>` | Permanently removes an MCP server configuration. |

---

## 3. Quickstart: Adding Popular MCP Servers

### GitHub MCP Server
Allows Levi to inspect PRs, file issues, and search remote GitHub repos:
```bash
/mcp:add github npx -y @modelcontextprotocol/server-github
```
*Note: Add your `GITHUB_PERSONAL_ACCESS_TOKEN` to `~/.levi/mcp.json` under `env`.*

### PostgreSQL Database Server
Allows Levi to inspect schema, analyze query plans, and query tables:
```bash
/mcp:add postgres npx -y @modelcontextprotocol/server-postgres postgresql://user:pass@localhost:5432/dbname
```

### SQLite Database Server
Direct read/write SQLite database access:
```bash
/mcp:add sqlite npx -y @modelcontextprotocol/server-sqlite --db-path ./project.db
```

### Browser Automation (Playwright / Chromium)
Enables web browsing, visual testing, screenshot verification, and SPA testing:
```bash
levi install:browser
```
Or manually configure:
```bash
/mcp:add playwright npx -y @executeautomation/playwright-mcp-server
```

### Brave Search / Web Search
Gives the agent live internet search capabilities:
```bash
/mcp:add brave npx -y @modelcontextprotocol/server-brave-search
```
*Note: Requires `BRAVE_API_KEY` set in `~/.levi/mcp.json` under `env`.*

---

## 4. How Levi Dispatches MCP Tools

1. **Namespacing**: Tools provided by MCP servers are prefixed as `<server>__<toolName>` (e.g. `github__create_pull_request`).
2. **Lazy Initialization**: Servers are connected on demand when their tools are required, preserving low startup latency and memory efficiency.
3. **Automatic Schema Discovery**: Tool definitions, descriptions, and input parameters are fetched dynamically via `listTools()` on server startup.
4. **Resilience**: If an MCP server fails or times out, Levi cleanly reports the error back to the conversation loop without crashing the pair programming session.

---

## 5. Tips & Best Practices

• **Environment Variables**: Store API keys inside the `env` block in `~/.levi/mcp.json`. Avoid committing tokens to git repositories.
• **Disabling vs Removing**: If a server is slow or not needed for the current project, run `/mcp:disable <name>` instead of deleting it.
• **Troubleshooting**: Run `/mcp:reload` to force a reconnection and tool re-index whenever you edit `~/.levi/mcp.json`.
