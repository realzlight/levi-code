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
  ctx = { shell, print: console.log, ...ctx };

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

defineCommand({ name: 'clear', description: 'Clear the screen', run: (_, ctx) => ctx.clear?.() });
defineCommand({ name: 'exit', description: 'Quit Levi', run: (_, ctx) => ctx.exit?.() });

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
defineCommand({ name: 'models:list', description: 'List your models' });
defineCommand({ name: 'models:create', description: 'Add a new model', args: [{ name: 'name' }] });
defineCommand({ name: 'models:edit', description: 'Edit a model', args: [{ name: 'name', required: true }] });
defineCommand({ name: 'models:use', description: 'Switch the active model', args: [{ name: 'name', required: true }] });
defineCommand({ name: 'models:delete', description: 'Delete a model', args: [{ name: 'name', required: true }] });
defineCommand({ name: 'whoami', description: 'Show who you are logged in as' });

defineCommand({
  name: 'logout',
  description: 'Sign out of GitHub and quit',
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
  await runCommand(input, { ...ctx, print: (t) => out.push(String(t)) });
  return out.join('\n');
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
    ctx.print(
      names
        .map((n) => `${c.active_model === n ? '★' : ' '} ${n} | ${c.models[n].sdk} | ${c.models[n].model}`)
        .join('\n')
    );
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
