import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const PLUGINS_DIR = path.join(LEVI_HOME, 'PLUGINS');
const META_FILE = path.join(LEVI_HOME, 'plugins.json');

export function getPluginsDir() {
  return PLUGINS_DIR;
}

export function ensurePluginsDir() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  }
}

export function readPluginsMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      const data = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
      if (data && typeof data.plugins === 'object') {
        return data;
      }
    }
  } catch {}
  return { plugins: {} };
}

export function writePluginsMeta(meta) {
  try {
    if (!fs.existsSync(LEVI_HOME)) fs.mkdirSync(LEVI_HOME, { recursive: true });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save plugins metadata:', err.message);
  }
}

function sanitizeName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9_\-\.]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Scan a plugin repository for all markdown files targeted in its manifest's `plugins` array.
 */
function scanPluginTargets(pluginDir, targetPaths = []) {
  const discovered = [];
  const normalizedTargets = Array.isArray(targetPaths) && targetPaths.length ? targetPaths : ['./'];

  for (const target of normalizedTargets) {
    const cleanTarget = String(target || '').trim();
    const resolvedPath = path.resolve(pluginDir, cleanTarget);

    if (!fs.existsSync(resolvedPath)) continue;

    const stat = fs.statSync(resolvedPath);
    if (stat.isFile() && resolvedPath.endsWith('.md')) {
      discovered.push(resolvedPath);
    } else if (stat.isDirectory()) {
      // Recursively crawl directory for all .md files
      function crawl(dir) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            crawl(full);
          } else if (ent.isFile() && ent.name.endsWith('.md')) {
            discovered.push(full);
          }
        }
      }
      crawl(resolvedPath);
    }
  }

  // Deduplicate files
  const uniquePaths = [...new Set(discovered)];
  return uniquePaths.map((filePath) => {
    const relToPlugin = path.relative(pluginDir, filePath).replace(/\\/g, '/');
    let title = path.basename(filePath, '.md');
    let summary = `Plugin playbook: ${relToPlugin}`;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      const h1 = lines.find((l) => l.startsWith('#'));
      if (h1) title = h1.replace(/^#+\s*/, '').trim();
      const quote = lines.find((l) => l.startsWith('>'));
      if (quote) {
        summary = quote.replace(/^>+\s*/, '').trim();
      } else {
        const body = lines.find((l) => !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('>'));
        if (body) summary = body.slice(0, 120);
      }
    } catch {}

    return {
      filePath,
      relToPlugin,
      fileName: path.basename(filePath),
      title,
      summary
    };
  });
}

// ---- Multi-Format Plugin Detection ----

/**
 * All supported plugin format definitions.
 * Each format specifies how to detect it, what label to show, and how to
 * extract files + synthetic manifest from a cloned repository.
 */
