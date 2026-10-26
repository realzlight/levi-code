import { execa } from 'execa';
import { parseArgs, tokenize, usage } from './args.js';

const registry = new Map();

export function defineCommand(cmd) {
  registry.set(cmd.name, cmd);
  return cmd;
}

export const getCommands = () => [...registry.values()];

// runs a shell command only when a handler asks for it
export async function shell(cmd, opts = {}) {
  const r = await execa(cmd, { shell: true, reject: false, all: true, ...opts });
  return { code: r.exitCode, output: r.all ?? '' };
}

// query = text typed after the "/"
export function filterCommands(query = '') {
  const q = query.trim().toLowerCase();
  const all = getCommands();
  if (!q) return all;
  const starts = all.filter(c => c.name.startsWith(q));
  const contains = all.filter(c => !c.name.startsWith(q) && c.name.includes(q));
  return [...starts, ...contains];
}

// input = full prompt text, e.g. '/models:use astra'
// ctx   = { print, clear, exit } supplied by the UI
export async function runCommand(input, ctx = {}) {
  ctx = { shell, print: console.log, printPanel: (p) => console.log(JSON.stringify(p)), ...ctx };

  const [name, ...rest] = tokenize(input.trim().replace(/^\//, ''));
  const cmd = registry.get(name);
  if (!cmd) return ctx.print(`Unknown command: /${name}. Try /help`);

  const { values, error } = parseArgs(cmd, rest);
  if (error) return ctx.print(`${error}\nUsage: ${usage(cmd)}`);
  if (!cmd.run) return ctx.print(`/${name} is not wired yet`);

  if (cmd.screen && ctx.suspend) return ctx.suspend(() => cmd.run(values, ctx));
  return cmd.run(values, ctx);
}

// ---- built-in commands ----

defineCommand({
  name: 'help',
  description: 'Show all commands',
  run: (_, ctx) => ctx.print(getCommands().map(c => `${usage(c)}  ${c.description}`).join('\n'))
});

defineCommand({ name: 'clear', description: 'Clear screen', run: (_, ctx) => ctx.clear?.() });
defineCommand({ name: 'exit', description: 'Quit Levi', run: (_, ctx) => ctx.exit?.() });

defineCommand({
  name: 'init',
  description: 'Bootstrap ~/.levi',
  run: async (_, ctx) => {
    const { runBootstrap } = await import('../bootstrap.js');
    const res = await runBootstrap({ quiet: true });
    const dirInfo = res.createdDirs.length
      ? `Created: ${res.createdDirs.join(', ')}`
      : '5 core directories verified';
    const fileInfo = res.createdFiles.length
      ? `Created: ${res.createdFiles.join(', ')}`
      : 'All files verified';

    ctx.printPanel({
      kind: 'init',
      title: 'LEVI Workspace Initialized',
      fields: [
        { label: 'Environment', value: res.home, color: '#22d3ee' },
        { label: 'Platform', value: res.platform?.label || 'Ready', color: '#38bdf8' },
        { label: 'Directories', value: dirInfo, color: '#4ade80' },
        { label: 'Files', value: fileInfo, color: '#c0caf5' },
        { label: 'MCP Servers', value: 'Serper · Fetch · GitHub · CUA Driver', color: '#a78bfa' },
        { label: 'Status', value: res.platform?.skipHeavyDeps ? 'Ready (Termux Companion)' : 'Ready (Full Desktop Suite)', color: '#ffd700' }
      ]
    });
  }
});

defineCommand({
  name: 'sh',
  description: 'Run a shell command',
  args: [{ name: 'command', required: true, rest: true }],
  run: async ({ command }, ctx) => {
    const r = await ctx.shell(command);
    ctx.print(r.output || `(exit ${r.code})`);
  }
});

// wired in a later step
defineCommand({ name: 'models:list', description: 'List models' });
defineCommand({ name: 'models:create', description: 'Add a model', args: [{ name: 'name' }] });
defineCommand({ name: 'models:edit', description: 'Edit a model', args: [{ name: 'name', required: true }] });
defineCommand({ name: 'models:use', description: 'Switch active model', args: [{ name: 'name', required: true }] });
defineCommand({ name: 'models:delete', description: 'Delete a model', args: [{ name: 'name', required: true }] });
defineCommand({ name: 'whoami', description: 'Show current user' });

defineCommand({
  name: 'login',
  description: 'Re-authenticate with GitHub (refreshes scopes for GitHub MCP)',
  screen: true,
  run: async (_, ctx) => {
    const { login } = await import('../commands/auth.js');
    await login();
    const { reloadMcpServers } = await import('../mcp.js');
    if (reloadMcpServers) await reloadMcpServers();
  }
});

defineCommand({
  name: 'logout',
  description: 'Sign out and quit',
  run: async (_, ctx) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.homedir(), '.levi', 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
    config.auth = { token: null, user: null, loggedIn: false };
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    ctx.print('Logged out. See you soon.');
    setTimeout(() => ctx.exit?.(), 600);
  }
});

// runs a command and returns everything it printed as one string
export async function runCapture(input, ctx = {}) {
  const out = [];
  let panel = null;
  await runCommand(input, { ...ctx, print: (t) => out.push(String(t)), printPanel: (p) => { panel = p; } });
  return { text: out.join('\n'), panel };
}

// ---- config helper + working commands ----
const cfg = {
  async file() {
    const os = await import('node:os');
    const path = await import('node:path');
    return path.join(os.homedir(), '.levi', 'config.json');
  },
  async read() {
    const fs = await import('node:fs');
    return JSON.parse(fs.readFileSync(await this.file(), 'utf-8'));
  },
  async write(c) {
    const fs = await import('node:fs');
    fs.writeFileSync(await this.file(), JSON.stringify(c, null, 2));
  }
};
const modelsMod = () => import('../commands/models.js');

defineCommand({
  name: 'models:list',
  description: 'List your models',
  run: async (_, ctx) => {
    const c = await cfg.read();
    const names = Object.keys(c.models || {});
    if (!names.length) return ctx.print('No models yet. Use /models:create');
    ctx.printPanel({
      title: 'Models',
      fields: names.map((n) => ({
        label: (c.active_model === n ? '★ ' : '  ') + n,
        value: `${c.models[n].sdk} · ${c.models[n].model}`
      }))
    });
  }
});

defineCommand({
  name: 'models:use',
  description: 'Switch the active model',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const c = await cfg.read();
    if (!c.models?.[name]) return ctx.print(`Model "${name}" not found`);
    c.active_model = name;
    await cfg.write(c);
    ctx.print(`Switched to ${name}`);
  }
});

