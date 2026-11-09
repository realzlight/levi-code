import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';

const CONFIG_PATH = path.join(os.homedir(), '.levi', 'config.json');

export function getPreferredEditor() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (config?.editor && typeof config.editor === 'string' && config.editor.trim()) {
        return config.editor.trim();
      }
    }
  } catch {}
  return process.env.EDITOR || process.env.VISUAL || 'nano';
}

export function setPreferredEditor(editorCmd) {
  try {
    let config = {};
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
    config.editor = String(editorCmd || '').trim();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return { ok: true, editor: config.editor };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function openInEditor(filePath) {
  const editorCmd = getPreferredEditor();
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return await execa(editorCmd, [filePath], {
    shell: true,
    stdio: 'inherit'
  });
}
