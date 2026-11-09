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

defineCommand({
  name: 'cd',
  description: 'Change working directory',
  args: [{ name: 'path', required: false, rest: true }],
  run: async ({ path: targetPath }, ctx) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { refreshGitDiff } = await import('./Footer.js');

    const raw = (targetPath || '').trim();
    let dest = raw;
    if (!dest || dest === '~') {
      dest = os.homedir();
    } else if (dest.startsWith('~/')) {
      dest = path.join(os.homedir(), dest.slice(2));
    } else {
      dest = path.resolve(process.cwd(), dest);
    }

    try {
      if (!fs.existsSync(dest)) {
        return ctx.print(`Directory not found: ${dest}`);
      }
      const stat = fs.statSync(dest);
      if (!stat.isDirectory()) {
        return ctx.print(`Not a directory: ${dest}`);
      }
      process.chdir(dest);
      refreshGitDiff(true);
      ctx.print(`Changed directory to: ${dest}`);
    } catch (err) {
      ctx.print(`Failed to change directory: ${err.message}`);
    }
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
  await runCommand(input, {
    ...ctx,
    print: (t) => {
      out.push(String(t));
      if (ctx.onProgress) ctx.onProgress(String(t));
    },
    printPanel: (p) => { panel = p; }
  });
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
  name: 'models',
  description: 'View the complete walkthrough guide for Models and AI Providers (fullscreen, Esc to close)',
  run: async (_, ctx) => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const nodePath = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const guidePath = nodePath.resolve(nodePath.dirname(__filename), '../../MODELS-WALKTHROUGH.md');
    if (!existsSync(guidePath)) return ctx.print('MODELS-WALKTHROUGH.md not found at ' + guidePath);
    const content = readFileSync(guidePath, 'utf-8');
    if (ctx.openForm) {
      ctx.openForm({ mode: 'changelog', title: 'Models & Providers Walkthrough', content });
    } else {
      ctx.print(content);
    }
  }
});

defineCommand({
  name: 'model',
  description: 'View model walkthrough or status',
  run: async (_, ctx) => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const nodePath = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const guidePath = nodePath.resolve(nodePath.dirname(__filename), '../../MODELS-WALKTHROUGH.md');
    if (existsSync(guidePath) && ctx.openForm) {
      return ctx.openForm({ mode: 'changelog', title: 'Models & Providers Walkthrough', content: readFileSync(guidePath, 'utf-8') });
    }
    return runCommand('models:list', ctx);
  }
});

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

const runConfigCommand = async ({ key, value }, ctx) => {
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  const configPath = path.join(os.homedir(), '.levi', 'config.json');
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const writeConfig = (c) => fs.writeFileSync(configPath, JSON.stringify(c, null, 2) + '\n');
  const { getEffort, setEffort } = await import('../agent/effort.js');
  const { isSoloOnly, setSoloOnly, isDiaryEnabled, setDiaryEnabled } = await sessionMod();

  const k = String(key || '').toLowerCase().trim();
  const v = String(value || '').trim();

  if (k) {
    if (k === 'name' || k === 'alias' || k === 'user') {
      if (!v) return ctx.print('Usage: /config name <your-alias>');
      const c = readConfig();
      if (!c.auth) c.auth = {};
      if (!c.auth.user) c.auth.user = {};
      c.auth.user.name = v;
      writeConfig(c);
      return ctx.printPanel ? ctx.printPanel({
        title: 'User Alias Attuned',
        fields: [{ label: 'Alias', value: v, color: '#afd7ff' }]
      }) : ctx.print(`User alias set to: ${v}`);
    }

    if (k === 'effort') {
      if (!v) return ctx.print('Usage: /config effort <empyrean|oculus|abyssal|seraphic>');
      try {
        const eff = setEffort(v);
        return ctx.printPanel ? ctx.printPanel({
          title: 'Effort Attuned',
          fields: [
            { label: 'Effort', value: eff.label, color: '#ffd700' },
            { label: 'Pacing', value: eff.pacing, color: '#afd7ff' },
            { label: 'Role', value: eff.description, color: '#ffffff' }
          ]
        }) : ctx.print(`Effort set to: ${eff.label}`);
      } catch (e) {
        return ctx.print(`Error: ${e.message}`);
      }
    }

    if (k === 'model') {
      if (!v) return ctx.print('Usage: /config model <model-name>');
      const c = readConfig();
      c.active_model = v;
      writeConfig(c);
      return ctx.printPanel ? ctx.printPanel({
        title: 'Active Model Set',
        fields: [{ label: 'Model', value: v, color: '#afd7ff' }]
      }) : ctx.print(`Active model set to: ${v}`);
    }

    if (k === 'subagents' || k === 'subagent' || k === 'solo') {
      let next;
      const lower = v.toLowerCase();
      if (lower === 'on' || lower === 'enable' || lower === 'true') {
        next = setSoloOnly(false);
      } else if (lower === 'off' || lower === 'disable' || lower === 'false') {
        next = setSoloOnly(true);
      } else {
        next = setSoloOnly(!isSoloOnly());
      }
      return ctx.printPanel ? ctx.printPanel({
        title: 'Sub-agent Configuration',
        fields: [{ label: 'Status', value: !next ? 'ON — Sub-agents enabled' : 'OFF — Solo only (sub-agents disabled)', color: !next ? '#4ade80' : '#f87171' }]
      }) : ctx.print(`Sub-agents: ${!next ? 'ON' : 'OFF'}`);
    }

    if (k === 'diary') {
      let next;
      const lower = v.toLowerCase();
      if (lower === 'on' || lower === 'enable' || lower === 'true') {
        next = setDiaryEnabled(true);
      } else if (lower === 'off' || lower === 'disable' || lower === 'false') {
        next = setDiaryEnabled(false);
      } else {
        next = setDiaryEnabled(!isDiaryEnabled());
      }
      return ctx.printPanel ? ctx.printPanel({
        title: 'Diary Scratchpad',
        fields: [{ label: 'Status', value: next ? 'ON — Session diary enabled' : 'OFF — Diary tool disabled', color: next ? '#4ade80' : '#f87171' }]
      }) : ctx.print(`Diary: ${next ? 'ON' : 'OFF'}`);
    }

    if (k === 'threshold') {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1000) return ctx.print('Usage: /config threshold <tokens (min 1000)>');
      const c = readConfig();
      if (!c.compaction_threshold) c.compaction_threshold = {};
      c.compaction_threshold.threshold = n;
      writeConfig(c);
      return ctx.printPanel ? ctx.printPanel({
        title: 'Compaction Threshold Set',
        fields: [{ label: 'Threshold', value: `${n} tokens`, color: '#afd7ff' }]
      }) : ctx.print(`Threshold set to: ${n} tokens`);
    }
  }

  if (ctx.openForm) {
    return ctx.openForm({ mode: 'config' });
  }

  const c = readConfig();
  const curEffort = getEffort();
  const curSolo = isSoloOnly();
  const curDiary = isDiaryEnabled();
  ctx.printPanel({
    title: 'LEVI CONFIGURATION & SETTINGS',
    fields: [
      { label: 'Alias', value: c?.auth?.user?.name || '(not set)', color: '#afd7ff' },
      { label: 'Effort', value: curEffort.label, color: '#ffd700' },
      { label: 'Model', value: c.active_model || 'default', color: '#afd7ff' },
      { label: 'Sub-agents', value: curSolo ? 'OFF (Solo only)' : 'ON (Enabled)', color: curSolo ? '#f87171' : '#4ade80' },
      { label: 'Diary', value: curDiary ? 'ON' : 'OFF', color: curDiary ? '#4ade80' : '#f87171' },
      { label: 'Threshold', value: `${c?.compaction_threshold?.threshold || 6000} tokens`, color: '#c4c4c4' }
    ]
  });
};

