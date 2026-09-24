import * as p from '@clack/prompts';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.levi', 'config.json');
const CLIENT_ID = 'Ov23liClj4urdGxB0Vq2';

const cyan = chalk.hex('#22d3ee');
const moon = chalk.hex('#e8e8e8');
const dim = chalk.hex('#666666');
const badge = chalk.hex('#22d3ee').bold('LEVI');

function readConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
function writeConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

export async function login() {
  console.log();
  p.intro(`${badge} ${dim('sign in with GitHub')}`);

  // 1. Request device code
  const deviceRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user user:email' })
  }).then(r => r.json());

  if (deviceRes.error) return p.log.error(chalk.red(deviceRes.error_description));

  const { device_code, user_code, verification_uri, interval } = deviceRes;

  p.note(
    `${dim('1.')} Open   ${cyan.underline(verification_uri)}\n` +
    `${dim('2.')} Enter  ${moon.bold(user_code)}`,
    cyan('☾ Device login')
  );

  const s = p.spinner();
  s.start(dim('Waiting for you to authorize...'));

  // 2. Poll for token
  let access_token = null;
  while (!access_token) {
    await new Promise(r => setTimeout(r, interval * 1000));

    const pollRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    }).then(r => r.json());

    if (pollRes.access_token) access_token = pollRes.access_token;
    else if (pollRes.error === 'authorization_pending') continue;
    else if (pollRes.error === 'slow_down') await new Promise(r => setTimeout(r, 5000));
    else {
      s.stop(chalk.red('Authorization failed'));
      return p.log.error(chalk.red(pollRes.error_description));
    }
  }
  s.stop(cyan('Authorized'));

  const nick = await p.text({
    message: 'What should Levi call you?',
    placeholder: 'your nickname',
    validate: (v) => (v && v.trim().length > 30 ? 'Keep it under 30 characters' : undefined)
  });
  const nickname = p.isCancel(nick) ? '' : (nick || '').trim();

  // 3. Get user info
  const user = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${access_token}` }
  }).then(r => r.json());

  const config = readConfig();
  config.auth = { token: access_token, user: { login: user.login, id: user.id, name: nickname || user.login }, loggedIn: true };
  writeConfig(config);

  p.outro(`${cyan('✦')} Logged in as ${cyan.bold(user.login)}`);
  console.log();
}

export function logout() {
  const config = readConfig();
  config.auth = { token: null, user: null, loggedIn: false };
  writeConfig(config);
  p.log.success(`${cyan('☾')} Logged out. See you soon.`);
}

export function whoami() {
  const { auth } = readConfig();
  if (!auth?.loggedIn) return p.log.info(`Not logged in. Run ${cyan('levi login')}`);
  const name = auth.user.name ? ` ${dim(`(${auth.user.name})`)}` : '';
  p.log.info(`Logged in as ${cyan.bold(auth.user.login)}${name}`);
}
