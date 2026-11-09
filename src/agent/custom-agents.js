import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const AGENTS_DIR = path.join(LEVI_HOME, 'AGENTS');

export function getAgentsDir() {
  return AGENTS_DIR;
}

export function ensureAgentsDir() {
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
  return AGENTS_DIR;
}

export function sanitizeAgentName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/\.md$/i, '')
    .replace(/^@+/, '')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Parse an agent markdown file with YAML frontmatter.
 * Layout:
 * ---
 * name: bug-hunter
 * description: Hunts Bug like a pro and report them
 * tools: Read, Glop, Write
 * ---
 * 
 * You are a professional bug-hunter...
 */
export function parseAgentFrontmatter(content) {
  if (!content || typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) return null;

  const header = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();

  let name = '';
  let description = '';
  let tools = 'all';
  let disabled = false;

  for (const line of header.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name') name = val;
    else if (key === 'description') description = val;
    else if (key === 'tools') tools = val;
    else if (key === 'disabled') disabled = val === 'true' || val === 'yes' || val === '1';
    else if (key === 'enabled') disabled = !(val === 'true' || val === 'yes' || val === '1');
  }

  const cleanName = sanitizeAgentName(name);
  if (!cleanName || !description) return null;

  return {
    name: cleanName,
    description,
    tools, // Note: all custom sub-agents receive full tool access
    disabled,
    systemPrompt: body,
    body,
    raw: content
  };
}

/**
 * Check if a file is an agent markdown file based on its frontmatter content.
 */
export function isAgentFile(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    const content = fs.readFileSync(filePath, 'utf-8');
    return Boolean(parseAgentFrontmatter(content));
  } catch {
    return false;
  }
}

/**
 * List all custom sub-agents from ~/.levi/AGENTS/
 */
export function listCustomAgents() {
  ensureAgentsDir();
  const agents = [];

  try {
    const files = fs.readdirSync(AGENTS_DIR);
    for (const f of files) {
      if (!f.endsWith('.md') || f.startsWith('.')) continue;
      const fullPath = path.join(AGENTS_DIR, f);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const parsed = parseAgentFrontmatter(content);
        if (parsed) {
          agents.push({
            name: parsed.name,
            description: parsed.description,
            tools: 'all',
            disabled: Boolean(parsed.disabled),
            path: fullPath,
            file: f,
            systemPrompt: parsed.systemPrompt
          });
        }
      } catch {}
    }
  } catch {}

  return agents;
}

/**
 * Get a specific custom sub-agent by name (case-insensitive).
 * Skips disabled agents unless includeDisabled is true.
 */
export function getCustomAgent(name, { includeDisabled = false } = {}) {
  if (!name || typeof name !== 'string') return null;
  const clean = sanitizeAgentName(name).toLowerCase();
  const all = listCustomAgents();
  const found = all.find((a) => a.name.toLowerCase() === clean);
  if (!found) return null;
  if (found.disabled && !includeDisabled) return null;
  return found;
}

/**
 * Enable or disable a custom sub-agent by toggling disabled flag in its YAML frontmatter.
 */
export function setCustomAgentEnabled(name, enabled) {
  ensureAgentsDir();
  const cleanName = sanitizeAgentName(name);
  if (!cleanName) return { ok: false, error: 'Agent name required.' };

  const filePath = path.join(AGENTS_DIR, `${cleanName}.md`);
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `Agent "${cleanName}" not found in ~/.levi/AGENTS/.` };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseAgentFrontmatter(content);
    if (!parsed) {
      return { ok: false, error: `Invalid agent format in ~/.levi/AGENTS/${cleanName}.md.` };
    }

    const endIdx = content.indexOf('---', 3);
    const header = content.slice(3, endIdx).trim();
    const body = content.slice(endIdx + 3);

    const lines = header.split('\n').filter((l) => !/^(disabled|enabled):/i.test(l.trim()));
    if (!enabled) {
      lines.push('disabled: true');
    }

    const newContent = `---\n${lines.join('\n')}\n---${body}`;
    fs.writeFileSync(filePath, newContent, 'utf-8');

    return { ok: true, name: cleanName, enabled: Boolean(enabled) };
  } catch (err) {
    return { ok: false, error: `Failed to update agent: ${err.message}` };
  }
}