defineCommand({
  name: 'config',
  description: 'View or update configuration settings (alias, effort, model, sub-agents, diary)',
  args: [
    { name: 'key', required: false, description: 'Setting key: name, effort, model, subagents, diary, threshold' },
    { name: 'value', required: false, description: 'Value to set' }
  ],
  run: runConfigCommand
});

defineCommand({
  name: 'settings',
  description: 'View or update configuration settings (alias, effort, model, sub-agents, diary)',
  args: [
    { name: 'key', required: false, description: 'Setting key: name, effort, model, subagents, diary, threshold' },
    { name: 'value', required: false, description: 'Value to set' }
  ],
  run: runConfigCommand
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
defineCommand({
  name: 'mcp',
  description: 'View the complete walkthrough guide for Model Context Protocol (fullscreen, Esc to close)',
  run: async (_, ctx) => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const nodePath = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const guidePath = nodePath.resolve(nodePath.dirname(__filename), '../../MCP-WALKTHROUGH.md');
    if (!existsSync(guidePath)) return ctx.print('MCP-WALKTHROUGH.md not found at ' + guidePath);
    const content = readFileSync(guidePath, 'utf-8');
    if (ctx.openForm) {
      ctx.openForm({ mode: 'changelog', title: 'MCP System Walkthrough', content });
    } else {
      ctx.print(content);
    }
  }
});

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
    ctx.openForm({ mode: 'changelog', title: 'Levi Changelog', content });
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
  description: 'View the complete walkthrough guide for the Levi Skill system (fullscreen, Esc to close)',
  run: async (_, ctx) => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const nodePath = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const guidePath = nodePath.resolve(nodePath.dirname(__filename), '../../SKILL-WALKTHROUGH.md');
    if (!existsSync(guidePath)) return ctx.print('SKILL-WALKTHROUGH.md not found at ' + guidePath);
    const content = readFileSync(guidePath, 'utf-8');
    if (ctx.openForm) {
      ctx.openForm({ mode: 'changelog', title: 'Skill System Walkthrough', content });
    } else {
      ctx.print(content);
    }
  }
});

defineCommand({
  name: 'skills:list',
  description: 'List all skill folders and skills within them',
  args: [{ name: 'folder', required: false, rest: true, description: 'Optional folder or subfolder to filter' }],
  run: async ({ folder }, ctx) => {
    const { listSkills } = await skillsMod();
    const filterFolder = Array.isArray(folder) ? folder.join('/') : (folder ? String(folder).trim() : null);
    const skills = listSkills(filterFolder);
    if (!skills.length) {
      return ctx.print(`No skills found${filterFolder ? ` in "${filterFolder}"` : ''}.\nUse /skills:create <folder> <filename> to create one.`);
    }

    const grouped = {};
    for (const s of skills) {
      const f = s.folder || 'GENERAL';
      if (!grouped[f]) grouped[f] = [];
      grouped[f].push(s);
    }

    const fields = [];
    for (const [fName, list] of Object.entries(grouped)) {
      fields.push({
        label: `📁 ${fName}`,
        value: `${list.length} skill${list.length === 1 ? '' : 's'}`
      });
      for (const s of list) {
        const icon = s.disabled ? '❌ ' : '🟢 ';
        fields.push({
          label: `   ${icon}${s.name}`,
          value: `${s.title ? s.title + ' — ' : ''}${s.summary || 'No summary'} (${s.disabled ? 'disabled' : s.usedCount ? `active · used ${s.usedCount}x` : 'active'}) [~/.levi/SKILLS/${s.relPath}]`
        });
      }
    }

    ctx.printPanel({
      title: `Skills Catalog (~/.levi/SKILLS/ — ${skills.length} skills across ${Object.keys(grouped).length} folders)`,
      fields
    });
  }
});

defineCommand({
  name: 'skills:folder',
  description: 'List all skill folders and nested subfolders',
  run: async (_, ctx) => {
    const { listSkillFolders } = await skillsMod();
    const folders = listSkillFolders();
    if (!folders.length) return ctx.print('No skill folders found. Use /skills:new <folder> to create one.');
    ctx.printPanel({
      title: `Skill Folders (~/.levi/SKILLS/ — ${folders.length} folders & subfolders)`,
      fields: folders.map((f) => ({
        label: `📁 ${f.name}`,
        value: `${f.count} direct skill${f.count === 1 ? '' : 's'}${f.totalCount !== f.count ? ` (${f.totalCount} total in subtree)` : ''} [~/.levi/SKILLS/${f.name}/]`
      }))
    });
  }
});

