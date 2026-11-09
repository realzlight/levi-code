import * as p from '@clack/prompts';
import chalk from 'chalk';

export async function promptWorkspaceTrust() {
  // Allow bypassing in automated / CI tests
  if (process.env.LEVI_TRUST === '1' || process.env.CI === 'true') {
    return true;
  }

  // Non-interactive environment: proceed automatically
  if (!process.stdin.isTTY) {
    return true;
  }

  const cwd = process.cwd();

  p.intro(chalk.hex('#f59e0b').bold('Levi Code'));

  const answer = await p.select({
    message: `Do you trust the files in this folder?\n  ${chalk.cyan(cwd)}\n\n  ${chalk.dim('Levi will be able to read and edit files, and execute commands in this workspace.')}`,
    options: [
      { value: 'yes', label: 'Yes, I trust this folder', hint: 'Proceed to session' },
      { value: 'no', label: 'No, exit', hint: 'Cancel and exit' }
    ],
    initialValue: 'yes'
  });

  if (p.isCancel(answer) || answer === 'no') {
    p.cancel(chalk.hex('#f87171')('Session cancelled. Folder not trusted.'));
    process.exit(0);
  }

  p.outro(chalk.hex('#4ade80')('Folder trusted. Starting session...'));
  return true;
}
