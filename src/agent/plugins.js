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

// ---- Multi-Manifest & Multi-Format Plugin System ----

/**
 * Universal reader for plugin.json manifests across all ecosystems.
 * Extracts canonical metadata and normalizes playbook target paths.
 */
export function readManifest(filePath, repoBase) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let targets = raw.plugins || raw.skills || raw.rules || raw.commands || raw.agents || raw.playbooks || raw.prompts || raw.instructions || raw.files;
    if (typeof targets === 'string') targets = [targets];
    if (!Array.isArray(targets) || !targets.length) {
      targets = ['./'];
    }
    const name = sanitizeName(raw.name) || sanitizeName(repoBase);
    let author = 'Unknown';
    if (typeof raw.author === 'string') author = raw.author;
    else if (raw.author && typeof raw.author.name === 'string') author = raw.author.name;

    return {
      name,
      version: raw.version || '1.0.0',
      description: raw.description || '',
      author,
      targetPaths: targets,
      raw
    };
  } catch (err) {
    return null;
  }
}

/**
 * Manifest definitions for all supported AI CLI ecosystems.
 */
export const MANIFEST_SPECS = [
  {
    id: 'levi',
    label: 'Levi Manifest',
    icon: '🔷',
    paths: ['.levi-plugins/plugin.json', '.levi/plugin.json'],
    defaultTargets: ['./']
  },
  {
    id: 'claude',
    label: 'Claude Code Manifest',
    icon: '🟠',
    paths: [
      '.claude-plugins/plugin.json',
      '.claude/plugin.json',
      '.claude-plugin/plugin.json',
      '.claude/claude-plugin.json'
    ],
    defaultTargets: ['./CLAUDE.md', './.claude/commands', './.claude', './']
  },
  {
    id: 'codex',
    label: 'Codex / OpenAI Manifest',
    icon: '🟢',
    paths: [
      '.codex-plugins/plugin.json',
      '.codex/plugin.json',
      '.openai-plugins/plugin.json',
      '.openai/plugin.json'
    ],
    defaultTargets: ['./AGENTS.md', './codex.md', './.codex', './']
  },
  {
    id: 'cursor',
    label: 'Cursor Manifest',
    icon: '🟣',
    paths: [
      '.cursor-plugins/plugin.json',
      '.cursor/plugin.json',
      '.cursor/rules.json'
    ],
    defaultTargets: ['./.cursorrules', './.cursor/rules', './']
  },
  {
    id: 'windsurf',
    label: 'Windsurf Manifest',
    icon: '🔵',
    paths: [
      '.windsurf-plugins/plugin.json',
      '.windsurf/plugin.json'
    ],
    defaultTargets: ['./.windsurfrules', './']
  },
  {
    id: 'cline',
    label: 'Cline / Roo Code Manifest',
    icon: '🟡',
    paths: [
      '.cline-plugins/plugin.json',
      '.cline/plugin.json',
      '.roo-plugins/plugin.json',
      '.roo/plugin.json'
    ],
    defaultTargets: ['./.clinerules', './.cline', './']
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot Manifest',
    icon: '⚫',
    paths: [
      '.copilot-plugins/plugin.json',
      '.github/plugin.json'
    ],
    defaultTargets: ['./.github/copilot-instructions.md', './.github', './']
  },
  {
    id: 'standard',
    label: 'Standard Plugin Manifest',
    icon: '📦',
    paths: [
      'plugin.json',
      '.plugins/plugin.json'
    ],
    defaultTargets: ['./']
  }
];

/**
 * File-based rule fallbacks for repositories that do not provide a plugin.json manifest.
 */