defineCommand({
  name: 'models:delete',
  description: 'Delete a model',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const c = await cfg.read();
    if (!c.models?.[name]) return ctx.print(`Model "${name}" not found`);
    delete c.models[name];
    if (c.active_model === name) c.active_model = null;
    await cfg.write(c);
    ctx.print(`Deleted ${name}`);
  }
});

defineCommand({
  name: 'whoami',
  description: 'Show who you are logged in as',
  run: async (_, ctx) => {
    const { auth } = await cfg.read();
    if (!auth?.loggedIn) return ctx.print('Not logged in.');
    ctx.print(`${auth.user.name} (GitHub: ${auth.user.login})`);
  }
});

defineCommand({
  name: 'models:create',
  description: 'Add a new model',
  screen: true,
  run: async () => (await modelsMod()).createModel()
});

defineCommand({
  name: 'models:edit',
  description: 'Edit a model',
  screen: true,
  args: [{ name: 'name', required: true }],
  run: async ({ name }) => (await modelsMod()).editModel(name)
});

defineCommand({
  name: 'models:create',
  description: 'Add a new model',
  run: (_, ctx) => ctx.openForm({ mode: 'create' })
});

defineCommand({
  name: 'models:edit',
  description: 'Edit a model',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const c = await cfg.read();
    if (!c.models?.[name]) return ctx.print(`Model "${name}" not found`);
    ctx.openForm({ mode: 'edit', name });
  }
});

// ---- session commands ----
const sessionMod = () => import('../agent/session.js');

defineCommand({
  name: 'new',
  description: 'New session',
  run: async (_, ctx) => {
    const { createSession } = await sessionMod();
    const id = createSession();
    ctx.clear();
    ctx.print(`New session: SESSION-${id}`);
  }
});

defineCommand({
  name: 'resume',
  description: 'Resume a session',
  run: async (_, ctx) => {
    const { listSessions, currentSessionId } = await sessionMod();
    const sessions0 = listSessions();
    return ctx.openForm({ mode: 'resume', sessions: sessions0, current: currentSessionId() });
  }
});

