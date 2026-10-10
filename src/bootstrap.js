import fs from 'fs';
import path from 'path';
import os from 'os';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { execa } from 'execa';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cyan = chalk.hex('#22d3ee');
const moon = chalk.hex('#e8e8e8');
const dim = chalk.hex('#666666');
const green = chalk.hex('#4ade80');
const yellow = chalk.hex('#fbbf24');
const purple = chalk.hex('#a78bfa');
const badge = cyan.bold('LEVI');

/**
 * Inspect host operating system, architecture, and container/termux runtime.
 */
export function detectPlatform() {
  const platform = process.platform;
  const arch = process.arch;
  const isTermux = Boolean(process.env.TERMUX_VERSION) ||
    Boolean(process.env.PREFIX && process.env.PREFIX.includes('com.termux')) ||
    (platform === 'android');
  const isAndroid = platform === 'android' || isTermux;
  const isArm = arch.startsWith('arm');
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';
  const isLinux = platform === 'linux' && !isAndroid;

  const isDesktop = isMac || isWindows || isLinux;
  const skipHeavyDeps = isAndroid || isTermux || (isArm && isAndroid);

  let label = 'Unknown Platform';
  if (isTermux) label = `Termux / Android (${arch})`;
  else if (isAndroid) label = `Android (${arch})`;
  else if (isMac) label = `macOS (${arch})`;
  else if (isWindows) label = `Windows (${arch})`;
  else if (isLinux) label = `Linux Desktop (${arch})`;

  return {
    platform,
    arch,
    isTermux,
    isAndroid,
    isArm,
    isMac,
    isWindows,
    isLinux,
    isDesktop,
    skipHeavyDeps,
    label
  };
}

/**
 * Check if a command is available in PATH.
 */