const FORMATS = {
  levi: {
    id: 'levi',
    label: 'Levi',
    icon: '🔷',
    description: '.levi-plugins/plugin.json manifest',
    detect: (dir) => fs.existsSync(path.join(dir, '.levi-plugins', 'plugin.json')),
    resolve: (dir, repoBase) => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, '.levi-plugins', 'plugin.json'), 'utf-8'));
      const targets = Array.isArray(raw.plugins) ? raw.plugins : (raw.skills || ['./']);
      return {
        name: sanitizeName(raw.name) || sanitizeName(repoBase),
        version: raw.version || '1.0.0',
        description: raw.description || '',
        author: raw.author || 'Unknown',
        targetPaths: targets,
        raw
      };
    }
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    icon: '🟠',
    description: 'CLAUDE.md and/or .claude/ directory',
    detect: (dir) => {
      return fs.existsSync(path.join(dir, 'CLAUDE.md')) ||
        fs.existsSync(path.join(dir, '.claude'));
    },
    resolve: (dir, repoBase) => {
      const targets = [];
      if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) targets.push('./CLAUDE.md');
      if (fs.existsSync(path.join(dir, '.claude', 'commands'))) targets.push('./.claude/commands');
      if (fs.existsSync(path.join(dir, '.claude'))) {
        // scan .claude/ for any .md files beyond commands/
        try {
          for (const ent of fs.readdirSync(path.join(dir, '.claude'), { withFileTypes: true })) {
            if (ent.isFile() && ent.name.endsWith('.md')) targets.push(`./.claude/${ent.name}`);
          }
        } catch {}
      }
      if (!targets.length) targets.push('./');
      let desc = '';
      try {
        const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
        const first = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
        if (first) desc = first.trim().slice(0, 120);
      } catch {}
      return {
        name: sanitizeName(repoBase),
        version: '1.0.0',
        description: desc || `Claude Code plugin from ${repoBase}`,
        author: 'Unknown',
        targetPaths: targets,
        raw: {}
      };
    }
  },
  codex: {
    id: 'codex',
    label: 'Codex / OpenAI',
    icon: '🟢',
    description: 'AGENTS.md, codex.md, or .codex/ directory',
    detect: (dir) => {
      return fs.existsSync(path.join(dir, 'AGENTS.md')) ||
        fs.existsSync(path.join(dir, 'codex.md')) ||
        fs.existsSync(path.join(dir, 'CODEX.md')) ||
        fs.existsSync(path.join(dir, '.codex'));
    },
    resolve: (dir, repoBase) => {
      const targets = [];
      for (const f of ['AGENTS.md', 'codex.md', 'CODEX.md']) {
        if (fs.existsSync(path.join(dir, f))) targets.push(`./${f}`);
      }
      if (fs.existsSync(path.join(dir, '.codex'))) targets.push('./.codex');
      if (!targets.length) targets.push('./');
      let desc = '';
      const mainFile = ['AGENTS.md', 'codex.md', 'CODEX.md'].find(f => fs.existsSync(path.join(dir, f)));
      if (mainFile) {
        try {
          const content = fs.readFileSync(path.join(dir, mainFile), 'utf-8');
          const first = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
          if (first) desc = first.trim().slice(0, 120);
        } catch {}
      }
      return {
        name: sanitizeName(repoBase),
        version: '1.0.0',
        description: desc || `Codex/OpenAI plugin from ${repoBase}`,
        author: 'Unknown',
        targetPaths: targets,
        raw: {}
      };
    }
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    icon: '🟣',
    description: '.cursorrules or .cursor/rules/ directory',
    detect: (dir) => {
      return fs.existsSync(path.join(dir, '.cursorrules')) ||
        fs.existsSync(path.join(dir, '.cursor', 'rules'));
    },
    resolve: (dir, repoBase) => {
      const targets = [];
      // .cursorrules is a plain-text file, wrap it as .md for indexing
      if (fs.existsSync(path.join(dir, '.cursorrules'))) {
        const src = path.join(dir, '.cursorrules');
        const dest = path.join(dir, '.cursorrules.md');
        try {
          const content = fs.readFileSync(src, 'utf-8');
          fs.writeFileSync(dest, `# Cursor Rules\n> Imported from .cursorrules\n\n${content}`, 'utf-8');
          targets.push('./.cursorrules.md');
        } catch { targets.push('./'); }
      }
      if (fs.existsSync(path.join(dir, '.cursor', 'rules'))) targets.push('./.cursor/rules');
      if (!targets.length) targets.push('./');
      return {
        name: sanitizeName(repoBase),
        version: '1.0.0',
        description: `Cursor rules from ${repoBase}`,
        author: 'Unknown',
        targetPaths: targets,
        raw: {}
      };
    }
  },
  windsurf: {
    id: 'windsurf',
    label: 'Windsurf / Codeium',
    icon: '🔵',
    description: '.windsurfrules file',
    detect: (dir) => fs.existsSync(path.join(dir, '.windsurfrules')),
    resolve: (dir, repoBase) => {
      const src = path.join(dir, '.windsurfrules');
      const dest = path.join(dir, '.windsurfrules.md');
      try {
        const content = fs.readFileSync(src, 'utf-8');
        fs.writeFileSync(dest, `# Windsurf Rules\n> Imported from .windsurfrules\n\n${content}`, 'utf-8');
      } catch {}
      return {
        name: sanitizeName(repoBase),
        version: '1.0.0',
        description: `Windsurf rules from ${repoBase}`,
        author: 'Unknown',
        targetPaths: [fs.existsSync(dest) ? './.windsurfrules.md' : './'],
        raw: {}
      };
    }
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    icon: '⚫',
    description: '.github/copilot-instructions.md',
    detect: (dir) => fs.existsSync(path.join(dir, '.github', 'copilot-instructions.md')),
    resolve: (dir, repoBase) => {
      const targets = ['./.github/copilot-instructions.md'];
      // Also pick up any .md siblings in .github/
      try {
        for (const ent of fs.readdirSync(path.join(dir, '.github'), { withFileTypes: true })) {
          if (ent.isFile() && ent.name.endsWith('.md') && ent.name !== 'copilot-instructions.md') {
            targets.push(`./.github/${ent.name}`);
          }
        }
      } catch {}
      let desc = '';
      try {
        const content = fs.readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf-8');
        const first = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
        if (first) desc = first.trim().slice(0, 120);
      } catch {}
      return {
        name: sanitizeName(repoBase),
        version: '1.0.0',
        description: desc || `GitHub Copilot instructions from ${repoBase}`,
        author: 'Unknown',
        targetPaths: targets,
        raw: {}
      };
    }
  },
  cline: {
    id: 'cline',
    label: 'Cline',
    icon: '🟡',
    description: '.clinerules or .cline/ directory',
    detect: (dir) => {
      return fs.existsSync(path.join(dir, '.clinerules')) ||
        fs.existsSync(path.join(dir, '.cline'));
    },
    resolve: (dir, repoBase) => {
      const targets = [];
      if (fs.existsSync(path.join(dir, '.clinerules'))) {
        const src = path.join(dir, '.clinerules');
        const dest = path.join(dir, '.clinerules.md');
        try {
          const content = fs.readFileSync(src, 'utf-8');
          fs.writeFileSync(dest, `# Cline Rules\n> Imported from .clinerules\n\n${content}`, 'utf-8');
          targets.push('./.clinerules.md');
        } catch { targets.push('./'); }
      }
      if (fs.existsSync(path.join(dir, '.cline'))) targets.push('./.cline');
      if (!targets.length) targets.push('./');
      return {
        name: sanitizeName(repoBase),
        version: '1.0.0',
        description: `Cline rules from ${repoBase}`,
        author: 'Unknown',
        targetPaths: targets,
        raw: {}
      };
    }
  },
  aider: {
    id: 'aider',
    label: 'Aider',
    icon: '🟤',
    description: 'CONVENTIONS.md or .aider.conf.yml',
    detect: (dir) => {
      return fs.existsSync(path.join(dir, 'CONVENTIONS.md')) ||
        fs.existsSync(path.join(dir, '.aider.conf.yml'));
    },
    resolve: (dir, repoBase) => {
      const targets = [];
      if (fs.existsSync(path.join(dir, 'CONVENTIONS.md'))) targets.push('./CONVENTIONS.md');
      if (fs.existsSync(path.join(dir, '.aider.conf.yml'))) {
        const src = path.join(dir, '.aider.conf.yml');
        const dest = path.join(dir, '.aider-config.md');
        try {
          const content = fs.readFileSync(src, 'utf-8');
          fs.writeFileSync(dest, `# Aider Configuration\n> Imported from .aider.conf.yml\n\n\`\`\`yaml\n${content}\n\`\`\``, 'utf-8');
          targets.push('./.aider-config.md');
        } catch {}
      }
      if (!targets.length) targets.push('./');
      let desc = '';
      if (fs.existsSync(path.join(dir, 'CONVENTIONS.md'))) {
        try {
          const content = fs.readFileSync(path.join(dir, 'CONVENTIONS.md'), 'utf-8');
          const first = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
          if (first) desc = first.trim().slice(0, 120);
        } catch {}
      }
      return {
        name: sanitizeName(repoBase),
        version: '1.0.0',
        description: desc || `Aider conventions from ${repoBase}`,
        author: 'Unknown',
        targetPaths: targets,
        raw: {}
      };
    }
  }
};