defineCommand({
  name: 'compact',
  description: 'Compact session',
  run: async (_, ctx) => {
    if (ctx.openForm) {
      return ctx.openForm({ mode: 'compact' });
    }
    const { currentSessionId, getProject } = await sessionMod();
    const id = currentSessionId();
    if (!id) return ctx.print('No active session to compact.');
    const project = getProject(id);
    const { compact } = await import('../agent/compact.js');
    ctx.print('Compacting session buffer...');
    const result = await compact(id, project, { force: true });
    if (result && result.ok) {
      ctx.printPanel({
        title: `SESSION-${id} compacted`,
        fields: [
          { label: 'Compacted', value: `${result.compactedCount} messages` },
          { label: 'Kept', value: `${result.keptCount} recent messages` },
          { label: 'Summary', value: result.summary }
        ]
      });
      ctx.reload?.();
    } else if (result && result.skipped) {
      ctx.print(`Skipped: ${result.reason}`);
    } else {
      ctx.print(`Compaction failed: ${result?.error || 'Unknown error'}`);
    }
  }
});

defineCommand({
  name: 'session:prune',
  description: 'Prune empty/overflow sessions (auto-runs on startup)',
  run: async (_, ctx) => {
    const { autoPruneSessions } = await sessionMod();
    const result = autoPruneSessions({ maxActive: 30, maxEnded: 60, pruneEmpty: true });
    ctx.printPanel({
      title: 'Session Prune',
      fields: [
        { label: 'Empty removed', value: String(result.prunedEmpty ?? 0) },
        { label: 'Active archived', value: String(result.archivedActive ?? 0) },
        { label: 'Ended deleted', value: String(result.prunedEnded ?? 0) }
      ]
    });
  }
});

defineCommand({
  name: 'alone',
  description: 'Toggle solo mode',
  run: async (_, ctx) => {
    const { isSoloOnly, setSoloOnly } = await sessionMod();
    const next = setSoloOnly(!isSoloOnly());
    ctx.printPanel({
      title: 'Solo-only mode',
      fields: [{ label: 'Status', value: next ? 'ON — Levi will never launch subagents' : 'OFF — Levi may launch subagents when needed', color: next ? 'yellow' : 'green' }]
    });
  }
});

defineCommand({
  name: 'diary',
  description: 'Toggle session scratchpad (diary) feature for agent',
  args: [{ name: 'setting' }],
  run: async ({ setting }, ctx) => {
    const { isDiaryEnabled, setDiaryEnabled } = await sessionMod();
    let next;
    const s = String(setting || '').trim().toLowerCase();
    if (s === 'on' || s === 'enable' || s === 'true') {
      next = setDiaryEnabled(true);
    } else if (s === 'off' || s === 'disable' || s === 'false') {
      next = setDiaryEnabled(false);
    } else {
      next = setDiaryEnabled(!isDiaryEnabled());
    }
    ctx.printPanel({
      title: 'Diary Scratchpad',
      fields: [{ label: 'Status', value: next ? 'ON — Levi can use session diary scratchpad' : 'OFF — Diary tool disabled (no tool def sent to agent)', color: next ? '#4ade80' : '#f87171' }]
    });
  }
});

const memMod = () => import('../commands/mem.js');

defineCommand({
  name: 'mem:push',
  description: 'Push ~/.levi to remote',
  run: (_, ctx) => ctx.openForm({ mode: 'mem-push' })
});

defineCommand({
  name: 'mem:sync',
  description: 'Pull remote → local ~/.levi',
  run: (_, ctx) => ctx.openForm({ mode: 'mem-sync-confirm1' })
});

defineCommand({
  name: 'agent',
  description: 'Toggle subagent mode',
  run: async (_, ctx) => {
    const { isSoloOnly, setSoloOnly } = await sessionMod();
    const next = setSoloOnly(!isSoloOnly());
    ctx.printPanel({
      title: 'Sub-agent mode',
      fields: [{ label: 'Status', value: next ? 'Solo-only ON — subagents disabled' : 'ON — Levi may launch subagents when useful', color: next ? 'yellow' : 'green' }]
    });
  }
});