defineCommand({
  name: 'skills:folders',
  description: 'List all skill folders and nested subfolders',
  run: async (_, ctx) => {
    const { listSkillFolders } = await skillsMod();
    const folders = listSkillFolders();
    if (!folders.length) return ctx.print('No skill folders found. Use /skills:new <folder> to create one.');
    ctx.printPanel({
      title: `Skill Folders (~/.levi/SKILLS/ — ${folders.length} folders & subfolders)`,
      fields: folders.map((f) => ({
        label: `📁 ${f.name}`,
        value: `${f.count} direct skill${f.count === 1 ? '' : 's'}${f.totalCount !== f.count ? ` (${f.totalCount} total in subtree)` : ''} [~/.levi/SKILLS/${f.name}/]`
      }))
    });
  }
});

defineCommand({
  name: 'skills:new',
  description: 'Create a new skill folder or nested subfolder (e.g. /skills:new UI-UX-SKILLS/COMPONENTS)',
  args: [{ name: 'folder', required: true, rest: true, description: 'Folder or nested subfolder path' }],
  run: async ({ folder }, ctx) => {
    const { createSkillFolder } = await skillsMod();
    const rawParts = Array.isArray(folder) ? folder : String(folder || '').trim().split(/\s+/);
    const res = createSkillFolder(...rawParts);
    if (!res.ok) return ctx.print(res.error || 'Failed to create skill folder.');
    if (res.existing) {
      return ctx.print(`Folder "${res.folder}" already exists at ~/.levi/SKILLS/${res.folder}/.\nUse /skills:create ${res.folder} <filename> to add skills.`);
    }
    ctx.print(`✓ Skill folder "${res.folder}" created at ~/.levi/SKILLS/${res.folder}/.\nUse /skills:create ${res.folder} <filename> to add skills.`);
  }
});

defineCommand({
  name: 'skills:create',
  description: 'Create a new skill in a folder or subfolder (e.g. /skills:create UI-UX-SKILLS COMPONENTS button)',
  args: [{ name: 'parts', required: true, rest: true, description: '<folder> [subfolder...] <filename>' }],
  run: async ({ parts }, ctx) => {
    const { createSkill } = await skillsMod();
    const rawArgs = Array.isArray(parts) ? parts : String(parts || '').trim().split(/\s+/);
    const res = await createSkill(...rawArgs);
    if (!res.ok) return ctx.print(res.error);
    ctx.print(`✓ Skill "${res.id}" created at ~/.levi/SKILLS/${res.relPath}.\nUse /skills:edit ${res.id} to write instructions.`);
  }
});

defineCommand({
  name: 'skills:edit',
  description: 'Open editor to write skill instructions and auto-summarize (e.g. /skills:edit UI-UX-SKILLS/COMPONENTS/button)',
  args: [{ name: 'target', required: true, rest: true, description: 'Skill target path' }],
  screen: true,
  run: async ({ target }, ctx) => {
    const { editSkill } = await skillsMod();
    const rawArgs = Array.isArray(target) ? target : String(target || '').trim().split(/\s+/);
    await editSkill(rawArgs, ctx);
  }
});

defineCommand({
  name: 'skills:read',
  description: 'View instructions and content of a skill directly in the terminal',
  args: [{ name: 'target', required: true, rest: true, description: 'Skill target path' }],
  run: async ({ target }, ctx) => {
    const { readSkill } = await skillsMod();
    const rawArgs = Array.isArray(target) ? target : String(target || '').trim().split(/\s+/);
    const res = readSkill(...rawArgs);
    if (!res.ok) return ctx.print(`Error: ${res.error}`);
    ctx.print(`\n--- [Skill: ${res.id}] (${res.path}) ---\n\n${res.content}\n`);
  }
});

defineCommand({
  name: 'skills:show',
  description: 'View instructions and content of a skill directly in the terminal',
  args: [{ name: 'target', required: true, rest: true, description: 'Skill target path' }],
  run: async ({ target }, ctx) => {
    const { readSkill } = await skillsMod();
    const rawArgs = Array.isArray(target) ? target : String(target || '').trim().split(/\s+/);
    const res = readSkill(...rawArgs);
    if (!res.ok) return ctx.print(`Error: ${res.error}`);
    ctx.print(`\n--- [Skill: ${res.id}] (${res.path}) ---\n\n${res.content}\n`);
  }
});

defineCommand({
  name: 'skills:delete',
  description: 'Permanently delete a skill file or an entire skill folder branch',
  args: [{ name: 'target', required: true, rest: true, description: 'Skill file or folder path' }],
  run: async ({ target }, ctx) => {
    const { deleteSkill } = await skillsMod();
    const rawArgs = Array.isArray(target) ? target : String(target || '').trim().split(/\s+/);
    const res = deleteSkill(...rawArgs);
    if (!res.ok) return ctx.print(res.error);
    if (res.isFolder) {
      ctx.print(`✓ Skill folder "${res.id}" and all its subfolders/skills have been permanently deleted.`);
    } else {
      ctx.print(`✓ Skill "${res.id}" deleted.`);
    }
  }
});

defineCommand({
  name: 'skills:disable',
  description: 'Disable a skill or folder (excludes it from lazy-loaded context)',
  args: [{ name: 'target', required: true, rest: true, description: 'Skill or folder path' }],
  run: async ({ target }, ctx) => {
    const { disableSkill } = await skillsMod();
    const rawArgs = Array.isArray(target) ? target : String(target || '').trim().split(/\s+/);
    const res = disableSkill(...rawArgs);
    if (!res.ok) return ctx.print(res.error);
    if (res.isFolder) {
      ctx.print(`✓ Disabled ${res.count} skill(s) in folder "${res.id}". They will not be loaded into context.`);
    } else {
      ctx.print(`✓ Skill "${res.id}" disabled. It will not be loaded into context.`);
    }
  }
});

defineCommand({
  name: 'skills:enable',
  description: 'Enable a skill or folder (includes it in lazy-loaded context)',
  args: [{ name: 'target', required: true, rest: true, description: 'Skill or folder path' }],
  run: async ({ target }, ctx) => {
    const { enableSkill } = await skillsMod();
    const rawArgs = Array.isArray(target) ? target : String(target || '').trim().split(/\s+/);
    const res = enableSkill(...rawArgs);
    if (!res.ok) return ctx.print(res.error);
    if (res.isFolder) {
      ctx.print(`✓ Enabled ${res.count} skill(s) in folder "${res.id}".`);
    } else {
      ctx.print(`✓ Skill "${res.id}" enabled.`);
    }
  }
});