/**
 * Detect all plugin formats present in a cloned repository directory.
 * Returns an array of { id, label, icon, description } for each detected format.
 */
export function detectFormats(repoDir) {
  const detected = [];
  for (const fmt of Object.values(FORMATS)) {
    try {
      if (fmt.detect(repoDir)) {
        detected.push({ id: fmt.id, label: fmt.label, icon: fmt.icon, description: fmt.description });
      }
    } catch {}
  }
  return detected;
}

/**
 * Install a community plugin from a Git repository.
 *
 * Supports multiple plugin formats:
 *   levi (.levi-plugins/plugin.json), claude (CLAUDE.md), codex (AGENTS.md/codex.md),
 *   cursor (.cursorrules), windsurf (.windsurfrules), copilot (.github/copilot-instructions.md),
 *   cline (.clinerules), aider (CONVENTIONS.md)
 *
 * Lifecycle:
 *   1. Clones into ~/.levi/PLUGINS/.tmp-*
 *   2. Detects available formats
 *   3. If `format` is specified, uses that; if only one detected, uses it; if multiple, returns needsChoice
 *   4. Resolves format → manifest + target paths
 *   5. Renames folder to canonical name, scans & indexes files
 */
export async function installPlugin(repoUrl, { onProgress = null, format = null } = {}) {
  if (!repoUrl || typeof repoUrl !== 'string') {
    return { ok: false, error: 'A valid Git repository URL is required.' };
  }

  ensurePluginsDir();

  const cleanUrl = repoUrl.trim();
  const repoBase = path.basename(cleanUrl).replace(/\.git$/i, '');
  const tempDirName = `.tmp-${Date.now()}-${sanitizeName(repoBase) || 'plugin'}`;
  const tempDirPath = path.join(PLUGINS_DIR, tempDirName);

  onProgress?.('Cloning repository...');
  try {
    await execa('git', ['clone', '--depth', '1', cleanUrl, tempDirPath], {
      timeout: 90000,
      reject: true
    });
  } catch (err) {
    try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `Failed to clone repository: ${err.message}` };
  }

  // Detect all formats present in the cloned repo
  onProgress?.('Detecting plugin format...');
  const detected = detectFormats(tempDirPath);

  if (!detected.length) {
    // Fallback: scan for any .md files in root
    const hasAnyMd = fs.readdirSync(tempDirPath).some(f => f.endsWith('.md'));
    if (!hasAnyMd) {
      try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
      return {
        ok: false,
        error: 'No recognized plugin format found. Supported: Levi (.levi-plugins/plugin.json), Claude Code (CLAUDE.md), Codex (AGENTS.md/codex.md), Cursor (.cursorrules), Windsurf (.windsurfrules), GitHub Copilot (.github/copilot-instructions.md), Cline (.clinerules), Aider (CONVENTIONS.md).'
      };
    }
    // If there are loose .md files but no format marker, treat as generic
    detected.push({ id: 'generic', label: 'Generic Markdown', icon: '📄', description: 'Loose .md files in repository root' });
  }

  // Determine which format to use
  let chosenFormat = format;
  if (!chosenFormat && detected.length === 1) {
    chosenFormat = detected[0].id;
  } else if (!chosenFormat && detected.length > 1) {
    // Return so the UI can ask the user to pick
    return {
      ok: false,
      needsChoice: true,
      formats: detected,
      tempDir: tempDirPath,
      repoUrl: cleanUrl,
      repoBase
    };
  }

  return finalizeInstall(tempDirPath, cleanUrl, repoBase, chosenFormat, onProgress);
}

