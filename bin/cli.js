#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.levi', 'config.json');
function getAuth() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).auth; }
  catch { return { loggedIn: false }; }
}

const program = new Command();
program.name('levi');

program.command('models:create').argument('[name]').action(async (name) => {
  const { createModel } = await import('../src/commands/models.js');
  await createModel(name);
});
program.command('models:edit').argument('<name>').action(async (name) => {
  const { editModel } = await import('../src/commands/models.js');
  await editModel(name);
});
program.command('models:list').action(async () => {
  const { listModels } = await import('../src/commands/models.js');
  await listModels();
});
program.command('models:use').argument('<name>').action(async (name) => {
  const { selectModel } = await import('../src/commands/models.js');
  await selectModel(name);
});
program.command('models:delete').argument('<name>').action(async (name) => {
  const { deleteModel } = await import('../src/commands/models.js');
  await deleteModel(name);
});
program.command('login').action(async () => {
  const { login } = await import('../src/commands/auth.js');
  await login();
});
program.command('logout').action(async () => {
  const { logout } = await import('../src/commands/auth.js');
  await logout();
});
program.command('whoami').action(async () => {
  const { whoami } = await import('../src/commands/auth.js');
  await whoami();
});

program.action(async () => {
  const auth = getAuth();
  if (!auth?.loggedIn) {
    await import('../src/ui/welcome.js');
  } else {
    await import('../src/ui/index.js');
  }
});

program.parse();