defineCommand({
  name: 'context',
  description: 'Session token usage',
  run: async (_, ctx) => {
    const { currentSessionId } = await sessionMod();
    const { getTotalUsage } = await import('../agent/usage.js');
    const id = currentSessionId();
    if (!id) return ctx.print('No active session yet.');
    const u = getTotalUsage(id);
    ctx.printPanel({
      title: `SESSION-${id} — total usage`,
      fields: [
        { label: 'Input tokens', value: String(u.inputTokens) },
        { label: 'Output tokens', value: String(u.outputTokens) },
        { label: 'Turns', value: String(u.turnCount) },
        { label: 'API calls', value: String(u.callCount) }
      ]
    });
  }
});

defineCommand({
  name: 'usage',
  description: 'Last message token usage',
  run: async (_, ctx) => {
    const { currentSessionId } = await sessionMod();
    const { getLastTurnUsage } = await import('../agent/usage.js');
    const id = currentSessionId();
    if (!id) return ctx.print('No active session yet.');
    const u = getLastTurnUsage(id);
    if (!u.callCount) return ctx.print('No usage recorded yet this session.');
    ctx.printPanel({
      title: 'Latest message usage',
      fields: [
        { label: 'Input tokens', value: String(u.inputTokens) },
        { label: 'Output tokens', value: String(u.outputTokens) },
        { label: 'API calls', value: String(u.callCount) }
      ]
    });
  }
});

defineCommand({
  name: 'search:api',
  description: 'Set Serper search API key',
  args: [{ name: 'api', required: true }],
  run: async (args, ctx) => {
    const { setSearchApiKey } = await import('../mcp.js');
    const err = setSearchApiKey(args.api);
    if (err) return ctx.print(err);
    ctx.print('Serper API key saved to ~/.levi/config.json');
  }
});

defineCommand({
  name: 'end',
  description: 'Compact, then move the current session to ended-buffer',
  args: [{ name: 'confirm', rest: true }],
  run: async (args, ctx) => {
    const typed = (typeof args === 'string' ? args : Array.isArray(args) ? args.join(' ') : Object.values(args || {}).join(' '))
      .toLowerCase().replace(/\s+/g, ' ').trim();
    const { currentSessionId, getTitle, getProject, endSession } = await sessionMod();
    const id = currentSessionId();
    if (!id) return ctx.print('No active session to end.');
    const anyway = typed === 'i want to end anyway';
    if (typed !== 'i want to end' && !anyway) {
      const title = getTitle(id);
      return ctx.print('This will end SESSION-' + id + (title ? ' "' + title + '"' : '') + '. /compact runs first so your memory is saved.\nTo confirm, type exactly: /end i want to end');
    }
    if (!anyway) {
      const { compact } = await import('../agent/compact.js');
      ctx.print('Compacting first...');
      const result = await compact(id, getProject(id), { force: true });
      if (!(result && (result.ok || result.skipped))) {
        return ctx.print('Compaction failed: ' + (result?.error || 'unknown error') + '. Nothing was ended.\nTo end without compacting, type: /end i want to end anyway');
      }
    }
    if (!endSession(id)) return ctx.print('Could not end SESSION-' + id + '.');
    ctx.clear?.();
    ctx.print('SESSION-' + id + ' moved to ended-buffer. Use /alive to restore it. Your next message starts a new session.');
  }
});


// --------------------------------------------------------------
// ---- mcp commands ----
defineCommand({
  name: 'mcp:list',
  description: 'List MCP servers',
  run: async (_, ctx) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.homedir(), '.levi', 'mcp.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    const { connectedServers } = await import('../mcp.js');
    const connected = connectedServers();
    const lines = Object.entries(cfg.mcpServers||{}).map(([k,v])=>{
      const st = v._disabled? '❌ disabled' : connected.includes(k)? '🟢 connected' : '⚪ idle';
      const target = v.url ? v.url : `${v.command || 'npx'} ${(v.args||[]).join(' ')}`;
      return `${st} ${k} -> ${target}`;
    });
    ctx.print(lines.join('\n') || 'No MCP servers');
  }
});

