import React from 'react';
import { render, Box, Text } from 'ink';
import terminalImage from 'terminal-image';
import { execaSync } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { login } from '../commands/auth.js';
const h = React.createElement;

const CYAN = '#22d3ee';
const STAR = '#aaaaaa';
const MOON_COLOR = '#e8e8e8';
const CLOUD_COLOR = '#666666';
const BORDER = '#fff';

const WIDTH = 60;
const SKY_HEIGHT = 6;

const MOON = [
  ' ░▓▓▓███░',
  '▓███  ██▓░',
  '███    ░░',
  '███    ░░',
  '▓███  ██▓░',
  ' ░▓████▓░'
];

const CLOUD = [
  '  ▒▒▒▒      ',
  ' ▒▒▒▒▒▒▒▒   ',
  '▒▒▒▒▒▒▒▒▒▒▒▒'
];

const CLOUD2 = [
  '  ▒▒       ▒▒▒▒      ',
  ' ▒▒▒▒   ▒▒▒▒▒▒▒▒   ',
  '▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒'
];
const STARS = [
  [1, 10],  // top left
  [1, 39],  // top right
  [3, 30],  // middle
  [4, 2],   // left edge mid
  [5, 24],  // ground - near mascot
  [5, 46],  // ground - right
  [4, 56],  // ground far right
  [6,45]
];

function blankCanvas(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      ch: ' ',
      color: null
    }))
  );
}


function stamp(canvas, pattern, row, column, color) {
  pattern.forEach((line, patternRow) => {
    [...line].forEach((character, patternColumn) => {
      const targetRow = row + patternRow;
      const targetColumn = column + patternColumn;

      if (
        character !== ' ' &&
        canvas[targetRow] &&
        canvas[targetRow][targetColumn]
      ) {
        canvas[targetRow][targetColumn] = {
          ch: character,
          color
        };
      }
    });
  });
}

function buildSky() {
  const canvas = blankCanvas(WIDTH, SKY_HEIGHT);

  STARS.forEach(([row, column]) => {
    if (canvas[row] && canvas[row][column]) {
      canvas[row][column] = {
        ch: '*',
        color: STAR
      };
    }
  });

 
// Moon: one row below the upper border
 stamp(canvas, MOON, 0, WIDTH - 15, MOON_COLOR);

  // Left cloud
  stamp(canvas, CLOUD2, 2, 4, CLOUD_COLOR);

  // Right cloud
  stamp(canvas, CLOUD, 5, 30, CLOUD_COLOR);

  return canvas;
}

function CanvasRow({ cells }) {
  const segments = [];
  let current = null;

  cells.forEach((cell) => {
    if (current && current.color === cell.color) {
      current.text += cell.ch;
    } else {
      if (current) {
        segments.push(current);
      }

      current = {
        text: cell.ch,
        color: cell.color
      };
    }
  });

  if (current) {
    segments.push(current);
  }

  return h(
    Box,
    null,
    segments.map((segment, index) =>
      h(
        Text,
        {
          key: index,
          color: segment.color || undefined
        },
        segment.text
      )
    )
  );
}

function Border() {
  return h(
    Text,
    {
      color: BORDER
    },
    '_'.repeat(WIDTH)
  );
}

function App({ mascot }) {
  const sky = buildSky();

  return h(
    Box,
    {
      flexDirection: 'column',
      width: WIDTH
    },

    // Header
    h(
      Box,
      {
        height: 1
      },
      h(Text, { color: 'white' }, 'Welcome to '),
      h(Text, { color: CYAN, bold: true }, 'Levi Code'),
      h(Text, { color: 'white' }, ' v1')
    ),

    // Space before upper border
    h(Box, { height: 1 }),

    // Upper border
    h(Border),

    // Space between upper border and moon
    h(Box, { height: 1 }),

    // Sky
    h(
      Box,
      {
        flexDirection: 'column',
        height: SKY_HEIGHT
      },
      sky.map((row, index) =>
        h(CanvasRow, {
          key: index,
          cells: row
        })
      )
    ),

    // Space before mascot
//    h(Box, { height: 1 }),

    // Mascot overlaps the lower border by one row
    mascot
      ? h(
          Box,
          {
            flexDirection: 'column',
            marginBottom: -1,
	    marginLeft:6
          },
          h(Text, null, mascot)
        )
      : null,

    // Lower border
    h(Border)
  );
}

//let mascot = '';

//try {
//  mascot = await terminalImage.file(
//    path.join(process.cwd(), 'assets', 'mascot.png'),
//    {
//      width: 10
//    }
//  );
//} catch {
//  mascot = '';
//}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mascot = "";