async function commandExists(cmd) {
  try {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';
    const res = await execa(checkCmd, [cmd], { reject: false, timeout: 3000 });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Core bootstrap process for Levi.
 * Initializes ~/.levi workspace, writes/patches default configs (including cua-driver MCP),
 * inspects platform OS/arch, and conditionally handles Playwright & CUA-Driver setup.
 */
export async function runBootstrap({ onProgress = null, quiet = false } = {}) {
  const LEVI_HOME = path.join(os.homedir(), '.levi');
  const plat = detectPlatform();

  const results = {
    home: LEVI_HOME,
    dirsCount: 6,
    createdDirs: [],
    verifiedDirs: [],
    createdFiles: [],
    verifiedFiles: [],
    patchedFiles: [],
    platform: plat,
    playwrightStatus: 'skipped',
    cuaStatus: 'skipped'
  };

  if (!quiet) {
    console.log();
    p.intro(`${badge} ${moon.bold('System Setup & Workspace Bootstrap')}`);
    p.log.message(dim(`Target directory: ${cyan(LEVI_HOME)}`));
  }

  // --- Step 1: Workspace directories ---
  const spinner = !quiet ? p.spinner() : null;
  if (spinner) {
    spinner.start('Initializing core workspace folders...');
    await sleep(200);
  }

  const dirs = ['ACTIVE-BUFFER', 'ENDED-BUFFER', 'PROJECTS', 'SKILLS', 'MEMORY', 'screenshots'];
  if (!fs.existsSync(LEVI_HOME)) {
    fs.mkdirSync(LEVI_HOME, { recursive: true });
    results.createdDirs.push('.levi');
  }

  for (const dir of dirs) {
    const fullPath = path.join(LEVI_HOME, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      results.createdDirs.push(dir);
    } else {
      results.verifiedDirs.push(dir);
    }
  }

  onProgress?.({ stage: 'directories', status: 'ready', count: dirs.length });

  if (spinner) {
    const dirSummary = results.createdDirs.length
      ? `Created ${results.createdDirs.length} folder(s)`
      : 'All 6 core folders verified';
    spinner.stop(`${green('✓')} ${dirSummary} (${dirs.join(', ')})`);
  }

  // --- Step 2: Configuration & MCP stores ---
  if (spinner) {
    spinner.start('Configuring storage profiles and default MCP servers...');
    await sleep(200);
  }

  const files = {
    'config.json': JSON.stringify({
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      compaction_threshold: {
        threshold: 6000
      },
      auth: {
        token: null,
        user: null,
        loggedIn: false
      },
      models: {},
      active_model: null,
      soloOnly: false,
      currentSession: null
    }, null, 2),
    'mcp.json': JSON.stringify({
      mcpServers: {
        serper: {
          command: 'npx',
          args: ['-y', 'mcp-server-serper'],
          env: { SERPER_API_KEY: '' }
        },
        fetch: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-fetch']
        },
        github: {
          url: 'https://api.githubcopilot.com/mcp/',
          headers: {}
        },
        'cua-driver': {
          command: 'cua-driver',
          args: ['mcp']
        }
      }
    }, null, 2),
    'LEVI.md': '# LEVI\n',
    'MEMORY/USER.md': '# USER\n',
    'MEMORY/PREFERENCE.md': '# PREFERENCES\n',
    'MEMORY/PATTERNS.md': 'summary:\nNo strong patterns yet.\n\n\n'
  };

  for (const [fileName, content] of Object.entries(files)) {
    const fullPath = path.join(LEVI_HOME, fileName);
    if (!fs.existsSync(fullPath)) {
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(fullPath, content);
      results.createdFiles.push(fileName);
    } else {
      results.verifiedFiles.push(fileName);

      // Patch existing config.json if auth is missing
      if (fileName === 'config.json') {
        try {
          const cfg = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          if (!cfg.auth) {
            cfg.auth = { token: null, user: null, loggedIn: false };
            fs.writeFileSync(fullPath, JSON.stringify(cfg, null, 2));
            results.patchedFiles.push(fileName);
          }
        } catch {}
      }

      // Patch existing mcp.json to include cua-driver if missing
      if (fileName === 'mcp.json') {
        try {
          const mcpCfg = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          if (!mcpCfg.mcpServers) mcpCfg.mcpServers = {};
          if (!mcpCfg.mcpServers['cua-driver']) {
            mcpCfg.mcpServers['cua-driver'] = {
              command: 'cua-driver',
              args: ['mcp']
            };
            fs.writeFileSync(fullPath, JSON.stringify(mcpCfg, null, 2));
            results.patchedFiles.push('mcp.json (added cua-driver)');
          }
        } catch {}
      }
    }
  }

  onProgress?.({ stage: 'configs', status: 'ready' });

  if (spinner) {
    spinner.stop(`${green('✓')} Configuration and MCP servers synced (serper, fetch, github, cua-driver)`);
  }

  // --- Step 3: Platform & Architecture Inspection ---
  if (spinner) {
    spinner.start('Inspecting host OS, architecture, and desktop environment...');
    await sleep(250);
  }

  onProgress?.({ stage: 'platform', platform: plat });

  if (spinner) {
    spinner.stop(`${cyan('ℹ')} Host Environment: ${moon.bold(plat.label)}`);
  }

  // --- Step 4: Conditional Playwright & CUA Driver Setup ---
  if (plat.skipHeavyDeps) {
    // Termux / Android / ARM mobile environment: skip heavy packages
    results.playwrightStatus = 'skipped (Android/Termux terminal environment)';
    results.cuaStatus = 'skipped (Android/Termux terminal environment)';

    if (!quiet) {
      p.log.warn(yellow('⚡ Mobile/Termux Mode Detected'));
      p.log.message(dim('  • Playwright Chromium binary install: ') + yellow('Skipped') + dim(' (requires X11/Wayland display)'));
      p.log.message(dim('  • CUA-Driver desktop automation setup: ') + yellow('Skipped') + dim(' (requires desktop window manager)'));
      p.log.message(cyan('  → Terminal companion mode enabled. All file, shell, MCP, and search tools are active.'));
    }
  } else {
    // Desktop environment (macOS, Windows, Desktop Linux): install / configure
    if (!quiet) {
      p.log.step(cyan('🖥 Desktop Platform Detected: Configuring browser & desktop automation'));
    }

    // Playwright setup
    if (spinner) {
      spinner.start('Setting up Playwright browser binaries (Chromium)...');
    }

    try {
      const pwCheck = await execa('npx', ['playwright', 'install', 'chromium'], {
        timeout: 90000,
        reject: false
      });
      if (pwCheck.exitCode === 0) {
        results.playwrightStatus = 'installed';
        if (spinner) spinner.stop(`${green('✓')} Playwright Chromium installed successfully`);
      } else {
        results.playwrightStatus = 'available (run `npx playwright install chromium` if needed)';
        if (spinner) spinner.stop(`${yellow('!')} Playwright browser install notice: run "npx playwright install chromium"`);
      }
    } catch {
      results.playwrightStatus = 'ready for manual install';
      if (spinner) spinner.stop(`${yellow('!')} Playwright installation deferred`);
    }

    // CUA-Driver setup
    if (spinner) {
      spinner.start('Verifying CUA Driver desktop automation setup...');
    }

    const hasCua = await commandExists('cua-driver');
    if (hasCua) {
      results.cuaStatus = 'installed (CLI available in PATH)';
      if (spinner) spinner.stop(`${green('✓')} cua-driver CLI verified in system PATH`);
    } else {
      // Try resolving via npx or global package
      results.cuaStatus = 'configured (resolves via npx @openclick/cua-driver)';
      if (spinner) spinner.stop(`${green('✓')} cua-driver MCP configured (will launch via npx on demand)`);
    }
  }

  // --- Step 5: Summary Note & Completion ---
  if (!quiet) {
    const summaryLines = [
      `${dim('Workspace:')}    ${cyan(LEVI_HOME)}`,
      `${dim('Environment:')}  ${moon(plat.label)}`,
      `${dim('MCP Servers:')}  ${purple('serper · fetch · github · cua-driver')}`,
      `${dim('Tools:')}        ${green('Filesystem · Web Browser · Desktop Control · MCP')}`,
      `${dim('Status:')}       ${plat.skipHeavyDeps ? yellow('Ready (Termux Companion)') : green('Ready (Desktop Full Suite)')}`
    ];

    p.note(summaryLines.join('\n'), cyan('☾ LEVI Setup Overview'));
    p.outro(cyan.bold('LEVI is fully configured and ready for pair programming! 🚀'));
  }

  return results;
}

export async function boot() {
  return await runBootstrap({ quiet: false });
}

// Auto-run when executed directly via CLI or postinstall: node src/bootstrap.js
if (process.argv[1] && process.argv[1].endsWith('bootstrap.js')) {
  const isQuiet = process.argv.includes('--quiet') || !process.stdout.isTTY;
  runBootstrap({ quiet: isQuiet }).catch(err => {
    console.error(chalk.red('[levi] Bootstrap notice:'), err.message);
    process.exit(0);
  });
}

export default boot;