export const RULE_SPECS = [
  {
    id: 'claude-rules',
    label: 'Claude Code Rules',
    icon: '🟠',
    description: 'CLAUDE.md or .claude/ directory',
    detect: (dir) => fs.existsSync(path.join(dir, 'CLAUDE.md')) || fs.existsSync(path.join(dir, '.claude')),
    resolve: (dir, repoBase) => {
      const targets = [];
      if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) targets.push('./CLAUDE.md');
      if (fs.existsSync(path.join(dir, '.claude', 'commands'))) targets.push('./.claude/commands');
      if (fs.existsSync(path.join(dir, '.claude'))) {
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
        description: desc || `Claude Code rules from ${repoBase}`,
        author: 'Unknown',
        targetPaths: targets,
        raw: {}
      };
    }
  },
  {
    id: 'codex-rules',
    label: 'Codex / OpenAI Rules',
    icon: '🟢',
    description: 'AGENTS.md, codex.md, or .codex/ directory',
    detect: (dir) => fs.existsSync(path.join(dir, 'AGENTS.md')) || fs.existsSync(path.join(dir, 'codex.md')) || fs.existsSync(path.join(dir, 'CODEX.md')) || fs.existsSync(path.join(dir, '.codex')),
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
        description: desc || `Codex/OpenAI rules from ${repoBase}`,
        author: 'Unknown',
        targetPaths: targets,
        raw: {}
      };
    }
  },
  {
    id: 'cursor-rules',
    label: 'Cursor Rules',
    icon: '🟣',
    description: '.cursorrules or .cursor/rules/ directory',
    detect: (dir) => fs.existsSync(path.join(dir, '.cursorrules')) || fs.existsSync(path.join(dir, '.cursor', 'rules')),
    resolve: (dir, repoBase) => {
      const targets = [];
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
  {
    id: 'windsurf-rules',
    label: 'Windsurf Rules',
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
  {
    id: 'copilot-rules',
    label: 'GitHub Copilot Rules',
    icon: '⚫',
    description: '.github/copilot-instructions.md',
    detect: (dir) => fs.existsSync(path.join(dir, '.github', 'copilot-instructions.md')),
    resolve: (dir, repoBase) => {
      const targets = ['./.github/copilot-instructions.md'];
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
  {
    id: 'cline-rules',
    label: 'Cline Rules',
    icon: '🟡',
    description: '.clinerules or .cline/ directory',
    detect: (dir) => fs.existsSync(path.join(dir, '.clinerules')) || fs.existsSync(path.join(dir, '.cline')),
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
  {
    id: 'aider-rules',
    label: 'Aider Conventions',
    icon: '🟤',
    description: 'CONVENTIONS.md or .aider.conf.yml',
    detect: (dir) => fs.existsSync(path.join(dir, 'CONVENTIONS.md')) || fs.existsSync(path.join(dir, '.aider.conf.yml')),
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
];

/**
 * Scan a repository directory for all manifests and rule configurations.
 * Returns an array of detected options.
 */
export function detectFormats(repoDir, repoBase = '') {
  const detected = [];
  const base = repoBase || path.basename(repoDir);

  // 1. Scan for JSON manifests across CLI ecosystems
  for (const spec of MANIFEST_SPECS) {
    for (const relPath of spec.paths) {
      const fullPath = path.join(repoDir, relPath);
      if (fs.existsSync(fullPath)) {
        const meta = readManifest(fullPath, base);
        if (meta) {
          detected.push({
            id: spec.id,
            type: 'manifest',
            manifestPath: relPath,
            manifestFullPath: fullPath,
            label: `${spec.label}`,
            icon: spec.icon,
            description: `${relPath} (name: "${meta.name}")`,
            meta
          });
          break; // Use the highest priority path found for this spec
        }
      }
    }
  }

  // 2. Scan rule-file based formats if no manifests found, or as secondary options
  if (!detected.length) {
    for (const spec of RULE_SPECS) {
      try {
        if (spec.detect(repoDir)) {
          detected.push({
            id: spec.id,
            type: 'rules',
            manifestPath: null,
            manifestFullPath: null,
            label: spec.label,
            icon: spec.icon,
            description: spec.description || spec.label,
            resolver: spec.resolve
          });
        }
      } catch {}
    }
  }

  // 3. Fallback: check if loose .md files exist in root
  if (!detected.length) {
    try {
      const entries = fs.readdirSync(repoDir, { withFileTypes: true });
      if (entries.some(e => e.isFile() && e.name.endsWith('.md'))) {
        detected.push({
          id: 'generic',
          type: 'generic',
          manifestPath: null,
          manifestFullPath: null,
          label: 'Generic Markdown',
          icon: '📄',
          description: 'Loose markdown playbooks in repository root'
        });
      }
    } catch {}
  }

  return detected;
}

/**
 * Install a community plugin from a Git repository.
 * Scans for manifests, prompts for choice if multiple are found, and indexes playbooks.
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

  // Detect all manifests and formats present in cloned repo
  onProgress?.('Scanning repository for plugin manifests...');
  const detected = detectFormats(tempDirPath, repoBase);

  if (!detected.length) {
    try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
    return {
      ok: false,
      error: 'No recognized plugin manifest or rules found. Supported: .levi-plugins/plugin.json, .claude-plugins/plugin.json, .codex-plugins/plugin.json, .cursor-plugins/plugin.json, .windsurf-plugins/plugin.json, .cline-plugins/plugin.json, .copilot-plugins/plugin.json, or plugin.json.'
    };
  }

  // If a specific format was explicitly requested via CLI argument:
  let chosenTarget = null;
  if (format) {
    const fStr = String(format).trim().toLowerCase();
    chosenTarget = detected.find(d =>
      d.id.toLowerCase() === fStr ||
      d.id.toLowerCase().replace(/-rules$/, '') === fStr ||
      (d.manifestPath && d.manifestPath.toLowerCase().includes(fStr)) ||
      d.label.toLowerCase().includes(fStr)
    );
    if (!chosenTarget) {
      // Allow passing a format ID directly even if not in the default detected list
      chosenTarget = fStr;
    }
  }

  // If no format specified and multiple manifests found: ask user to choose!
  if (!chosenTarget && detected.length > 1) {
    return {
      ok: false,
      needsChoice: true,
      formats: detected,
      tempDir: tempDirPath,
      repoUrl: cleanUrl,
      repoBase
    };
  }

  // If single format/manifest found, install directly
  const target = chosenTarget || detected[0];
  return finalizeInstall(tempDirPath, cleanUrl, repoBase, target, onProgress);
}

/**
 * Finalize plugin installation after format/manifest has been selected.
 */
export function finalizeInstall(tempDirPath, cleanUrl, repoBase, chosenFormatOrObj, onProgress) {
  let resolved = null;
  let chosenId = null;
  let formatLabel = 'Generic';
  let manifestRelPath = null;

  if (chosenFormatOrObj && typeof chosenFormatOrObj === 'object') {
    chosenId = chosenFormatOrObj.id;
    formatLabel = chosenFormatOrObj.label || chosenId;
    manifestRelPath = chosenFormatOrObj.manifestPath || null;
    if (chosenFormatOrObj.meta) {
      resolved = chosenFormatOrObj.meta;
    } else if (chosenFormatOrObj.resolver) {
      resolved = chosenFormatOrObj.resolver(tempDirPath, repoBase);
    }
  } else if (typeof chosenFormatOrObj === 'string') {
    chosenId = chosenFormatOrObj.trim().toLowerCase();
    const detected = detectFormats(tempDirPath, repoBase);
    const match = detected.find(d =>
      d.id === chosenId ||
      d.id.replace(/-rules$/, '') === chosenId ||
      (d.manifestPath && d.manifestPath.toLowerCase().includes(chosenId)) ||
      d.label.toLowerCase().includes(chosenId)
    );
    if (match) {
      formatLabel = match.label;
      manifestRelPath = match.manifestPath || null;
      if (match.meta) resolved = match.meta;
      else if (match.resolver) resolved = match.resolver(tempDirPath, repoBase);
    }
  }

  if (!resolved) {
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

  onProgress?.(`Configuring playbooks for ${formatLabel}...`);

  const files = scanPluginTargets(finalDirPath, resolved.targetPaths);

  const meta = readPluginsMeta();
  meta.plugins[canonicalName] = {
    name: canonicalName,
    format: chosenId || 'generic',
    formatLabel,
    manifestPath: manifestRelPath,
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

  return {
    ok: true,
    name: canonicalName,
    format: chosenId || 'generic',
    formatLabel,
    manifestPath: manifestRelPath,
    version: resolved.version || '1.0.0',
    description: resolved.description || '',
    author: resolved.author || 'Unknown',
    filesCount: files.length,
    path: finalDirPath,
    manifest: resolved.raw || {}
  };
}

/**
 * List all installed plugins. Auto-recovers metadata if missing.
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
      let record = meta.plugins[ent.name];

      // Auto-recover if record was missing from plugins.json
      if (!record) {
        const detected = detectFormats(pluginDir, ent.name);
        if (detected.length) {
          const first = detected[0];
          const files = scanPluginTargets(pluginDir, first.meta?.targetPaths || ['./']);
          record = {
            name: ent.name,
            format: first.id,
            formatLabel: first.label,
            manifestPath: first.manifestPath || null,
            version: first.meta?.version || '1.0.0',
            description: first.meta?.description || '',
            author: first.meta?.author || 'Unknown',
            targetPaths: first.meta?.targetPaths || ['./'],
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
        }
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

  const meta = readPluginsMeta();
  const existing = meta.plugins[clean] || {};

  let targetPaths = existing.targetPaths || ['./'];
  let version = existing.version || '1.0.0';
  let description = existing.description || '';
  let author = existing.author || 'Unknown';

  if (existing.manifestPath && fs.existsSync(path.join(pluginDir, existing.manifestPath))) {
    const manifest = readManifest(path.join(pluginDir, existing.manifestPath), clean);
    if (manifest) {
      targetPaths = manifest.targetPaths;
      version = manifest.version || version;
      description = manifest.description || description;
      author = manifest.author || author;
    }
  } else {
    const detected = detectFormats(pluginDir, clean);
    if (detected.length && detected[0].meta) {
      targetPaths = detected[0].meta.targetPaths;
      version = detected[0].meta.version || version;
      description = detected[0].meta.description || description;
      author = detected[0].meta.author || author;
    }
  }

  const files = scanPluginTargets(pluginDir, targetPaths);
  meta.plugins[clean] = {
    ...existing,
    name: clean,
    version,
    description,
    author,
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

  return { ok: true, name: clean, filesCount: files.length, version };
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
