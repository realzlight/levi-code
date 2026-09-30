import { execa } from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const CONFIG_PATH = path.join(LEVI_HOME, 'config.json');
const REPO_NAME = 'levi';
const BRANCH = 'main';

function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).auth;
  } catch {
    return null;
  }
}

async function ensureLocalRepo(report) {
  const gitDir = path.join(LEVI_HOME, '.git');
  if (!fs.existsSync(gitDir)) {
    await execa('git', ['init', '-b', BRANCH], { cwd: LEVI_HOME });
  } else {
    // make sure an existing repo is actually on `main`, not `master` or anything else
    await execa('git', ['checkout', '-B', BRANCH], { cwd: LEVI_HOME, reject: false });
  }

  const gitignorePath = path.join(LEVI_HOME, '.gitignore');
  let gitignore = '';
  try {
    gitignore = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {}
  if (!gitignore.split('\n').includes('config.json')) {
    fs.writeFileSync(gitignorePath, gitignore + (gitignore && !gitignore.endsWith('\n') ? '\n' : '') + 'config.json\n');
  }

  const lsResult = await execa('git', ['ls-files', 'config.json'], { cwd: LEVI_HOME, reject: false });
  if ((lsResult.stdout || '').trim()) {
    await execa('git', ['rm', '--cached', 'config.json'], { cwd: LEVI_HOME, reject: false });
  }

  // config.json in old history (from before .gitignore existed) — since every
  // push attempt so far has been rejected, nothing's actually leaked; safe to
  // reset local history clean rather than deal with history rewriting
  const historyResult = await execa('git', ['log', '--all', '--oneline', '--', 'config.json'], { cwd: LEVI_HOME, reject: false });
  if ((historyResult.stdout || '').trim()) {
    await execa('rm', ['-rf', gitDir]);
    await execa('git', ['init', '-b', BRANCH], { cwd: LEVI_HOME });
    report('repo', 'running', 'Found old secrets in local history (never pushed) — reset clean to be safe.');
  }
}

async function hasRemote() {
  const result = await execa('git', ['remote'], { cwd: LEVI_HOME, reject: false });
  return (result.stdout || '').split('\n').includes('origin');
}

async function ensureGithubRepo(token, login, report) {
  const checkRes = await fetch(`https://api.github.com/repos/${login}/${REPO_NAME}`, {
    headers: { Authorization: `token ${token}` }
  });

  if (checkRes.status === 200) {
    return (await checkRes.json()).clone_url;
  }

  if (checkRes.status !== 404) {
    throw new Error(`GitHub returned ${checkRes.status} while checking for an existing repo.`);
  }

  report('repo', 'running', 'Creating GitHub repo...');
  const createRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: REPO_NAME, private: false, description: 'Levi CLI memory sync', auto_init: false })
  });

  if (createRes.status !== 201) {
    const err = await createRes.json().catch(() => ({}));
    if (createRes.status === 401 || createRes.status === 403) {
      throw new Error('Your login token doesn\'t have repo-creation permission. Run /logout then /login to refresh it.');
    }
    throw new Error(err.message || `GitHub returned ${createRes.status} while creating the repo.`);
  }

  return (await createRes.json()).clone_url;
}

// onProgress(stepId, status, detail) — status: 'running' | 'done' | 'error'
export async function runMemPush(onProgress) {
  const report = (id, status, detail = '') => onProgress?.(id, status, detail);

  report('auth', 'running', 'Checking login...');
  const auth = readAuth();
  if (!auth?.loggedIn || !auth?.token) {
    report('auth', 'error', 'Not logged in. Run /login first.');
    return false;
  }
  report('auth', 'done', `Logged in as ${auth.user?.login || 'unknown'}`);

  try {
    report('repo', 'running', 'Preparing local repo...');
    await ensureLocalRepo(report);
    report('repo', 'done', 'Local repo ready');

    if (!(await hasRemote())) {
      report('remote', 'running', 'Checking GitHub repo...');
      const cloneUrl = await ensureGithubRepo(auth.token, auth.user.login, report);
      const authedUrl = cloneUrl.replace('https://', `https://${auth.user.login}:${auth.token}@`);
      await execa('git', ['remote', 'add', 'origin', authedUrl], { cwd: LEVI_HOME });
      report('remote', 'done', `Connected to github.com/${auth.user.login}/${REPO_NAME}`);
    } else {
      report('remote', 'done', 'Remote already configured');
    }

    report('commit', 'running', 'Committing changes...');
    await execa('git', ['add', '-A'], { cwd: LEVI_HOME });
    const commitResult = await execa('git', ['commit', '-m', `levi sync: ${new Date().toISOString()}`], { cwd: LEVI_HOME, reject: false });
    report('commit', 'done', commitResult.exitCode === 0 ? 'Committed' : 'Nothing new to commit');

    report('push', 'running', 'Pushing to GitHub...');
    const pushResult = await execa('git', ['push', '-u', 'origin', BRANCH], { cwd: LEVI_HOME, reject: false });
    if (pushResult.exitCode !== 0) {
      const errText = (pushResult.stderr || pushResult.all || 'unknown error').trim();
      report('push', 'error', errText);
      return false;
    }
    report('push', 'done', 'Pushed successfully');
    return true;
  } catch (e) {
    report('repo', 'error', e.message);
    return false;
  }
}

export async function runMemSync(onProgress) {
  const report = (id, status, detail = '') => onProgress?.(id, status, detail);
  const gitDir = path.join(LEVI_HOME, '.git');

  if (!fs.existsSync(gitDir) || !(await hasRemote())) {
    report('check', 'error', 'No git remote configured yet. Run /mem:push first.');
    return false;
  }

  try {
    report('fetch', 'running', 'Fetching from GitHub...');
    await execa('git', ['fetch', 'origin'], { cwd: LEVI_HOME });
    report('fetch', 'done', 'Fetched');

    report('reset', 'running', 'Replacing local files...');
    await execa('git', ['reset', '--hard', `origin/${BRANCH}`], { cwd: LEVI_HOME });
    await execa('git', ['clean', '-fd'], { cwd: LEVI_HOME });
    report('reset', 'done', '~/.levi replaced with the remote version');
    return true;
  } catch (e) {
    report('reset', 'error', e.message);
    return false;
  }
}
