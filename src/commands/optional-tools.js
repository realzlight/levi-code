import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { execa } from 'execa';
import { detectPlatform } from '../bootstrap.js';

const cyan = chalk.hex('#22d3ee');
const moon = chalk.hex('#e8e8e8');
const dim = chalk.hex('#666666');
const green = chalk.hex('#4ade80');
const yellow = chalk.hex('#fbbf24');

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
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {}
}

/**
 * Check if the Playwright package is currently installed.
 */
export async function isPlaywrightInstalled() {
  try {
    await import('playwright');
    return true;
  } catch {
    return false;
  }
}

/**
 * Install Playwright package and download Chromium browser binaries.
 */
export async function installPlaywrightTools({ quiet = false } = {}) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const spinner = !quiet ? p.spinner() : null;

  if (spinner) {
    spinner.start('Installing Playwright package...');
  }

  try {
    // 1. Install playwright npm package into Levi root directory
    const npmRes = await execa('npm', ['install', '--no-save', 'playwright@^1.50.0'], {
      cwd: rootDir,
      reject: false
    });

    if (npmRes.exitCode !== 0) {
      if (spinner) spinner.stop(`${yellow('!')} Failed to install playwright npm package: ${npmRes.stderr || 'npm error'}`);
      return false;
    }

    // 2. Download Chromium browser binaries
    if (spinner) {
      spinner.stop(`${green('✓')} Playwright package installed.`);
      spinner.start('Downloading Chromium browser binary (~150MB)...');
    }

    const pwRes = await execa('npx', ['playwright', 'install', 'chromium'], {
      cwd: rootDir,
      timeout: 180000,
      reject: false
    });

    const success = pwRes.exitCode === 0;
    const cfg = readConfig();
    if (!cfg.optional_tools) cfg.optional_tools = {};
    cfg.optional_tools.playwright = success;
    cfg.optional_tools.installedAt = new Date().toISOString();
    writeConfig(cfg);

    if (spinner) {
      if (success) {
        spinner.stop(`${green('✓')} Playwright & Chromium browser installed successfully!`);
      } else {
        spinner.stop(`${yellow('!')} Playwright driver installed. Browser binary download deferred (run 'npx playwright install chromium').`);
      }
    }
    return success;
  } catch (err) {
    if (spinner) {
      spinner.stop(`${yellow('!')} Playwright installation failed: ${err.message}`);
    }
    return false;
  }
}

/**
 * Interactive prompt displayed after sign-in and initial model setup.
 * Asks whether the user wants to install optional heavy tools now or skip.
 */
export async function promptOptionalToolsInstall() {
  const plat = detectPlatform();
  const cfg = readConfig();

  // If already asked or user explicitly answered, do not ask again
  if (cfg.optional_tools?.asked) {
    return;
  }

  p.note(
    `Playwright provides automated desktop browser control, web scraping, and screenshots.\n` +
    `It downloads Chromium browser binaries (~150MB+).\n` +
    (plat.skipHeavyDeps ? yellow(`Note: Detected ${plat.label}. Playwright is designed for desktop GUI/X11 environments.\n`) : '') +
    `You can install it now or skip to keep Levi lightweight.`,
    cyan('☾ Optional Tools: Playwright Browser Automation')
  );

  const shouldInstall = await p.confirm({
    message: 'Would you like to install Playwright & Chromium browser now?',
    initialValue: !plat.skipHeavyDeps
  });

  if (p.isCancel(shouldInstall)) {
    p.cancel(dim('Tool installation skipped for now.'));
    const updatedCfg = readConfig();
    if (!updatedCfg.optional_tools) updatedCfg.optional_tools = {};
    updatedCfg.optional_tools.asked = true;
    updatedCfg.optional_tools.playwright = false;
    writeConfig(updatedCfg);
    return;
  }

  const updatedCfg = readConfig();
  if (!updatedCfg.optional_tools) updatedCfg.optional_tools = {};
  updatedCfg.optional_tools.asked = true;

  if (shouldInstall) {
    writeConfig(updatedCfg);
    await installPlaywrightTools();
  } else {
    updatedCfg.optional_tools.playwright = false;
    writeConfig(updatedCfg);
    p.log.info(dim('Skipped browser automation. You can install it anytime later with "levi install:browser".'));
  }
}