/**
 * Finalize plugin installation after format has been chosen.
 * Can be called directly when the user picks a format from the multi-choice prompt.
 */
export function finalizeInstall(tempDirPath, cleanUrl, repoBase, chosenFormat, onProgress) {
  // Resolve format to manifest + targets
  let resolved;
  const fmt = FORMATS[chosenFormat];

  if (fmt) {
    try {
      resolved = fmt.resolve(tempDirPath, repoBase);
    } catch (err) {
      try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
      return { ok: false, error: `Failed to parse ${fmt.label} format: ${err.message}` };
    }
  } else {
    // Generic fallback: index all .md files
    resolved = {
      name: sanitizeName(repoBase),
      version: '1.0.0',
      description: `Plugin from ${repoBase}`,
      author: 'Unknown',
      targetPaths: ['./'],
      raw: {}
    };
  }

  const canonicalName = resolved.name || sanitizeName(repoBase);
  if (!canonicalName) {
    try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
    return { ok: false, error: 'Could not determine a valid plugin name.' };
  }

  const finalDirPath = path.join(PLUGINS_DIR, canonicalName);

  if (fs.existsSync(finalDirPath)) {
    try { fs.rmSync(finalDirPath, { recursive: true, force: true }); } catch {}
  }

  try {
    fs.renameSync(tempDirPath, finalDirPath);
  } catch (err) {
    try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `Failed to finalize plugin directory: ${err.message}` };
  }

  onProgress?.(`Installing as ${FORMATS[chosenFormat]?.label || 'Generic'} format...`);

  const files = scanPluginTargets(finalDirPath, resolved.targetPaths);

  const meta = readPluginsMeta();
  meta.plugins[canonicalName] = {
    name: canonicalName,
    format: chosenFormat,
    version: resolved.version || '1.0.0',
    description: resolved.description || 'Community plugin',
    author: resolved.author || 'Unknown',
    url: cleanUrl,
    targetPaths: resolved.targetPaths,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filesCount: files.length,
    files: files.map((f) => ({
      id: `${canonicalName}/${f.relToPlugin.replace(/\.md$/, '')}`,
      relPath: `${canonicalName}/${f.relToPlugin}`,
      path: f.filePath,
      title: f.title,
      summary: f.summary
    }))
  };
  writePluginsMeta(meta);

  // Trigger index sync in background
  import('./retrieval.js').then(({ retrieve }) => {
    retrieve({ query: 'sync', limit: 1, rebuild: false }).catch(() => {});
  }).catch(() => {});

  const formatLabel = FORMATS[chosenFormat]?.label || 'Generic';

  return {
    ok: true,
    name: canonicalName,
    format: chosenFormat,
    formatLabel,
    version: resolved.version || '1.0.0',
    description: resolved.description || '',
    author: resolved.author || 'Unknown',
    filesCount: files.length,
    path: finalDirPath,
    manifest: resolved.raw || {}
  };
}

