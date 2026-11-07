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

/**
 * Install a community plugin from a Git repository:
 * 1. Clones into ~/.levi/PLUGINS/<repo-name>
 * 2. Checks .levi-plugins/plugin.json
 * 3. Renames folder to the canonical name in plugin.json
 * 4. Indexes targeted files
 */
export async function installPlugin(repoUrl, { onProgress = null } = {}) {
  if (!repoUrl || typeof repoUrl !== 'string') {
    return { ok: false, error: 'A valid Git repository URL is required.' };
  }

  ensurePluginsDir();

  // Extract initial repo name from URL (e.g. "https://github.com/owner/design-suite.git" -> "design-suite")
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

  // Check for .levi-plugins/plugin.json manifest
  const manifestPath = path.join(tempDirPath, '.levi-plugins', 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
    return {
      ok: false,
      error: 'Repository rejected: missing .levi-plugins/plugin.json manifest file.'
    };
  }

  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `Invalid .levi-plugins/plugin.json syntax: ${err.message}` };
  }

  // Canonical plugin name from manifest
  const canonicalName = sanitizeName(manifest.name) || sanitizeName(repoBase);
  if (!canonicalName) {
    try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
    return { ok: false, error: 'Plugin manifest must specify a valid "name".' };
  }

  const finalDirPath = path.join(PLUGINS_DIR, canonicalName);

  // If a plugin with this name is already installed, replace it cleanly
  if (fs.existsSync(finalDirPath)) {
    try { fs.rmSync(finalDirPath, { recursive: true, force: true }); } catch {}
  }

  try {
    fs.renameSync(tempDirPath, finalDirPath);
  } catch (err) {
    try { fs.rmSync(tempDirPath, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `Failed to finalize plugin directory: ${err.message}` };
  }

  // Target paths in manifest (e.g. plugins: ["./ui-ux-skills", "./video-editing-skills"])
  const targetPaths = Array.isArray(manifest.plugins) ? manifest.plugins : (manifest.skills || ['./']);
  const files = scanPluginTargets(finalDirPath, targetPaths);

  const meta = readPluginsMeta();
  meta.plugins[canonicalName] = {
    name: canonicalName,
    version: manifest.version || '1.0.0',
    description: manifest.description || 'Community Levi plugin',
    author: manifest.author || 'Unknown',
    url: cleanUrl,
    targetPaths,
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
    version: manifest.version || '1.0.0',
    description: manifest.description || '',
    author: manifest.author || 'Unknown',
    filesCount: files.length,
    path: finalDirPath,
    manifest
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
