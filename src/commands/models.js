import * as p from '@clack/prompts';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.levi', 'config.json');

const cyan = chalk.hex('#22d3ee');
const moon = chalk.hex('#e8e8e8');
const dim = chalk.hex('#666666');
const badge = cyan.bold('LEVI');

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  groq: 'https://api.groq.com/openai/v1',
  ollama: 'http://localhost:11434/v1'
};

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function nameTaken(models, n, except) {
  return Object.keys(models).some(
    k => k !== except && k.toLowerCase() === n.trim().toLowerCase()
  );
}

const bail = () => { p.cancel(dim('Cancelled')); console.log(); };

export async function createModel() {
  const config = readConfig();
  if (!config.models) config.models = {};

  console.log();
  p.intro(`${badge} ${dim('new model')}`);

  const name = await p.text({
    message: 'Name',
    placeholder: 'Astra',
    validate: v => {
      if (!v || !v.trim()) return 'Name required';
      if (nameTaken(config.models, v)) return `"${v.trim()}" already exists. Use levi models:edit ${v.trim()}`;
    }
  });
  if (p.isCancel(name)) return bail();

  const sdk = await p.select({
    message: 'SDK',
    options: [
      { value: 'openai', label: 'openai', hint: 'all OpenAI compatible' },
      { value: 'anthropic', label: 'anthropic' }
    ]
  });
  if (p.isCancel(sdk)) return bail();

  const api_key = await p.password({
    message: 'API key',
    validate: v => (!v ? 'API key required' : undefined)
  });
  if (p.isCancel(api_key)) return bail();

  const model = await p.text({
    message: 'Model name',
    placeholder: sdk === 'anthropic' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o',
    validate: v => (!v ? 'Model required' : undefined)
  });
  if (p.isCancel(model)) return bail();

  const base_url = await p.text({
    message: 'Base URL',
    placeholder: `${DEFAULT_BASE_URLS[sdk]} ${dim('(empty = default)')}`
  });
  if (p.isCancel(base_url)) return bail();

  config.models[name.trim()] = {
    sdk,
    api_key,
    model,
    base_url: (base_url || '').trim() || DEFAULT_BASE_URLS[sdk]
  };

  writeConfig(config);
  p.outro(`${cyan('✦')} Model ${cyan.bold(name.trim())} created`);
  console.log();
}

export async function editModel(name) {
  const config = readConfig();
  const models = config.models || {};
  const current = models[name];

  if (!current) return p.log.error(chalk.red(`Model "${name}" not found`));

  console.log();
  p.intro(`${badge} ${dim('edit')} ${moon.bold(name)}`);
  p.log.message(dim('Leave empty to keep the current value'));

  const newName = await p.text({
    message: 'Name',
    placeholder: name,
    validate: v => {
      const n = (v || '').trim();
      if (n && nameTaken(models, n, name)) return `"${n}" already exists`;
    }
  });
  if (p.isCancel(newName)) return bail();

  const sdk = await p.select({
    message: 'SDK',
    initialValue: current.sdk,
    options: [
      { value: 'openai', label: 'openai', hint: 'all OpenAI compatible' },
      { value: 'anthropic', label: 'anthropic' }
    ]
  });
  if (p.isCancel(sdk)) return bail();

  const api_key = await p.password({ message: 'API key (empty = keep)' });
  if (p.isCancel(api_key)) return bail();

  const model = await p.text({ message: 'Model name', placeholder: current.model });
  if (p.isCancel(model)) return bail();

  const base_url = await p.text({ message: 'Base URL', placeholder: current.base_url });
  if (p.isCancel(base_url)) return bail();

  const finalName = (newName || '').trim() || name;
  const sdkChanged = sdk !== current.sdk;

  const updated = {
    sdk,
    api_key: api_key || current.api_key,
    model: (model || '').trim() || current.model,
    base_url: (base_url || '').trim() || (sdkChanged ? DEFAULT_BASE_URLS[sdk] : current.base_url)
  };

  if (finalName !== name) {
    delete config.models[name];
    if (config.active_model === name) config.active_model = finalName;
  }
  config.models[finalName] = updated;

  writeConfig(config);
  p.outro(`${cyan('✦')} Model ${cyan.bold(finalName)} updated`);
  console.log();
}

export function listModels() {
  const config = readConfig();
  const models = config.models || {};

  if (Object.keys(models).length === 0) {
    return p.log.info(`No models yet. Run ${cyan('levi models create')}`);
  }

  const lines = Object.entries(models).map(([name, m]) => {
    const active = config.active_model === name ? cyan('★') : dim('·');
    const label = config.active_model === name ? cyan.bold(name) : moon(name);
    return `${active} ${label} ${dim('|')} ${m.sdk} ${dim('|')} ${dim(m.model)}`;
  });

  p.note(lines.join('\n'), cyan('☾ Models'));
}

export function selectModel(name) {
  const config = readConfig();
  if (!config.models?.[name]) {
    return p.log.error(chalk.red(`Model "${name}" not found`));
  }
  config.active_model = name;
  writeConfig(config);
  p.log.success(`${cyan('☾')} Switched to ${cyan.bold(name)}`);
}

export function deleteModel(name) {
  const config = readConfig();
  if (!config.models?.[name]) {
    return p.log.error(chalk.red(`Model "${name}" not found`));
  }
  delete config.models[name];
  if (config.active_model === name) config.active_model = null;
  writeConfig(config);
  p.log.success(`Deleted ${cyan.bold(name)}`);
}