/**
 * List all installed plugins.
 */
export function listPlugins() {
  ensurePluginsDir();
  const meta = readPluginsMeta();
  let changed = false;

  const installed = [];

  try {
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (!ent.isDirectory()) continue;

      const pluginDir = path.join(PLUGINS_DIR, ent.name);
      const manifestPath = path.join(pluginDir, '.levi-plugins', 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;

      let record = meta.plugins[ent.name];
      if (!record) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const targetPaths = Array.isArray(manifest.plugins) ? manifest.plugins : ['./'];
          const files = scanPluginTargets(pluginDir, targetPaths);
          record = {
            name: ent.name,
            version: manifest.version || '1.0.0',
            description: manifest.description || '',
            author: manifest.author || 'Unknown',
            targetPaths,
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            filesCount: files.length,
            files: files.map((f) => ({
              id: `${ent.name}/${f.relToPlugin.replace(/\.md$/, '')}`,
              relPath: `${ent.name}/${f.relToPlugin}`,
              path: f.filePath,
              title: f.title,
              summary: f.summary
            }))
          };
          meta.plugins[ent.name] = record;
          changed = true;
        } catch {}
      }

      if (record) {
        installed.push({ ...record, dirPath: pluginDir });
      }
    }
  } catch {}

  // Prune any plugins that were deleted from disk
  for (const name of Object.keys(meta.plugins)) {
    const p = path.join(PLUGINS_DIR, name);
    if (!fs.existsSync(p)) {
      delete meta.plugins[name];
      changed = true;
    }
  }

  if (changed) {
    writePluginsMeta(meta);
  }

  return installed;
}

export function getPlugin(name) {
  const clean = sanitizeName(name);
  if (!clean) return null;
  const meta = readPluginsMeta();
  return meta.plugins[clean] || null;
}

/**
 * Update an installed plugin via git pull.
 */