try {
  const mascotPath = path.join(
    __dirname,
    "assets",
    "mascot.png"
  );

  mascot = await terminalImage.file(mascotPath, {
    width: 10,
    preserveAspectRatio: true
  });
} catch (error) {
  mascot = "";
}
try {
  execaSync(process.platform === 'win32' ? 'cls' : 'clear', {
    shell: true,
    stdio: 'inherit'
  });
} catch {}

const app = render(h(App, { mascot }));
app.unmount();

const cyan = chalk.hex('#22d3ee');
const dim = chalk.hex('#666666');
const moon = chalk.hex('#e8e8e8');

const CONFIG_PATH = path.join(os.homedir(), '.levi', 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {}
}

async function launchMainUi() {
  try {
    const cfg = readConfig();
    cfg.currentSession = null;
    writeConfig(cfg);
  } catch {}
  await import('./index.js');
}

async function runOnboardingSetup() {
  const setupChoice = await p.select({
    message: 'Configure AI models and search now?',
    options: [
      { value: 'setup', label: 'Setup now', hint: 'Configure your primary AI model & search key' },
      { value: 'skip', label: 'Skip for now', hint: 'Jump straight into Levi' }
    ]
  });

  if (p.isCancel(setupChoice) || setupChoice === 'skip') {
    p.log.message(dim('Skipping setup. You can always configure models later with /models:create.'));
    await launchMainUi();
    return;
  }

  // 1. Tell user about models and name them
  p.note(
    `Levi connects directly to your choice of AI model provider to write code,\n` +
    `manage tasks, and execute tools. Levi can run any model from any api or provider that use openai or anthropic's sdk Here are the popular options:\n\n` +
    `• Google Gemini  ${dim('→')} Model: ${cyan.bold('gemini-3.5-flash')} (Free key at ${dim('aistudio.google.com')})\n` +
    `• OpenAI         ${dim('→')} Model: ${cyan.bold('gpt-4o')} or ${cyan.bold('gpt-4o-mini')} (${dim('platform.openai.com')})\n` +
    `• Anthropic      ${dim('→')} Model: ${cyan.bold('claude-5.5-sonnet-20241022')} (${dim('console.anthropic.com')})\n` +
    `• Groq           ${dim('→')} Model: ${cyan.bold('llama-3.3-70b-versatile')} (${dim('console.groq.com')})\n` +
    `• OpenRouter     ${dim('→')} Model: ${cyan.bold('anthropic/claude-5.5-opus')} (${dim('openrouter.ai')})\n` +
    `• Ollama         ${dim('→')} Model: ${cyan.bold('llama3')} (Local offline at ${dim('localhost:11434')})`,
    cyan('☾ AI Models & Providers')
  );

  // 2. Create their first one
  const provider = await p.select({
    message: 'Select a provider for your first model:',
    options: [
      { value: 'gemini', label: 'Google Gemini', hint: 'Recommended (Free tier at aistudio.google.com)' },
      { value: 'openai', label: 'OpenAI', hint: 'GPT-4o, GPT-4o-mini' },
      { value: 'anthropic', label: 'Anthropic', hint: 'Claude 3.5 Sonnet' },
      { value: 'groq', label: 'Groq', hint: 'Ultra-fast Llama 3.3' },
      { value: 'openrouter', label: 'OpenRouter', hint: 'Access 100+ models via unified API' },
      { value: 'ollama', label: 'Ollama', hint: 'Local offline (localhost:11434)' },
      { value: 'custom', label: 'Custom', hint: 'Any OpenAI-compatible or Anthropic endpoint' }
    ]
  });

  if (p.isCancel(provider)) {
    p.cancel(dim('Model setup cancelled.'));
    await launchMainUi();
    return;
  }

  const PRESETS = {
    gemini: {
      name: 'gemini',
      sdk: 'openai',
      model: 'gemini-3.5-flash-lite',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      keyHint: 'Get your Gemini API key at https://aistudio.google.com'
    },
    openai: {
      name: 'openai',
      sdk: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      keyHint: 'Get your OpenAI API key at https://platform.openai.com'
    },
    anthropic: {
      name: 'anthropic',
      sdk: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      baseUrl: 'https://api.anthropic.com',
      keyHint: 'Get your Anthropic API key at https://console.anthropic.com'
    },
    groq: {
      name: 'groq',
      sdk: 'openai',
      model: 'llama-3.3-70b-versatile',
      baseUrl: 'https://api.groq.com/openai/v1',
      keyHint: 'Get your Groq API key at https://console.groq.com'
    },
    openrouter: {
      name: 'openrouter',
      sdk: 'openai',
      model: 'anthropic/claude-3.5-sonnet',
      baseUrl: 'https://openrouter.ai/api/v1',
      keyHint: 'Get your OpenRouter API key at https://openrouter.ai'
    },
    ollama: {
      name: 'ollama',
      sdk: 'openai',
      model: 'llama3',
      baseUrl: 'http://localhost:11434/v1',
      keyHint: 'Local Ollama server (key can be "ollama")'
    },
    custom: {
      name: 'custom',
      sdk: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      keyHint: 'Enter your API key'
    }
  };

  const preset = PRESETS[provider] || PRESETS.custom;

  const modelNick = await p.text({
    message: 'Model nickname in Levi:',
    initialValue: preset.name,
    validate: (v) => (!v || !v.trim() ? 'Name required' : undefined)
  });

  if (p.isCancel(modelNick)) {
    p.cancel(dim('Model setup cancelled.'));
    await launchMainUi();
    return;
  }

  if (preset.keyHint) p.log.info(dim(preset.keyHint));

  const apiKey = await p.password({
    message: `API Key for ${provider}:`,
    validate: (v) => {
      if (provider !== 'ollama' && (!v || !v.trim())) return 'API key required';
    }
  });

  if (p.isCancel(apiKey)) {
    p.cancel(dim('Model setup cancelled.'));
    await launchMainUi();
    return;
  }

  const modelName = await p.text({
    message: 'Model name / ID:',
    initialValue: preset.model,
    validate: (v) => (!v || !v.trim() ? 'Model name required' : undefined)
  });

  if (p.isCancel(modelName)) {
    p.cancel(dim('Model setup cancelled.'));
    await launchMainUi();
    return;
  }

  let baseUrl = preset.baseUrl;
  let sdk = preset.sdk;

  if (provider === 'custom') {
    const chosenSdk = await p.select({
      message: 'SDK protocol:',
      options: [
        { value: 'openai', label: 'openai (OpenAI compatible)' },
        { value: 'anthropic', label: 'anthropic' }
      ]
    });
    if (p.isCancel(chosenSdk)) {
      p.cancel(dim('Model setup cancelled.'));
      await launchMainUi();
      return;
    }
    sdk = chosenSdk;

    const customUrl = await p.text({
      message: 'Base URL:',
      initialValue: preset.baseUrl
    });
    if (p.isCancel(customUrl)) {
      p.cancel(dim('Model setup cancelled.'));
      await launchMainUi();
      return;
    }
    baseUrl = (customUrl || '').trim() || preset.baseUrl;
  } else {
    const customUrl = await p.text({
      message: 'Base URL:',
      initialValue: preset.baseUrl,
      placeholder: `${preset.baseUrl} (press Enter to keep default)`
    });
    if (!p.isCancel(customUrl)) {
      baseUrl = (customUrl || '').trim() || preset.baseUrl;
    }
  }

  const mKey = (modelNick || preset.name).trim();
  const conf = readConfig();
  if (!conf.models) conf.models = {};
  conf.models[mKey] = {
    sdk,
    api_key: (apiKey || 'ollama').trim(),
    model: (modelName || preset.model).trim(),
    base_url: baseUrl.trim()
  };
  conf.active_model = mKey;
  writeConfig(conf);
  p.log.success(`${cyan('✓')} Model ${cyan.bold(mKey)} created and set as active!`);

  // 3. Ask for serper api key too
  p.note(
    `Serper provides Google Web Search results for Levi.\n` +
    `You can get a free API key (2,500 queries) at ${cyan.underline('https://serper.dev')}.`,
    cyan('☾ Web Search API Key (Serper)')
  );

  const serperInput = await p.password({
    message: 'Enter Serper API key (press Enter to skip):',
    mask: '•'
  });

  if (!p.isCancel(serperInput) && serperInput && serperInput.trim()) {
    const cfgAfter = readConfig();
    cfgAfter.search = {
      provider: 'serper',
      api_key: serperInput.trim()
    };
    writeConfig(cfgAfter);
    p.log.success(`${cyan('✓')} Serper search key configured!`);
  } else {
    p.log.info(dim('Search key skipped. You can set it later with /search:api <key>.'));
  }

  p.outro(`${cyan('✦')} Setup complete! Launching Levi...`);
  await new Promise((r) => setTimeout(r, 600));
  await launchMainUi();
}

process.stdout.write("\n\n");
await login();

const conf = readConfig();
if (!conf.auth?.loggedIn) {
  process.exit(0);
}

await runOnboardingSetup();