// ---- plugin commands ----
const pluginsMod = () => import('../agent/plugins.js');

defineCommand({
  name: 'plugin',
  description: 'View the complete walkthrough guide for the Levi Plugin system (fullscreen, Esc to close)',
  run: async (_, ctx) => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const nodePath = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const guidePath = nodePath.resolve(nodePath.dirname(__filename), '../../PLUGIN-WALKTHROUGH.md');
    if (!existsSync(guidePath)) return ctx.print('PLUGIN-WALKTHROUGH.md not found at ' + guidePath);
    const content = readFileSync(guidePath, 'utf-8');
    if (ctx.openForm) {
      ctx.openForm({ mode: 'changelog', title: 'Plugin System Walkthrough', content });
    } else {
      ctx.print(content);
    }
  }
});

defineCommand({
  name: 'plugins',
  description: 'View plugin catalog or walkthrough guide',
  run: async (_, ctx) => {
    const { listPlugins } = await pluginsMod();
    const plugins = listPlugins();
    if (!plugins.length) {
      const { readFileSync, existsSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const nodePath = await import('node:path');
      const __filename = fileURLToPath(import.meta.url);
      const guidePath = nodePath.resolve(nodePath.dirname(__filename), '../../PLUGIN-WALKTHROUGH.md');
      if (existsSync(guidePath) && ctx.openForm) {
        return ctx.openForm({ mode: 'changelog', title: 'Plugin System Walkthrough', content: readFileSync(guidePath, 'utf-8') });
      }
      return ctx.print('No community plugins installed.\nUse /plugin:install <git-url> to install one, or run /plugin to view the guide.');
    }
    return runCommand('plugin:list', ctx);
  }
});

// Shared install result panel renderer
function showInstallResult(res, ctx) {
  const fields = [
    { label: 'Name', value: res.name, color: '#38bdf8' },
    { label: 'Format', value: res.formatLabel || res.format || 'Levi', color: '#e879f9' },
    { label: 'Version', value: res.version, color: '#22d3ee' },
    { label: 'Author', value: res.author, color: '#c0caf5' },
    { label: 'Description', value: res.description || 'Community plugin', color: '#4ade80' },
    { label: 'Playbooks', value: `${res.filesCount} file(s) indexed`, color: '#ffd700' }
  ];
  if (res.agentsCount > 0) {
    fields.push({ label: 'Agents', value: `${res.agentsCount} custom agent(s) synced to ~/.levi/AGENTS/`, color: '#38bdf8' });
  }
  fields.push({ label: 'Location', value: `~/.levi/PLUGINS/${res.name}`, color: '#a78bfa' });

  if (ctx.printPanel) {
    return ctx.printPanel({
      title: `✦ Installed Plugin: ${res.name}`,
      fields
    });
  }
  const agentNote = res.agentsCount > 0 ? ` and ${res.agentsCount} custom agent(s) synced` : '';
  ctx.print(`✓ Installed plugin "${res.name}" [${res.formatLabel || res.format}] (v${res.version}) by ${res.author} with ${res.filesCount} playbook(s) indexed${agentNote} at ~/.levi/PLUGINS/${res.name}.`);
}

defineCommand({
  name: 'plugin:install',
  description: 'Install a community plugin from a Git repo — auto-detects Levi, Claude Code, Codex, Cursor, Windsurf, Copilot, Cline, Aider formats',
  args: [
    { name: 'url', required: true, description: 'Git repository URL' },
    { name: 'format', required: false, description: 'Optional format or plugin name (for marketplaces): e.g. levi, claude, or <plugin-name>' }
  ],
  run: async ({ url, format }, ctx) => {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) return ctx.print('Please provide a Git repository URL.');
    const { installPlugin, finalizeInstall, finalizeMarketplaceInstall } = await pluginsMod();

    ctx.print(`Cloning and detecting format from "${cleanUrl}"...`);
    const res = await installPlugin(cleanUrl, {
      onProgress: (msg) => ctx.print(msg),
      format: format ? String(format).trim() : null,
      pluginName: format ? String(format).trim() : null
    });

    // Marketplace repository with multiple plugins — prompt user to choose plugin!
    if (!res.ok && res.needsMarketplaceChoice) {
      const plugins = res.plugins;
      const mpName = res.marketplace?.name || res.repoBase;
      if (ctx.openForm) {
        const optionMap = new Map();
        const options = plugins.map((p) => {
          const optText = `📦 ${p.displayName || p.name}${p.description ? ` — ${p.description}` : ''}`;
          optionMap.set(optText, p);
          return optText;
        });

        return ctx.openForm({
          mode: 'plugin-marketplace',
          question: `Marketplace "${mpName}" contains multiple plugins. Which plugin would you like to install?`,
          options,
          onPick: async (pickedText) => {
            const picked = optionMap.get(pickedText) || plugins[0];
            ctx.print(`Installing "${picked.name}" from marketplace...`);
            const final = finalizeMarketplaceInstall(res.tempDir, res.repoUrl, res.repoBase, picked, (msg) => ctx.print(msg));
            if (!final.ok) return ctx.print(`❌ Installation failed: ${final.error}`);
            return showInstallResult(final, ctx);
          },
          onCancel: async () => {
            try {
              const { rmSync } = await import('node:fs');
              rmSync(res.tempDir, { recursive: true, force: true });
            } catch {}
            ctx.print('Marketplace installation cancelled.');
          }
        });
      }

      // Non-interactive / headless fallback
      const lines = [
        '',
        `  Marketplace "${mpName}" contains ${plugins.length} plugins:`,
        ''
      ];
      for (let i = 0; i < plugins.length; i++) {
        lines.push(`    📦  [${i + 1}] ${plugins[i].name}  —  ${plugins[i].description || plugins[i].source}`);
      }
      lines.push('');
      lines.push(`  Re-run specifying the plugin name:  /plugin:install ${cleanUrl} <plugin-name>`);
      lines.push(`  Available plugins: ${plugins.map(p => p.name).join(', ')}`);
      lines.push('');
      return ctx.print(lines.join('\n'));
    }

    // Multiple standalone manifests detected — prompt the user which one to use!
    if (!res.ok && res.needsChoice) {
      const fmts = res.formats;
      if (ctx.openForm) {
        const optionMap = new Map();
        const options = fmts.map((f) => {
          const optText = `${f.icon} ${f.label}${f.description ? ` — ${f.description}` : ''}`;
          optionMap.set(optText, f);
          return optText;
        });

        return ctx.openForm({
          mode: 'plugin-manifest',
          question: `Multiple manifests detected in ${res.repoBase}. Which manifest should Levi use?`,
          options,
          onPick: async (pickedText) => {
            const picked = optionMap.get(pickedText) || fmts[0];
            ctx.print(`Installing with ${picked.label}...`);
            const final = finalizeInstall(res.tempDir, res.repoUrl, res.repoBase, picked, (msg) => ctx.print(msg));
            if (!final.ok) return ctx.print(`❌ Installation failed: ${final.error}`);
            return showInstallResult(final, ctx);
          },
          onCancel: async () => {
            try {
              const { rmSync } = await import('node:fs');
              rmSync(res.tempDir, { recursive: true, force: true });
            } catch {}
            ctx.print('Plugin installation cancelled.');
          }
        });
      }

      // Non-interactive / headless fallback
      const lines = [
        '',
        `  Multiple manifests detected in ${res.repoBase}:`,
        ''
      ];
      for (let i = 0; i < fmts.length; i++) {
        lines.push(`    ${fmts[i].icon}  [${i + 1}] ${fmts[i].label}  —  ${fmts[i].description}`);
      }
      lines.push('');
      lines.push(`  Re-run with your choice:  /plugin:install ${cleanUrl} <format>`);
      lines.push(`  Available options: ${fmts.map(f => f.id).join(', ')}`);
      lines.push('');
      return ctx.print(lines.join('\n'));
    }

    if (!res.ok) {
      return ctx.print(`❌ Plugin installation failed: ${res.error}`);
    }

    showInstallResult(res, ctx);
  }
});