defineCommand({
  name: 'mcp:add',
  description: 'Add MCP: /mcp:add <name> <command> [args...] | /mcp:add <name> --url https://... [--header K=V]',
  args: [{ name: 'command', required: true, rest: true }],
  run: async ({ command }, ctx) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.homedir(), '.levi', 'mcp.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.mcpServers = cfg.mcpServers || {};

    const tokens = command.split(' ').filter(Boolean);
    const name = tokens[0];
    if (!name) return ctx.print('Usage: /mcp:add <name> --url https://... OR /mcp:add <name> <command> [args]');

    if (tokens.includes('--url')) {
      const urlIdx = tokens.indexOf('--url');
      const url = tokens[urlIdx+1];
      const headers = {};
      const hIdx = tokens.indexOf('--header');
      if (hIdx!== -1) {
        for (const pair of tokens.slice(hIdx+1)) {
          const eq = pair.indexOf('=');
          if (eq>0) headers[pair.slice(0,eq)] = pair.slice(eq+1);
        }
      }
      cfg.mcpServers[name] = { url, headers: Object.keys(headers).length?headers:undefined };
      fs.writeFileSync(file, JSON.stringify(cfg,null,2));
      ctx.print(`Added remote MCP ${name} -> ${url}\nDo /mcp:reload`);
      return;
    }

    // stdio fallback (your old logic)
    const envIdx = tokens.indexOf('--env');
    let env = {};
    let cmdArgs = tokens.slice(1);
    if (envIdx!== -1) { /*... your env parsing */ }
    cfg.mcpServers[name] = { command: cmdArgs[0]||'npx', args: cmdArgs.slice(1), env: Object.keys(env).length?env:undefined };
    fs.writeFileSync(file, JSON.stringify(cfg,null,2));
    ctx.print(`Added ${name}. /mcp:reload`);
  }
});

defineCommand({
  name: 'mcp:disable',
  description: 'Disable MCP server',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.homedir(), '.levi', 'mcp.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    if (!cfg.mcpServers?.[name]) return ctx.print(`Not found: ${name}`);
    cfg.mcpServers[name]._disabled = true;
    fs.writeFileSync(file, JSON.stringify(cfg,null,2));
    ctx.print(`Disabled ${name}. /mcp:reload to disconnect.`);
  }
});

defineCommand({
  name: 'mcp:enable',
  description: 'Enable MCP server',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.homedir(), '.levi', 'mcp.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    if (!cfg.mcpServers?.[name]) return ctx.print(`Not found: ${name}`);
    delete cfg.mcpServers[name]._disabled;
    fs.writeFileSync(file, JSON.stringify(cfg,null,2));
    ctx.print(`Enabled ${name}. /mcp:reload to connect.`);
  }
});

defineCommand({
  name: 'mcp:reload',
  description: 'Reload all MCP servers',
  run: async (_, ctx) => {
    const { reloadMcpServers, connectedServers } = await import('../mcp.js');
    if (reloadMcpServers) {
      await reloadMcpServers();
      ctx.print(`Reloaded. Connected: ${connectedServers().join(', ')||'none'}`);
    } else {
      ctx.print('Reload not implemented, restart Levi');
    }
  }
});

defineCommand({
  name: 'mcp:remove',
  description: 'Remove MCP server',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.homedir(), '.levi', 'mcp.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    if (!cfg.mcpServers?.[name]) return ctx.print(`Not found: ${name}`);
    delete cfg.mcpServers[name];
    fs.writeFileSync(file, JSON.stringify(cfg,null,2));
    ctx.print(`Removed ${name}`);
  }
});

defineCommand({
  name: 'index:rebuild',
  description: 'Rebuild search index',
  run: async (_, ctx) => {
    const { rebuildIndex } = await import('../agent/retrieval.js');
    const res = await rebuildIndex();
    ctx.print(res);
  }
});

defineCommand({
  name: 'mem:search',
  description: 'Search memory & session index from index.db (auto-rebuilds index)',
  args: [{ name: 'query', required: true, rest: true }],
  run: async ({ query }, ctx) => {
    const q = Array.isArray(query) ? query.join(' ') : String(query || '').trim();
    if (!q) return ctx.print('Usage: /mem:search <query>');
    const { rebuildIndex, retrieve } = await import('../agent/retrieval.js');
    await rebuildIndex();
    const res = await retrieve({ query: q, rebuild: false });
    ctx.print(res);
  }
});

defineCommand({
  name: 'cs',
  description: 'Search code with SQLite FTS5: /cs <path> <query> or /cs <query>',
  args: [{ name: 'path_or_query', required: true }, { name: 'query', rest: true }],
  run: async ({ path_or_query, query }, ctx) => {
    let targetPath;
    let targetQuery;
    if (query !== undefined) {
      targetPath = String(path_or_query);
      targetQuery = Array.isArray(query) ? query.join(' ') : String(query).trim();
    } else {
      targetPath = process.cwd();
      targetQuery = Array.isArray(path_or_query) ? path_or_query.join(' ') : String(path_or_query).trim();
    }
    if (!targetQuery) return ctx.print('Usage: /cs <path> <query> or /cs <query>');
    const { searchCode } = await import('../agent/codeSearch.js');
    const res = await searchCode({ path: targetPath, query: targetQuery });
    ctx.print(res);
  }
});