/**
 * Save / create a custom sub-agent file in ~/.levi/AGENTS/<name>.md
 */
export function saveCustomAgent(name, { description, systemPrompt, tools = 'all' } = {}) {
  ensureAgentsDir();
  const cleanName = sanitizeAgentName(name);
  if (!cleanName) return { ok: false, error: 'Valid agent name required.' };
  if (!description || !description.trim()) return { ok: false, error: 'Agent description required.' };

  const filePath = path.join(AGENTS_DIR, `${cleanName}.md`);
  const content = `---
name: ${cleanName}
description: ${description.trim()}
tools: ${tools || 'all'}
---

${(systemPrompt || `You are ${cleanName}, an expert autonomous sub-agent working under lead orchestrator Levi.`).trim()}
`;

  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return {
      ok: true,
      name: cleanName,
      path: filePath,
      description: description.trim(),
      systemPrompt: (systemPrompt || '').trim()
    };
  } catch (err) {
    return { ok: false, error: `Failed to save agent: ${err.message}` };
  }
}

/**
 * Delete a custom agent from ~/.levi/AGENTS/
 */
export function deleteCustomAgent(name) {
  ensureAgentsDir();
  const cleanName = sanitizeAgentName(name);
  if (!cleanName) return { ok: false, error: 'Agent name required.' };

  const filePath = path.join(AGENTS_DIR, `${cleanName}.md`);
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `Agent "${cleanName}" not found in ${AGENTS_DIR}.` };
  }

  try {
    fs.unlinkSync(filePath);
    return { ok: true, name: cleanName };
  } catch (err) {
    return { ok: false, error: `Failed to delete agent: ${err.message}` };
  }
}

/**
 * Scan a plugin directory or repository for agent files and sync them into ~/.levi/AGENTS/.
 * Automatically identifies:
 * - Files/directories specified in manifest agents field.
 * - Files named agent.md or <name>.md inside agents/ directories.
 * - Any .md file anywhere in the plugin containing YAML frontmatter with name: and description:.
 */
export function syncAgentsFromPlugin(pluginDir, explicitTargets = null) {
  ensureAgentsDir();
  const synced = [];
  const scannedPaths = new Set();

  function checkAndSyncFile(filePath) {
    if (scannedPaths.has(filePath)) return;
    scannedPaths.add(filePath);

    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseAgentFrontmatter(content);
      if (parsed) {
        const destFile = path.join(AGENTS_DIR, `${parsed.name}.md`);
        fs.writeFileSync(destFile, content, 'utf-8');
        synced.push({
          name: parsed.name,
          description: parsed.description,
          path: destFile,
          source: filePath
        });
      }
    } catch {}
  }

  function crawlDirForAgents(dir) {
    const IGNORE = new Set(['.git', '.github', 'node_modules', '.tmp', '.DS_Store', 'dist', 'build']);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (IGNORE.has(ent.name) || ent.name.startsWith('.tmp-')) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          crawlDirForAgents(full);
        } else if (ent.isFile() && ent.name.endsWith('.md')) {
          checkAndSyncFile(full);
        }
      }
    } catch {}
  }

  // 1. Check explicit targets from manifest if provided
  if (explicitTargets) {
    const list = Array.isArray(explicitTargets) ? explicitTargets : [explicitTargets];
    for (const t of list) {
      const full = path.resolve(pluginDir, String(t).trim());
      if (!fs.existsSync(full)) continue;
      const st = fs.statSync(full);
      if (st.isFile()) {
        checkAndSyncFile(full);
      } else if (st.isDirectory()) {
        crawlDirForAgents(full);
      }
    }
  }

  // 2. Check standard candidate agent directories (agents, agent, .agents)
  for (const dirName of ['agents', 'agent', '.agents']) {
    const full = path.join(pluginDir, dirName);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      crawlDirForAgents(full);
    }
  }

  // 3. Fallback: crawl entire plugin directory for agent.md or .md with agent frontmatter
  crawlDirForAgents(pluginDir);

  return synced;
}

/**
 * Format available custom agents for Levi prompt context.
 */
export function getCustomAgentsPromptList() {
  const agents = listCustomAgents();
  return agents.filter((a) => !a.disabled).map((a) => ({
    name: a.name,
    description: a.description
  }));
}