defineCommand({
  name: 'plugins:install',
  description: 'Alias for /plugin:install',
  args: [
    { name: 'url', required: true, description: 'Git repository URL' },
    { name: 'format', required: false, description: 'Optional format: levi, claude, codex, cursor, windsurf, copilot, cline, aider' }
  ],
  run: async (args, ctx) => runCommand(`plugin:install ${args.url}${args.format ? ' ' + args.format : ''}`, ctx)
});

defineCommand({
  name: 'plugin:list',
  description: 'List all installed community plugins and their playbooks',
  run: async (_, ctx) => {
    const { listPlugins } = await pluginsMod();
    const plugins = listPlugins();
    if (!plugins.length) {
      return ctx.print('No community plugins installed.\nUse /plugin:install <git-url> to install one, or run /plugin to view the guide.');
    }

    const fields = [];
    const FMT_ICONS = { levi: '🔷', claude: '🟠', codex: '🟢', cursor: '🟣', windsurf: '🔵', copilot: '⚫', cline: '🟡', aider: '🟤', generic: '📄' };
    for (const p of plugins) {
      const fmtIcon = FMT_ICONS[p.format] || '📦';
      const fmtLabel = p.format ? ` [${p.format}]` : '';
      fields.push({
        label: `${fmtIcon} ${p.name} (v${p.version})${fmtLabel}`,
        value: `${p.description ? p.description + ' — ' : ''}by ${p.author || 'Unknown'} [${p.filesCount || 0} playbook(s)]`
      });
      if (Array.isArray(p.files)) {
        for (const f of p.files) {
          fields.push({
            label: `   ⚡ ${f.id}`,
            value: `${f.title ? f.title + ' — ' : ''}${f.summary || 'Playbook'} [~/.levi/PLUGINS/${f.relPath}]`
          });
        }
      }
    }

    if (ctx.printPanel) {
      return ctx.printPanel({
        title: `Plugins Catalog (~/.levi/PLUGINS/ — ${plugins.length} plugin(s))`,
        status: 'CATALOG',
        fields
      });
    }

    const lines = [`Plugins Catalog (~/.levi/PLUGINS/ — ${plugins.length} plugin(s)):`];
    for (const f of fields) {
      lines.push(`${f.label}: ${f.value}`);
    }
    ctx.print(lines.join('\n'));
  }
});

defineCommand({
  name: 'plugins:list',
  description: 'Alias for /plugin:list',
  run: async (_, ctx) => runCommand('plugin:list', ctx)
});

defineCommand({
  name: 'plugin:update',
  description: 'Update installed plugin(s) via git pull (e.g. /plugin:update [name])',
  args: [{ name: 'name', required: false, description: 'Optional plugin name to update (or all)' }],
  run: async ({ name }, ctx) => {
    const { updatePlugin, listPlugins } = await pluginsMod();
    const target = name ? String(name).trim() : null;

    if (target) {
      ctx.print(`Updating plugin "${target}"...`);
      const res = await updatePlugin(target, { onProgress: (m) => ctx.print(m) });
      if (!res.ok) return ctx.print(`❌ Update failed: ${res.error}`);
      if (ctx.printPanel) {
        return ctx.printPanel({
          title: `Plugin Updated: ${res.name}`,
          status: 'UPDATED',
          fields: [
            { label: 'Plugin', value: res.name, color: '#38bdf8' },
            { label: 'Version', value: `v${res.version}`, color: '#22d3ee' },
            { label: 'Playbooks', value: `${res.filesCount} file(s) synced`, color: '#4ade80' },
            { label: 'Status', value: 'Git pull complete & search index synced', color: '#4ade80' }
          ]
        });
      }
      return ctx.print(`✓ Updated "${res.name}" (v${res.version}) — ${res.filesCount} playbook(s) synced.`);
    }

    const plugins = listPlugins();
    if (!plugins.length) return ctx.print('No plugins installed to update.');
    ctx.print(`Updating ${plugins.length} plugin(s)...`);
    const results = [];
    for (const p of plugins) {
      const res = await updatePlugin(p.name);
      results.push({ name: p.name, ok: res.ok, version: res.version, filesCount: res.filesCount, error: res.error });
      if (res.ok) {
        ctx.print(`✓ ${p.name}: updated (v${res.version}, ${res.filesCount} playbooks)`);
      } else {
        ctx.print(`❌ ${p.name}: ${res.error}`);
      }
    }
    if (ctx.printPanel) {
      return ctx.printPanel({
        title: `All Plugins Updated (${plugins.length})`,
        status: 'UPDATED',
        fields: results.map((r) => ({
          label: r.name,
          value: r.ok ? `v${r.version} (${r.filesCount} playbooks synced)` : `Error: ${r.error}`,
          color: r.ok ? '#4ade80' : '#f87171'
        }))
      });
    }
  }
});