defineCommand({
  name: 'changelog',
  description: 'View the Levi changelog (fullscreen, Esc to close)',
  run: async (_, ctx) => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const nodePath = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const clPath = nodePath.join(nodePath.dirname(__filename), '../../CHANGELOG.md');
    if (!existsSync(clPath)) return ctx.print('CHANGELOG.md not found at ' + clPath);
    const content = readFileSync(clPath, 'utf-8');
    ctx.openForm({ mode: 'changelog', content });
  }
});

defineCommand({
  name: 'title',
  description: 'Rename the current session',
  args: [{ name: 'name', required: true, rest: true }],
  run: async ({ name }, ctx) => {
    const session = await import('../agent/session.js');
    const id = session.currentSessionId();
    if (!id) return ctx.print('No active session.');
    const newTitle = Array.isArray(name) ? name.join(' ') : String(name ?? '').trim();
    if (!newTitle) return ctx.print('Usage: /title <new name>');
    session.setTitle(id, newTitle);
    ctx.print(`Session renamed to "${newTitle}"`);
  }
});

defineCommand({
  name: 'delete',
  description: 'Hard-delete the current session (no compact, permanent)',
  run: async (_, ctx) => {
    const session = await import('../agent/session.js');
    const id = session.currentSessionId();
    if (!id) return ctx.print('No active session to delete.');
    const title = session.getTitle(id);
    ctx.openForm({ mode: 'delete-confirm', sessionId: id, title });
  }
});

defineCommand({
  name: 'alive',
  description: 'Restore an ended session back to active (and rebuild search index)',
  args: [{ name: 'id', required: false, description: 'Optional session ID to restore' }],
  run: async ({ id: targetId }, ctx) => {
    const session = await import('../agent/session.js');
    const { rebuildIndex } = await import('../agent/retrieval.js');
    const ended = session.listEndedSessions();
    if (!ended.length) return ctx.print('No ended sessions found in ~/.levi/ENDED-BUFFER.');
    if (targetId) {
      const match = ended.find((e) => String(e.id) === String(targetId) || e.dirName === targetId);
      if (!match) return ctx.print(`Session "${targetId}" not found in ~/.levi/ENDED-BUFFER.`);
      const newId = session.restoreSession(match.dirName);
      if (!newId) return ctx.print(`Failed to restore session "${targetId}".`);
      const res = await rebuildIndex();
      return ctx.print(`Restored to SESSION-${newId}. ${res}`);
    }
    ctx.openForm({ mode: 'alive', ended });
  }
});

// ---- skills commands ----
const skillsMod = () => import('../agent/skills.js');

defineCommand({
  name: 'skills',
  description: 'List all custom skills',
  run: async (_, ctx) => {
    const { listSkills } = await skillsMod();
    const skills = listSkills();
    if (!skills.length) return ctx.print('No skills yet. Use /skills:create <name>');
    ctx.printPanel({
      title: 'Skills (~/.levi/SKILLS/)',
      fields: skills.map((s) => ({
        label: (s.disabled ? '❌ ' : '🟢 ') + s.name,
        value: `${s.title ? s.title + ' — ' : ''}${s.summary || 'No summary'} (${s.disabled ? 'disabled' : s.usedCount ? `active · used ${s.usedCount}x` : 'active'})`
      }))
    });
  }
});

defineCommand({
  name: 'skills:list',
  description: 'List all custom skills',
  run: async (_, ctx) => {
    const { listSkills } = await skillsMod();
    const skills = listSkills();
    if (!skills.length) return ctx.print('No skills yet. Use /skills:create <name>');
    ctx.printPanel({
      title: 'Skills (~/.levi/SKILLS/)',
      fields: skills.map((s) => ({
        label: (s.disabled ? '❌ ' : '🟢 ') + s.name,
        value: `${s.title ? s.title + ' — ' : ''}${s.summary || 'No summary'} (${s.disabled ? 'disabled' : s.usedCount ? `active · used ${s.usedCount}x` : 'active'})`
      }))
    });
  }
});