export async function updatePlugin(name, { onProgress = null } = {}) {
  const clean = sanitizeName(name);
  if (!clean) return { ok: false, error: 'Plugin name required.' };

  const pluginDir = path.join(PLUGINS_DIR, clean);
  if (!fs.existsSync(pluginDir)) {
    return { ok: false, error: `Plugin "${clean}" is not installed.` };
  }

  onProgress?.(`Pulling latest changes for ${clean}...`);
  try {
    await execa('git', ['pull'], { cwd: pluginDir, timeout: 60000 });
  } catch (err) {
    return { ok: false, error: `git pull failed: ${err.message}` };
  }

  const manifestPath = path.join(pluginDir, '.levi-plugins', 'plugin.json');
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {}

  const targetPaths = Array.isArray(manifest.plugins) ? manifest.plugins : ['./'];
  const files = scanPluginTargets(pluginDir, targetPaths);

  const meta = readPluginsMeta();
  meta.plugins[clean] = {
    ...(meta.plugins[clean] || {}),
    name: clean,
    version: manifest.version || meta.plugins[clean]?.version || '1.0.0',
    description: manifest.description || meta.plugins[clean]?.description || '',
    author: manifest.author || meta.plugins[clean]?.author || 'Unknown',
    updatedAt: new Date().toISOString(),
    filesCount: files.length,
    files: files.map((f) => ({
      id: `${clean}/${f.relToPlugin.replace(/\.md$/, '')}`,
      relPath: `${clean}/${f.relToPlugin}`,
      path: f.filePath,
      title: f.title,
      summary: f.summary
    }))
  };
  writePluginsMeta(meta);

  return { ok: true, name: clean, filesCount: files.length, version: manifest.version || '1.0.0' };
}

/**
 * Remove an installed plugin.
 */
export function removePlugin(name) {
  const clean = sanitizeName(name);
  if (!clean) return { ok: false, error: 'Plugin name required.' };

  const pluginDir = path.join(PLUGINS_DIR, clean);
  if (!fs.existsSync(pluginDir)) {
    return { ok: false, error: `Plugin "${clean}" not found.` };
  }

  try {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: `Failed to remove plugin: ${err.message}` };
  }

  const meta = readPluginsMeta();
  delete meta.plugins[clean];
  writePluginsMeta(meta);

  return { ok: true, name: clean };
}

/**
 * Return a list of all markdown files across all active plugins for retrieval indexing.
 */
export function listPluginFiles() {
  const plugins = listPlugins();
  const out = [];
  for (const p of plugins) {
    if (Array.isArray(p.files)) {
      for (const f of p.files) {
        if (f.path && fs.existsSync(f.path)) {
          out.push({
            path: f.path,
            relPath: f.relPath,
            id: f.id,
            title: f.title,
            summary: f.summary,
            plugin: p.name
          });
        }
      }
    }
  }
  return out;
}

/**
 * Generate lazy-loaded prompt lines for the AI model context:
 * - <plugin>/<skill> (file: ~/.levi/PLUGINS/<relPath>): <title> — <summary>
 */
export function getPluginsPromptList(query = '') {
  const plugins = listPlugins();
  const allFiles = [];

  for (const p of plugins) {
    if (Array.isArray(p.files)) {
      for (const f of p.files) {
        allFiles.push({
          plugin: p.name,
          ...f
        });
      }
    }
  }

  let selected = allFiles;

  // Progressive disclosure: If many plugin files exist and query is available, filter top matches
  if (allFiles.length > 10 && query && typeof query === 'string') {
    const qTokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    if (qTokens.length) {
      const scored = allFiles.map((f) => {
        const text = `${f.plugin} ${f.id} ${f.title || ''} ${f.summary || ''}`.toLowerCase();
        let score = 0;
        for (const t of qTokens) {
          if (text.includes(t)) score += 1;
        }
        return { f, score };
      });
      scored.sort((a, b) => b.score - a.score);
      const matches = scored.filter((x) => x.score > 0).map((x) => x.f);
      selected = matches.length ? matches.slice(0, 8) : scored.slice(0, 8).map((x) => x.f);
    }
  }

  return selected.map((f) => {
    const desc = f.title && f.summary ? `${f.title} — ${f.summary}` : (f.summary || f.title || `Plugin playbook: ${f.id}`);
    return {
      id: f.id,
      plugin: f.plugin,
      relPath: f.relPath,
      path: f.path,
      line: `- ${f.id} (file: ~/.levi/PLUGINS/${f.relPath}): ${desc}`
    };
  });
}