defineCommand({
  name: 'plugins:update',
  description: 'Alias for /plugin:update',
  args: [{ name: 'name', required: false, description: 'Optional plugin name' }],
  run: async ({ name }, ctx) => runCommand(`plugin:update ${name || ''}`, ctx)
});

defineCommand({
  name: 'plugin:remove',
  description: 'Remove an installed plugin from ~/.levi/PLUGINS/ and unindex it',
  args: [{ name: 'name', required: true, description: 'Plugin name to remove' }],
  run: async ({ name }, ctx) => {
    const target = String(name || '').trim();
    if (!target) return ctx.print('Please specify the plugin name to remove.');
    const { removePlugin } = await pluginsMod();
    const res = removePlugin(target);
    if (!res.ok) return ctx.print(`❌ Failed to remove: ${res.error}`);
    import('../agent/retrieval.js').then(({ retrieve }) => {
      retrieve({ query: 'sync', limit: 1, rebuild: false }).catch(() => {});
    }).catch(() => {});

    if (ctx.printPanel) {
      return ctx.printPanel({
        title: `Plugin Uninstalled`,
        status: 'REMOVED',
        fields: [
          { label: 'Plugin', value: res.name, color: '#f87171' },
          { label: 'Location', value: `~/.levi/PLUGINS/${res.name}`, color: '#94a3b8' },
          { label: 'Disk', value: 'Deleted from ~/.levi/PLUGINS/', color: '#f87171' },
          { label: 'Memory', value: 'Unindexed from hybrid retrieval database', color: '#4ade80' }
        ]
      });
    }
    ctx.print(`✓ Removed plugin "${res.name}" from ~/.levi/PLUGINS/ and unindexed all playbooks.`);
  }
});

defineCommand({
  name: 'plugin:delete',
  description: 'Alias for /plugin:remove',
  args: [{ name: 'name', required: true, description: 'Plugin name to delete' }],
  run: async ({ name }, ctx) => runCommand(`plugin:remove ${name}`, ctx)
});

defineCommand({
  name: 'plugin:init',
  description: 'Scaffold a new plugin manifest (.levi-plugin/plugin.json or marketplace.json) in current directory',
  args: [
    { name: 'name', required: false, description: 'Plugin or marketplace name' },
    { name: 'type', required: false, description: 'Type: "plugin" (default) or "marketplace"' }
  ],
  run: async ({ name, type }, ctx) => {
    const { createPluginManifest, createMarketplaceManifest } = await pluginsMod();
    const { existsSync, mkdirSync } = await import('node:fs');
    const nodePath = await import('node:path');
    const isMarketplace = String(type || '').toLowerCase() === 'marketplace' || String(name || '').toLowerCase() === 'marketplace';
    const targetDir = process.cwd();

    if (isMarketplace) {
      const res = createMarketplaceManifest(targetDir, { name: name && name !== 'marketplace' ? name : undefined });
      ctx.print(`✓ Created marketplace manifest at ${res.path}`);
      return ctx.print(`Edit .levi-plugin/marketplace.json to register your plugins and their subfolder sources.`);
    }

    const res = createPluginManifest(targetDir, { name });
    const skillsDir = nodePath.join(targetDir, 'skills');
    if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
    ctx.print(`✓ Created plugin manifest at ${res.path}`);
    ctx.print(`Place your markdown playbooks into ./skills/ or ./rules/ and share your repo!`);
  }
});

defineCommand({
  name: 'agents',
  description: 'Alias for /agent:list',
  run: async (_, ctx) => runCommand('agent:list', ctx)
});

defineCommand({
  name: 'agent:list',
  description: 'List all custom sub-agents available in ~/.levi/AGENTS/',
  run: async (_, ctx) => {
    const { listCustomAgents } = await import('../agent/custom-agents.js');
    const agents = listCustomAgents();
    if (!agents.length) {
      return ctx.print('No custom sub-agents found in ~/.levi/AGENTS/.\nUse /agent:create <name> to create one, or install a plugin containing agents.');
    }

    if (ctx.printPanel) {
      return ctx.printPanel({
        title: `Custom Sub-Agents (${agents.length})`,
        fields: agents.map((a) => ({
          label: `@${a.name}`,
          value: `${a.description} [dim](~/.levi/AGENTS/${a.name}.md)[/dim]`,
          color: '#38bdf8'
        }))
      });
    }

    const lines = ['', `  Available custom sub-agents (${agents.length}):`, ''];
    for (const a of agents) {
      lines.push(`    🤖 @${a.name} — ${a.description}`);
      lines.push(`       File: ~/.levi/AGENTS/${a.name}.md`);
    }
    lines.push('');
    return ctx.print(lines.join('\n'));
  }
});

defineCommand({
  name: 'agent:create',
  description: 'Create a custom sub-agent in ~/.levi/AGENTS/<name>.md',
  args: [
    { name: 'name', required: true, description: 'Agent name (e.g. bug-hunter)' },
    { name: 'description', required: false, description: 'Description of what this agent does' }
  ],
  run: async ({ name, description }, ctx) => {
    const { saveCustomAgent, getCustomAgent } = await import('../agent/custom-agents.js');
    const existing = getCustomAgent(name);
    if (existing) {
      return ctx.print(`Agent "${name}" already exists at ~/.levi/AGENTS/${existing.name}.md. Use /agent:view ${name} or edit it directly.`);
    }

    const desc = description ? String(description).trim() : `Custom sub-agent specialized for ${name}`;
    const defaultPrompt = `You are ${name}, a professional sub-agent specialized in ${desc}.\n\nWhen assigned a task by lead orchestrator Levi:\n1. Execute the work directly using your tools.\n2. Verify all modifications.\n3. Report back with a concise factual summary of changes and results.`;

    const res = saveCustomAgent(name, {
      description: desc,
      systemPrompt: defaultPrompt
    });

    if (!res.ok) {
      return ctx.print(`❌ Failed to create agent: ${res.error}`);
    }

    if (ctx.printPanel) {
      return ctx.printPanel({
        title: `✦ Created Custom Agent: @${res.name}`,
        fields: [
          { label: 'Name', value: `@${res.name}`, color: '#38bdf8' },
          { label: 'Description', value: res.description, color: '#4ade80' },
          { label: 'Tools', value: 'Full tool access', color: '#22d3ee' },
          { label: 'File', value: `~/.levi/AGENTS/${res.name}.md`, color: '#a78bfa' }
        ]
      });
    }

    ctx.print(`✓ Created custom agent "@${res.name}" at ~/.levi/AGENTS/${res.name}.md.`);
    ctx.print(`Levi will automatically orchestrate and delegate matching tasks to @${res.name}.`);
  }
});