defineCommand({
  name: 'skills:create',
  description: 'Create a new skill in ~/.levi/SKILLS/',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const { createSkill } = await skillsMod();
    const res = await createSkill(name);
    if (!res.ok) return ctx.print(res.error);
    ctx.print(`Skill "${res.name}" created at ~/.levi/SKILLS/${res.name}.md.\nUse /skills:edit ${res.name} to write instructions.`);
  }
});

defineCommand({
  name: 'skills:edit',
  description: 'Open nano editor to write skill instructions and auto-summarize',
  args: [{ name: 'name', required: true }],
  screen: true,
  run: async ({ name }, ctx) => {
    const { editSkill } = await skillsMod();
    await editSkill(name, ctx);
  }
});

defineCommand({
  name: 'skills:delete',
  description: 'Permanently delete a skill',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const { deleteSkill } = await skillsMod();
    const res = deleteSkill(name);
    if (!res.ok) return ctx.print(res.error);
    ctx.print(`Skill "${res.name}" deleted.`);
  }
});

defineCommand({
  name: 'skills:disable',
  description: 'Disable a skill (excludes it from model context)',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const { disableSkill } = await skillsMod();
    const res = disableSkill(name);
    if (!res.ok) return ctx.print(res.error);
    ctx.print(`Skill "${res.name}" disabled. It will not be sent to the model context.`);
  }
});

defineCommand({
  name: 'skills:enable',
  description: 'Enable a skill (includes it in model context)',
  args: [{ name: 'name', required: true }],
  run: async ({ name }, ctx) => {
    const { enableSkill } = await skillsMod();
    const res = enableSkill(name);
    if (!res.ok) return ctx.print(res.error);
    ctx.print(`Skill "${res.name}" enabled. It will be sent to the model context.`);
  }
});

defineCommand({
  name: 'learn',
  description: 'Distill recent conversation actions into a reusable skill in ~/.levi/SKILLS/',
  args: [{ name: 'name', required: false, description: 'Optional custom skill slug name' }],
  run: async ({ name }, ctx) => {
    const { distillLastSessionSkill } = await import('../agent/skills.js');
    const { currentSessionId } = await import('../agent/session.js');
    const sid = currentSessionId();
    ctx.print('Analyzing recent actions and distilling reusable skill...');
    const res = await distillLastSessionSkill(sid, name);
    if (!res || !res.ok) {
      return ctx.print(res?.error || 'No sufficiently complex or reusable workflow found in recent messages to distill.');
    }
    if (ctx.printPanel) {
      return ctx.printPanel({
        title: `✦ Learned Skill: ${res.name}`,
        fields: [
          { label: 'Title', value: res.title, color: '#22d3ee' },
          { label: 'Trigger', value: res.summary, color: '#4ade80' },
          { label: 'File', value: `~/.levi/SKILLS/${res.name}.md`, color: '#c0caf5' },
          { label: 'Status', value: 'Active (automatically injected into context)', color: '#ffd700' }
        ]
      });
    }
    ctx.print(`✓ Learned skill "${res.name}" (${res.title}). Saved to ~/.levi/SKILLS/${res.name}.md.`);
  }
});

defineCommand({
  name: 'effort',
  description: 'Select reasoning effort: Eternal (low), Empyrean (medium), Abyssal (high), Seraphic (max)',
  args: [{ name: 'level', required: false, description: 'Optional effort name or level' }],
  run: async ({ level }, ctx) => {
    const { getEffort, setEffort, EFFORT_LIST } = await import('../agent/effort.js');
    if (level) {
      try {
        const set = setEffort(level);
        if (ctx.printPanel) {
          return ctx.printPanel({
            title: 'EFFORT ATTUNED',
            status: 'ACTIVE',
            fields: [
              { label: 'Mode', value: set.label, color: '#afd7ff' },
              { label: 'Pacing', value: set.pacing || 'Optimal', color: '#ffd700' },
              { label: 'Harmonics', value: set.description, color: '#ffffff' }
            ]
          });
        }
        return ctx.print(`Effort set to ${set.label} — ${set.description}`);
      } catch (e) {
        return ctx.print(`Error: ${e.message}`);
      }
    }
    if (ctx.openForm) {
      return ctx.openForm({ mode: 'effort' });
    }
    const cur = getEffort();
    ctx.print(`Current effort: ${cur.label}\n\nAvailable effort levels:\n` + EFFORT_LIST.map((e) => `• ${e.label} : ${e.description}`).join('\n'));
  }
});