defineCommand({
  name: 'agent:view',
  description: 'View custom agent definition and instructions from ~/.levi/AGENTS/<name>.md',
  args: [{ name: 'name', required: true, description: 'Agent name to inspect' }],
  run: async ({ name }, ctx) => {
    const { getCustomAgent } = await import('../agent/custom-agents.js');
    const agent = getCustomAgent(name);
    if (!agent) {
      return ctx.print(`Agent "${name}" not found in ~/.levi/AGENTS/. Use /agent:list to view available agents.`);
    }

    if (ctx.printPanel) {
      return ctx.printPanel({
        title: `🤖 Sub-Agent: @${agent.name}`,
        fields: [
          { label: 'Name', value: `@${agent.name}`, color: '#38bdf8' },
          { label: 'Description', value: agent.description, color: '#4ade80' },
          { label: 'File', value: `~/.levi/AGENTS/${agent.name}.md`, color: '#a78bfa' },
          { label: 'Instructions', value: agent.systemPrompt.slice(0, 300) + (agent.systemPrompt.length > 300 ? '...' : ''), color: '#c0caf5' }
        ]
      });
    }

    const lines = [
      '',
      `  🤖 @${agent.name}`,
      `  Description: ${agent.description}`,
      `  Location:    ~/.levi/AGENTS/${agent.name}.md`,
      '',
      '  --- System Prompt ---',
      agent.systemPrompt.split('\n').map((l) => '  ' + l).join('\n'),
      ''
    ];
    ctx.print(lines.join('\n'));
  }
});

defineCommand({
  name: 'agent:delete',
  description: 'Delete a custom sub-agent from ~/.levi/AGENTS/<name>.md',
  args: [{ name: 'name', required: true, description: 'Agent name to delete' }],
  run: async ({ name }, ctx) => {
    const { deleteCustomAgent } = await import('../agent/custom-agents.js');
    const res = deleteCustomAgent(name);
    if (!res.ok) {
      return ctx.print(`❌ ${res.error}`);
    }
    ctx.print(`✓ Deleted custom agent "@${res.name}" from ~/.levi/AGENTS/.`);
  }
});


defineCommand({
  name: 'learn',
  description: 'Distill recent conversation actions into a reusable skill in ~/.levi/SKILLS/<folder>/<file>.md',
  args: [{ name: 'target', required: false, rest: true, description: 'Optional folder/name (e.g. UI-UX-SKILLS/ui or folder)' }],
  run: async ({ target }, ctx) => {
    const { distillLastSessionSkill } = await import('../agent/skills.js');
    const { currentSessionId } = await import('../agent/session.js');
    const sid = currentSessionId();
    const rawTarget = Array.isArray(target) ? target.join('/') : (target ? String(target).trim() : null);
    ctx.print('Analyzing recent actions and distilling reusable skill...');
    const res = await distillLastSessionSkill(sid, rawTarget);
    if (!res || !res.ok) {
      return ctx.print(res?.error || 'No sufficiently complex or reusable workflow found in recent messages to distill.');
    }
    if (ctx.printPanel) {
      return ctx.printPanel({
        title: `✦ Learned Skill: ${res.id}`,
        fields: [
          { label: 'Folder', value: res.folder, color: '#38bdf8' },
          { label: 'Title', value: res.title, color: '#22d3ee' },
          { label: 'Trigger', value: res.summary, color: '#4ade80' },
          { label: 'File', value: `~/.levi/SKILLS/${res.relPath}`, color: '#c0caf5' },
          { label: 'Status', value: 'Active (lazy-loaded in context)', color: '#ffd700' }
        ]
      });
    }
    ctx.print(`✓ Learned skill "${res.id}" (${res.title}). Saved to ~/.levi/SKILLS/${res.relPath}.`);
  }
});

defineCommand({
  name: 'effort',
  description: 'Select reasoning effort: Empyrean (low), Oculus (medium), Abyssal (high), Seraphic (max)',
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

defineCommand({
  name: 'undo',
  description: 'Undo and roll back file changes made in the last turn',
  run: async (_, ctx) => {
    const { undoLastTurn } = await import('../agent/undo.js');
    const { currentSessionId } = await import('../agent/session.js');
    const sid = currentSessionId();
    const res = undoLastTurn(sid);
    if (!res.ok) {
      return ctx.print(`[Undo] ${res.error}`);
    }
    if (ctx.printPanel) {
      return ctx.printPanel({
        title: 'TURN UNDO COMPLETE',
        status: 'RESTORED',
        fields: [
          { label: 'Timestamp', value: res.timestamp || 'just now', color: '#afd7ff' },
          { label: 'Reverted Files', value: res.reverted.map(r => `• ${r.path} (${r.action})`).join('\n') || 'None', color: '#4ade80' }
        ]
      });
    }
    ctx.print(`✓ Reverted ${res.reverted.length} file(s):\n` + res.reverted.map(r => `• ${r.path} (${r.action})`).join('\n'));
  }
});

defineCommand({
  name: 'diff',
  description: 'Open interactive fullscreen diff reviewer for git changes',
  run: async (_, ctx) => {
    const { shell } = await import('./commands.js');
    const res = await shell('git diff HEAD');
    const diffText = res.output?.trim();
    if (!diffText) {
      return ctx.print('Working tree clean — no uncommitted changes found.');
    }
    if (ctx.openForm) {
      return ctx.openForm({ mode: 'diff', diffText });
    }
    ctx.print(diffText);
  }
});

defineCommand({
  name: 'commit',
  description: 'Analyze git diff, generate conventional commit message, and commit (use --push to push)',
  args: [
    { name: 'flag', required: false, description: 'Pass --push or push to automatically push to remote' },
    { name: 'message', required: false, description: 'Optional explicit commit message' }
  ],
  run: async ({ flag, message }, ctx) => {
    const { shell } = await import('./commands.js');
    const shouldPush = flag === '--push' || flag === 'push';

    // Check git status
    const st = await shell('git status --porcelain');
    if (!st.output?.trim()) {
      return ctx.print('Working tree clean — nothing to commit.');
    }

    let commitMsg = message;
    if (!commitMsg) {
      ctx.print('Analyzing git changes and crafting conventional commit message...');
      const diffRes = await shell('git diff HEAD');
      const diffSnippet = (diffRes.output || st.output).slice(0, 4000);
      try {
        const { chat } = await import('../agent/client.js');
        const prompt = `Based on this git diff / status, generate a single-line conventional commit message (e.g. feat(scope): message, fix(scope): message, refactor: message). Output ONLY the commit message line, no backticks, no markdown, no quotes:\n\n${diffSnippet}`;
        const res = await chat([{ role: 'user', content: prompt }], { maxTokens: 60 });
        commitMsg = res.text?.trim().replace(/^["'`]|["'`]$/g, '').split('\n')[0];
      } catch {}
      if (!commitMsg) commitMsg = 'chore: update project files';
    }

    await shell('git add -A');
    const commitRes = await shell(`git commit -m ${JSON.stringify(commitMsg)}`);
    if (commitRes.code !== 0) {
      return ctx.print(`Commit failed:\n${commitRes.output}`);
    }

    let pushInfo = '';
    if (shouldPush) {
      ctx.print('Pushing to remote...');
      const pushRes = await shell('git push');
      pushInfo = pushRes.code === 0 ? 'Pushed to origin' : `Push warning: ${pushRes.output}`;
    }

    if (ctx.printPanel) {
      return ctx.printPanel({
        title: 'GIT COMMIT RECORDED',
        status: 'COMMITTED',
        fields: [
          { label: 'Message', value: commitMsg, color: '#afd7ff' },
          { label: 'Push', value: shouldPush ? pushInfo : 'No (run git push or /commit --push)', color: shouldPush ? '#4ade80' : '#777777' }
        ]
      });
    }
    ctx.print(`✓ Committed: ${commitMsg} ${shouldPush ? '(' + pushInfo + ')' : ''}`);
  }
});

defineCommand({
  name: 'bg',
  description: 'Manage background processes: /bg, /bg logs <pid>, /bg kill <pid>, /bg clear',
  args: [
    { name: 'action', required: false, description: 'Action: list, logs, kill, or clear' },
    { name: 'target', required: false, description: 'Target PID or line count' }
  ],
  run: async ({ action, target }, ctx) => {
    const fs = (await import('node:fs')).default;
    const path = (await import('node:path')).default;
    const os = (await import('node:os')).default;
    const procsFile = path.join(os.homedir(), '.levi', 'processes.json');

    let procs = [];
    try { procs = JSON.parse(fs.readFileSync(procsFile, 'utf-8')); } catch {}

    const act = (action || 'list').toLowerCase();

    if (act === 'list' || (!action && !target)) {
      if (!procs.length) return ctx.print('No background processes registered in ~/.levi/processes.json');
      const lines = procs.map(p => {
        let isAlive = false;
        try { process.kill(p.pid, 0); isAlive = true; } catch {}
        const status = isAlive ? 'RUNNING' : 'STOPPED';
        return `• PID ${p.pid} [${status}] — ${p.cmd}\n  Started: ${p.at} | Log: ${p.log || 'none'}`;
      });
      if (ctx.printPanel) {
        return ctx.printPanel({
          title: 'BACKGROUND PROCESSES',
          status: `${procs.length} REGISTERED`,
          fields: procs.map(p => {
            let isAlive = false;
            try { process.kill(p.pid, 0); isAlive = true; } catch {}
            return {
              label: `PID ${p.pid}`,
              value: `[${isAlive ? 'RUNNING' : 'EXITED'}] ${p.cmd}\nLog: ${p.log || 'n/a'}`,
              color: isAlive ? '#4ade80' : '#777777'
            };
          })
        });
      }
      return ctx.print(lines.join('\n\n'));
    }

    if (act === 'logs' || act === 'log') {
      const pid = parseInt(target, 10);
      const proc = procs.find(p => p.pid === pid) || procs[procs.length - 1];
      if (!proc) return ctx.print(`Process with PID ${target} not found.`);
      const logFile = proc.log || path.join(os.homedir(), '.levi', 'processes', `process-${proc.pid}.log`);
      if (!fs.existsSync(logFile)) return ctx.print(`Log file ${logFile} does not exist.`);
      const content = fs.readFileSync(logFile, 'utf-8');
      const tail = content.split('\n').slice(-35).join('\n');
      return ctx.print(`[Logs for PID ${proc.pid} (${proc.cmd})]:\n${tail || '(empty log)'}`);
    }

    if (act === 'kill' || act === 'stop') {
      const pid = parseInt(target, 10);
      if (!pid) return ctx.print('Please specify a PID to kill: /bg kill <pid>');
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      procs = procs.filter(p => p.pid !== pid);
      try { fs.writeFileSync(procsFile, JSON.stringify(procs, null, 2)); } catch {}
      return ctx.print(`✓ Sent termination signal to PID ${pid}`);
    }

    if (act === 'clear') {
      procs = procs.filter(p => {
        try { process.kill(p.pid, 0); return true; } catch { return false; }
      });
      try { fs.writeFileSync(procsFile, JSON.stringify(procs, null, 2)); } catch {}
      return ctx.print(`✓ Cleared exited processes. ${procs.length} active process(es) remaining.`);
    }

    ctx.print(`Unknown action: ${act}. Usage: /bg [list|logs <pid>|kill <pid>|clear]`);
  }
});

defineCommand({
  name: 'find',
  description: 'Fuzzy search and select project files to inject into prompt',
  args: [{ name: 'query', required: false, description: 'Optional initial file search query' }],
  run: async ({ query }, ctx) => {
    if (ctx.openForm) {
      return ctx.openForm({ mode: 'find', query: query || '' });
    }
    const { execSync } = await import('node:child_process');
    try {
      const out = execSync(`find . -maxdepth 3 -not -path '*/.*' | head -30`, { encoding: 'utf-8' });
      ctx.print(out);
    } catch (e) {
      ctx.print(`Error listing files: ${e.message}`);
    }
  }
});


