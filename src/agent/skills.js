import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { chat } from './client.js';
import { openInEditor, getPreferredEditor } from './editor.js';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const SKILLS_DIR = path.join(LEVI_HOME, 'SKILLS');
const META_FILE = path.join(LEVI_HOME, 'skills.json');

// --- Frontmatter helpers ---
export function parseFrontmatter(content) {
  if (!content.startsWith('---')) return { meta: {}, body: content };
  const end = content.indexOf('---', 3);
  if (end === -1) return { meta: {}, body: content };
  const raw = content.slice(3, end).trim();
  const meta = {};
  for (const line of raw.split('\n')) {
    const col = line.indexOf(':');
    if (col === -1) continue;
    const key = line.slice(0, col).trim();
    const val = line.slice(col + 1).trim();
    if (val.startsWith('[')) {
      try { meta[key] = JSON.parse(val); } catch { meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')); }
    } else if (val === 'true') {
      meta[key] = true;
    } else if (val === 'false') {
      meta[key] = false;
    } else if (!isNaN(Number(val)) && val !== '') {
      meta[key] = Number(val);
    } else {
      meta[key] = val;
    }
  }
  return { meta, body: content.slice(end + 3).trim() };
}

export function serializeFrontmatter(meta, body) {
  if (!meta || !Object.keys(meta).length) return body;
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map(x => `"${x}"`).join(', ')}]`;
      return `${k}: ${v}`;
    });
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

export function getSkillsDir() {
  return SKILLS_DIR;
}

export function sanitizeSlug(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export function sanitizeFolderName(raw) {
  return sanitizeSlug(raw);
}

export function sanitizeSkillName(raw) {
  return sanitizeSlug(raw);
}

export function ensureSkillsDir() {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

export function readSkillsMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      const data = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
      if (data && typeof data.skills === 'object') {
        if (!data.folders) data.folders = {};
        return data;
      }
    }
  } catch {}
  return { folders: {}, skills: {} };
}

export function writeSkillsMeta(meta) {
  try {
    if (!fs.existsSync(LEVI_HOME)) fs.mkdirSync(LEVI_HOME, { recursive: true });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save skills metadata:', err.message);
  }
}

/**
 * Recursively crawl SKILLS_DIR to discover all nested folders, subfolders, and .md files.
 */
export function scanSkillsDirRecursively(dirPath = SKILLS_DIR, baseDir = dirPath) {
  const folders = [];
  const files = [];

  function walk(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const fullPath = path.join(current, ent.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

      if (ent.isDirectory()) {
        folders.push({
          relPath,
          fullPath,
          name: ent.name
        });
        walk(fullPath);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        const parsed = path.parse(relPath);
        const folder = parsed.dir ? parsed.dir.replace(/\\/g, '/') : 'GENERAL';
        const file = parsed.base;
        const name = parsed.name;
        const id = relPath.replace(/\.md$/, '');
        files.push({
          id,
          name,
          folder,
          file,
          relPath,
          filePath: fullPath
        });
      }
    }
  }

  ensureSkillsDir();
  walk(dirPath);
  return { folders, files };
}

/**
 * Parse input arguments into a structured skill target:
 * Supports:
 * - parseSkillTarget("UI-UX-SKILLS", "ui")
 * - parseSkillTarget("UI-UX-SKILLS", "COMPONENTS", "button")
 * - parseSkillTarget("UI-UX-SKILLS/COMPONENTS/button")
 * - parseSkillTarget("UI-UX-SKILLS/ui")
 * - parseSkillTarget("ui") -> matches existing skill by name, or defaults to GENERAL/ui
 */
export function parseSkillTarget(...rawArgs) {
  const parts = rawArgs
    .flat()
    .filter(Boolean)
    .map(String)
    .join(' ')
    .trim()
    .split(/[\s/]+/)
    .map(sanitizeSlug)
    .filter(Boolean);

  if (!parts.length) return null;

  ensureSkillsDir();

  // If only 1 argument token was supplied
  if (parts.length === 1) {
    const single = parts[0];
    const directFolder = path.join(SKILLS_DIR, single);
    if (fs.existsSync(directFolder) && fs.statSync(directFolder).isDirectory()) {
      return {
        isFolderOnly: true,
        folder: single,
        file: '',
        fileName: '',
        id: single,
        relPath: single,
        filePath: directFolder
      };
    }

    // Check if single matches an existing skill by id or file name across any folder
    const all = listSkills();
    const match = all.find((s) => s.name === single || s.id === single || s.file === `${single}.md`);
    if (match) {
      return {
        isFolderOnly: false,
        folder: match.folder,
        file: match.name,
        fileName: match.file,
        id: match.id,
        relPath: match.relPath,
        filePath: match.filePath
      };
    }

    return {
      isFolderOnly: false,
      folder: 'GENERAL',
      file: single,
      fileName: `${single}.md`,
      id: single,
      relPath: `${single}.md`,
      filePath: path.join(SKILLS_DIR, `${single}.md`)
    };
  }

  // Multiple tokens:
  // e.g. ["UI-UX-SKILLS", "COMPONENTS", "button"]
  // e.g. ["UI-UX-SKILLS", "ui"]
  const file = parts[parts.length - 1];
  const folderParts = parts.slice(0, parts.length - 1);
  const folder = folderParts.join('/');
  const id = `${folder}/${file}`;
  const fileName = `${file}.md`;
  const relPath = `${folder}/${fileName}`;
  const filePath = path.join(SKILLS_DIR, ...folderParts, fileName);

  return {
    isFolderOnly: false,
    folder,
    file,
    fileName,
    id,
    relPath,
    filePath
  };
}

/**
 * Parse arguments specifically for folder operations (/skills:new, /skills:folder)
 */
export function parseSkillFolder(...rawArgs) {
  const parts = rawArgs
    .flat()
    .filter(Boolean)
    .map(String)
    .join(' ')
    .trim()
    .split(/[\s/]+/)
    .map(sanitizeFolderName)
    .filter(Boolean);

  if (!parts.length) return null;
  const folder = parts.join('/');
  const fullPath = path.join(SKILLS_DIR, ...parts);
  return { folder, fullPath, parts };
}

/**
 * List all skill folders and subfolders with direct and recursive file counts.
 */
export function listSkillFolders() {
  ensureSkillsDir();
  const { folders, files } = scanSkillsDirRecursively(SKILLS_DIR);
  return folders.map((f) => {
    const directFiles = files.filter((x) => x.folder === f.relPath);
    const subFiles = files.filter((x) => x.folder === f.relPath || x.folder.startsWith(f.relPath + '/'));
    return {
      name: f.relPath,
      baseName: f.name,
      count: directFiles.length,
      totalCount: subFiles.length,
      path: f.fullPath
    };
  });
}

/**
 * Create a new skill folder or nested subfolder branch under ~/.levi/SKILLS/
 */
export function createSkillFolder(...rawArgs) {
  const parsed = parseSkillFolder(...rawArgs);
  if (!parsed || !parsed.folder) {
    return { ok: false, error: 'Folder name required.' };
  }
  ensureSkillsDir();
  if (fs.existsSync(parsed.fullPath)) {
    return { ok: true, folder: parsed.folder, path: parsed.fullPath, existing: true };
  }
  fs.mkdirSync(parsed.fullPath, { recursive: true });
  const meta = readSkillsMeta();
  if (!meta.folders) meta.folders = {};
  meta.folders[parsed.folder] = {
    name: parsed.folder,
    createdAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);
  return { ok: true, folder: parsed.folder, path: parsed.fullPath, existing: false };
}

/**
 * Scan SKILLS_DIR recursively for all skills organized by folder and subfolders.
 * Synchronizes discovered files with skills.json metadata.
 */
export function listSkills(filterFolder = null) {
  ensureSkillsDir();
  const meta = readSkillsMeta();
  let changed = false;
  const { files } = scanSkillsDirRecursively(SKILLS_DIR);

  const result = [];
  const activeIds = new Set();

  for (const f of files) {
    if (filterFolder) {
      const matchFolder = f.folder.toLowerCase() === filterFolder.toLowerCase() ||
        f.folder.toLowerCase().startsWith(filterFolder.toLowerCase() + '/') ||
        f.id.toLowerCase().startsWith(filterFolder.toLowerCase() + '/');
      if (!matchFolder) continue;
    }

    activeIds.add(f.id);

    if (!meta.skills[f.id]) {
      let content = '';
      try { content = fs.readFileSync(f.filePath, 'utf-8'); } catch {}
      const { meta: fmMeta, body: fmBody } = parseFrontmatter(content);
      const lines = (fmBody || content).split('\n').map((l) => l.trim()).filter(Boolean);
      const h1 = lines.find((l) => l.startsWith('#'));
      const title = fmMeta.title || (h1 ? h1.replace(/^#+\s*/, '').trim() : f.name);
      const body = lines.find((l) => !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('>'));
      const summary = body ? body.slice(0, 120) : `Skill instructions for ${f.id}`;
      meta.skills[f.id] = {
        id: f.id,
        name: f.name,
        folder: f.folder,
        file: f.file,
        relPath: f.relPath,
        title,
        summary,
        triggers: fmMeta.triggers || [],
        patterns: fmMeta.patterns || [],
        platforms: fmMeta.platforms || [],
        confidence: fmMeta.confidence || 0.8,
        disabled: false,
        usedCount: fmMeta.used_count || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      changed = true;
    } else if (!meta.skills[f.id].triggers) {
      try {
        const raw = fs.readFileSync(f.filePath, 'utf-8');
        const { meta: fmMeta } = parseFrontmatter(raw);
        meta.skills[f.id].triggers = fmMeta.triggers || [];
        meta.skills[f.id].patterns = fmMeta.patterns || [];
        meta.skills[f.id].platforms = fmMeta.platforms || [];
        if (fmMeta.title) meta.skills[f.id].title = fmMeta.title;
        changed = true;
      } catch {}
    }

    const rec = meta.skills[f.id];
    result.push({
      ...rec,
      id: f.id,
      name: f.name,
      folder: f.folder,
      file: f.file,
      relPath: f.relPath,
      filePath: f.filePath
    });
  }

  // Prune deleted skills from meta
  for (const id of Object.keys(meta.skills)) {
    if (!activeIds.has(id)) {
      const p = path.join(SKILLS_DIR, meta.skills[id].relPath || `${id}.md`);
      if (!fs.existsSync(p)) {
        delete meta.skills[id];
        changed = true;
      }
    }
  }

  if (changed) {
    writeSkillsMeta(meta);
  }

  return result;
}

export function getSkill(...rawArgs) {
  const parsed = parseSkillTarget(...rawArgs);
  if (!parsed || !parsed.file) return null;
  const meta = readSkillsMeta();
  return meta.skills[parsed.id] || null;
}

/**
 * Create a new skill file inside a folder or subfolder.
 * e.g. createSkill('UI-UX-SKILLS', 'COMPONENTS', 'button')
 */
export async function createSkill(...rawArgs) {
  const parsed = parseSkillTarget(...rawArgs);
  if (!parsed || !parsed.folder || !parsed.file) {
    return { ok: false, error: 'Usage: /skills:create <folder> [subfolder] <filename>' };
  }

  ensureSkillsDir();
  const folderPath = path.dirname(parsed.filePath);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  if (fs.existsSync(parsed.filePath)) {
    return { ok: false, error: `Skill "${parsed.id}" already exists. Use /skills:edit ${parsed.id} to modify it.` };
  }

  const initialContent = `# ${parsed.file.toUpperCase()}\n\n> Describe what this skill accomplishes and when Levi should use it.\n\n## When to use\nState the trigger conditions, keywords, or scenarios.\n\n## Instructions & Recipes\n- Step 1: Detailed guidelines and commands\n- Step 2: Concrete code patterns or configurations\n`;
  fs.writeFileSync(parsed.filePath, initialContent, 'utf-8');

  const meta = readSkillsMeta();
  meta.skills[parsed.id] = {
    id: parsed.id,
    name: parsed.file,
    folder: parsed.folder,
    file: parsed.fileName,
    relPath: parsed.relPath,
    title: `${parsed.file} (${parsed.folder})`,
    summary: `Instructions for ${parsed.id}`,
    disabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);

  return { ok: true, id: parsed.id, folder: parsed.folder, file: parsed.file, path: parsed.filePath, relPath: parsed.relPath };
}

/**
 * Read the full markdown content of a skill.
 */
export function readSkill(...rawArgs) {
  const parsed = parseSkillTarget(...rawArgs);
  if (!parsed) return { ok: false, error: 'Skill not found.' };

  let targetPath = parsed.filePath;
  if (parsed.isFolderOnly && fs.existsSync(targetPath)) {
    const files = fs.readdirSync(targetPath).filter((f) => f.endsWith('.md'));
    if (!files.length) return { ok: false, error: `Folder "${parsed.folder}" contains no skill files.` };
    targetPath = path.join(targetPath, files[0]);
  }

  if (!fs.existsSync(targetPath)) {
    return { ok: false, error: `Skill file "${targetPath}" not found.` };
  }

  try {
    const content = fs.readFileSync(targetPath, 'utf-8');
    return { ok: true, id: parsed.id, path: targetPath, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function summarizeSkill(content, name, folder = '') {
  const trimmed = (content || '').trim();
  const fallbackTitle = folder && folder !== 'GENERAL' ? `${name} (${folder})` : name;
  if (!trimmed || trimmed === `# ${name}` || trimmed.includes('Describe what this skill accomplishes')) {
    return {
      title: fallbackTitle,
      summary: `Instructions for ${folder ? folder + '/' : ''}${name}`
    };
  }

  try {
    const prompt = `You are an AI assistant analyzing a modular skill definition for Levi (an AI coding assistant).
Skill: "${folder ? folder + '/' : ''}${name}"

Read the following skill instructions and generate:
1. "title": A concise title (2-5 words) naming what this skill does.
2. "summary": Exactly ONE clear sentence (max 20 words) explaining what this skill does and when Levi should use it.

Respond strictly in valid JSON format with keys "title" and "summary":
{"title": "...", "summary": "..."}

Skill instructions:
${trimmed.slice(0, 4000)}`;

    const res = await chat([{ role: 'user', content: prompt }], { maxTokens: 120 });
    const raw = res?.text?.trim()?.replace(/^```(?:json)?\s*/i, '')?.replace(/\s*```$/i, '') || '';
    const parsed = JSON.parse(raw);
    const title = parsed.title ? String(parsed.title).trim().replace(/[\r\n]+/g, ' ') : '';
    const summary = parsed.summary ? String(parsed.summary).trim().replace(/[\r\n]+/g, ' ') : '';
    if (title && summary) {
      return { title, summary };
    }
  } catch {}

  // Fallback heuristic extraction
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  let title = fallbackTitle;
  const h1 = lines.find((l) => l.startsWith('#'));
  if (h1) {
    title = h1.replace(/^#+\s*/, '').trim();
  }
  const firstBody = lines.find((l) => !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('>'));
  let summary = firstBody ? firstBody.replace(/\s+/g, ' ').slice(0, 110) : `Skill instructions for ${fallbackTitle}`;
  if (summary.length === 110) summary += '...';

  return { title, summary };
}

export async function editSkill(rawArgs, ctx = {}) {
  const parsed = parseSkillTarget(...(Array.isArray(rawArgs) ? rawArgs : [rawArgs]));
  if (!parsed || !parsed.filePath) {
    console.log('\x1b[31mInvalid skill target.\x1b[0m');
    return;
  }

  ensureSkillsDir();
  const folderPath = path.dirname(parsed.filePath);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  if (!fs.existsSync(parsed.filePath)) {
    await createSkill(parsed.folder, parsed.file);
  }

  const editor = getPreferredEditor();
  try {
    await openInEditor(parsed.filePath);
  } catch (err) {
    console.error(`\x1b[31mFailed to launch editor (${editor}): ${err.message}\x1b[0m`);
    return;
  }

  if (!fs.existsSync(parsed.filePath)) {
    console.log(`\x1b[33mSkill file ${parsed.filePath} was removed.\x1b[0m`);
    return;
  }

  const content = fs.readFileSync(parsed.filePath, 'utf-8');
  console.log('\n\x1b[36mSummarizing skill instructions...\x1b[0m');
  const { title, summary } = await summarizeSkill(content, parsed.file, parsed.folder);

  const meta = readSkillsMeta();
  meta.skills[parsed.id] = {
    id: parsed.id,
    name: parsed.file,
    folder: parsed.folder,
    file: parsed.fileName,
    relPath: parsed.relPath,
    title,
    summary,
    disabled: meta.skills[parsed.id]?.disabled || false,
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);

  console.log(`\x1b[32m✓ Skill "${parsed.id}" saved and indexed.\x1b[0m`);
  console.log(`  \x1b[2mTitle:\x1b[0m   ${title}`);
  console.log(`  \x1b[2mSummary:\x1b[0m ${summary}`);
  console.log(`  \x1b[2mPath:\x1b[0m    ~/.levi/SKILLS/${parsed.relPath}`);

  ctx.printPanel?.({
    title: `Skill: ${parsed.id}`,
    fields: [
      { label: 'Folder', value: parsed.folder, color: '#38bdf8' },
      { label: 'Title', value: title, color: '#22d3ee' },
      { label: 'Summary', value: summary, color: '#4ade80' },
      { label: 'File', value: `~/.levi/SKILLS/${parsed.relPath}`, color: '#c0caf5' },
      { label: 'Status', value: meta.skills[parsed.id].disabled ? 'Disabled' : 'Active (lazy-loaded in context)', color: meta.skills[parsed.id].disabled ? '#f87171' : '#ffd700' }
    ]
  });
}

export function deleteSkill(...rawArgs) {
  const parsed = parseSkillTarget(...rawArgs);
  if (!parsed) return { ok: false, error: 'Invalid skill or folder.' };

  const meta = readSkillsMeta();

  // If deleting an entire folder branch
  const directFolder = path.join(SKILLS_DIR, parsed.folder);
  if (parsed.isFolderOnly && fs.existsSync(directFolder)) {
    try {
      fs.rmSync(directFolder, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: `Failed to remove folder: ${err.message}` };
    }
    for (const k of Object.keys(meta.skills)) {
      if (meta.skills[k].folder === parsed.folder || meta.skills[k].folder.startsWith(parsed.folder + '/')) {
        delete meta.skills[k];
      }
    }
    if (meta.folders && meta.folders[parsed.folder]) {
      delete meta.folders[parsed.folder];
    }
    writeSkillsMeta(meta);
    return { ok: true, id: parsed.folder, isFolder: true };
  }

  // If deleting a specific file
  if (!fs.existsSync(parsed.filePath) && !meta.skills[parsed.id]) {
    return { ok: false, error: `Skill "${parsed.id}" not found.` };
  }
  try {
    if (fs.existsSync(parsed.filePath)) fs.unlinkSync(parsed.filePath);
  } catch {}
  delete meta.skills[parsed.id];
  writeSkillsMeta(meta);
  return { ok: true, id: parsed.id, isFolder: false };
}

export function disableSkill(...rawArgs) {
  const parsed = parseSkillTarget(...rawArgs);
  if (!parsed) return { ok: false, error: 'Invalid skill or folder.' };
  const meta = readSkillsMeta();

  if (parsed.isFolderOnly) {
    let count = 0;
    for (const [k, v] of Object.entries(meta.skills)) {
      if (v.folder === parsed.folder || v.folder.startsWith(parsed.folder + '/')) {
        v.disabled = true;
        count++;
      }
    }
    writeSkillsMeta(meta);
    return { ok: true, id: parsed.folder, isFolder: true, count };
  }

  if (!meta.skills[parsed.id]) {
    return { ok: false, error: `Skill "${parsed.id}" not found.` };
  }
  meta.skills[parsed.id].disabled = true;
  meta.skills[parsed.id].updatedAt = new Date().toISOString();
  writeSkillsMeta(meta);
  return { ok: true, id: parsed.id, isFolder: false };
}

export function enableSkill(...rawArgs) {
  const parsed = parseSkillTarget(...rawArgs);
  if (!parsed) return { ok: false, error: 'Invalid skill or folder.' };
  const meta = readSkillsMeta();

  if (parsed.isFolderOnly) {
    let count = 0;
    for (const [k, v] of Object.entries(meta.skills)) {
      if (v.folder === parsed.folder || v.folder.startsWith(parsed.folder + '/')) {
        v.disabled = false;
        count++;
      }
    }
    writeSkillsMeta(meta);
    return { ok: true, id: parsed.folder, isFolder: true, count };
  }

  if (!meta.skills[parsed.id]) {
    return { ok: false, error: `Skill "${parsed.id}" not found.` };
  }
  meta.skills[parsed.id].disabled = false;
  meta.skills[parsed.id].updatedAt = new Date().toISOString();
  writeSkillsMeta(meta);
  return { ok: true, id: parsed.id, isFolder: false };
}

export function recordSkillUsage(target) {
  const parsed = parseSkillTarget(target);
  if (!parsed) return;
  const meta = readSkillsMeta();
  const entry = meta.skills[parsed.id] || Object.values(meta.skills).find((s) => s.file === parsed.fileName || s.name === parsed.file);
  if (entry) {
    entry.usedCount = (entry.usedCount || 0) + 1;
    entry.lastUsedAt = new Date().toISOString();
    writeSkillsMeta(meta);
  }
}

/**
 * Lazy loading prompt generator:
 * Supplies ONLY names, relative file paths, and 1-line descriptions.
 * The full instructions are loaded on-demand via read_file.
 */
// findMatchingSkills: high-precision semantic match against triggers, patterns, and platforms
export function findMatchingSkills(query = '', fileContext = [], { max = 2, minScore = 1.0 } = {}) {
  if (!query && !fileContext.length) return [];
  const skills = listSkills().filter(s => !s.disabled);
  if (!skills.length) return [];

  const qLower = (query || '').toLowerCase().trim();
  const qTokens = qLower.split(/\W+/).filter(t => t.length > 2);
  const extSet = new Set(fileContext.map(f => f.split('.').pop()?.toLowerCase()).filter(Boolean));

  const scored = skills.map(s => {
    let score = 0;
    const triggers = s.triggers || [];
    const patterns = s.patterns || [];
    const platforms = s.platforms || [];

    // 1. Trigger keyword match
    for (const trigger of triggers) {
      const tLower = trigger.toLowerCase();
      if (qLower.includes(tLower)) {
        score += 3.0; // exact phrase match
      } else {
        const tWords = tLower.split(/\W+/).filter(w => w.length > 2);
        if (tWords.length > 1) {
          const matched = tWords.filter(w => qLower.includes(w));
          if (matched.length >= 2 && matched.length >= tWords.length * 0.6) {
            score += 1.5;
          }
        }
      }
    }

    // 2. File extension pattern match
    for (const pat of patterns) {
      const ext = pat.replace('*.', '').toLowerCase();
      if (extSet.has(ext)) score += 1.0;
    }

    // 3. Platform relevance (Termux/Android) - boost only if there's already positive score
    if (platforms.length && (qLower.includes('termux') || qLower.includes('android'))) {
      if (platforms.some(p => qLower.includes(p)) && score > 0) score += 0.5;
    }

    // 4. Slug / title match for specific technical terms (>3 chars)
    const titleAndSlug = `${s.id} ${s.title || ''}`.toLowerCase();
    for (const t of qTokens) {
      if (t.length > 3 && titleAndSlug.includes(t)) {
        score += 0.4;
      }
    }

    // 5. Usage boost (only for items with prior relevance)
    if (score > 0 && s.usedCount) {
      score += Math.min(s.usedCount * 0.1, 0.5);
    }

    return { s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(x => x.score >= minScore).slice(0, max).map(x => x.s);
}

// getSkillsPromptList: zero-waste — returns [] when no query or match, at most 2 stubs when triggered
export function getSkillsPromptList(query = '', fileContext = []) {
  if (!query && !fileContext.length) return [];
  const selected = findMatchingSkills(query, fileContext, { max: 2, minScore: 1.0 });
  if (!selected.length) return [];

  return selected.map(s => {
    const desc = s.summary || s.title || `Instructions for ${s.id}`;
    return {
      id: s.id,
      name: s.name,
      folder: s.folder,
      relPath: s.relPath,
      filePath: s.filePath,
      title: s.title || s.name,
      summary: s.summary,
      line: `- ${s.id} (file: ~/.levi/SKILLS/${s.relPath}): ${desc} — call load_skill("${s.id}") to activate`
    };
  });
}

/**
 * Save a learned recipe directly into ~/.levi/SKILLS/<folder>/<name>.md
 */
export function saveLearnedSkill({ folder, name, title, when_to_use, recipe, triggers = [], patterns = [], platforms = [] }) {
  return saveLearnedSkillStructured({ folder, name, title, when_to_use, recipe, triggers, patterns, platforms });
}

// Save a new learned skill with YAML frontmatter and structured playbook
export function saveLearnedSkillStructured({ folder: rawFolder, name: rawName, title, when_to_use, recipe, triggers = [], patterns = [], platforms = [] }) {
  const target = rawFolder && rawName ? `${rawFolder}/${rawName}` : (rawName || rawFolder || 'learned-recipe');
  const parsed = parseSkillTarget(target);
  if (!parsed || !parsed.folder) return { ok: false, error: 'Invalid skill or folder name.' };

  const folder = parsed.folder;
  const file = parsed.file || 'recipe';
  const id = `${folder}/${file}`;
  const folderPath = path.dirname(parsed.filePath);

  ensureSkillsDir();
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

  const cleanTitle = (title || file).trim().replace(/[\r\n]+/g, ' ');
  const cleanSummary = (when_to_use || `Instructions for ${cleanTitle}`).trim().replace(/[\r\n]+/g, ' ');

  const meta2 = readSkillsMeta();
  const existing = fs.existsSync(parsed.filePath) ? fs.readFileSync(parsed.filePath, 'utf-8') : null;
  const { meta: existingMeta } = existing ? parseFrontmatter(existing) : { meta: {} };

  // Merge triggers (deduplicated)
  const allTriggers = [...new Set([...(existingMeta.triggers || []), ...triggers])];
  const allPatterns = [...new Set([...(existingMeta.patterns || []), ...patterns])];
  const allPlatforms = [...new Set([...(existingMeta.platforms || []), ...platforms])];

  const fm = {
    name: file,
    folder,
    title: cleanTitle,
    triggers: allTriggers.length ? allTriggers : undefined,
    patterns: allPatterns.length ? allPatterns : undefined,
    platforms: allPlatforms.length ? allPlatforms : undefined,
    confidence: 0.9,
    used_count: meta2.skills[id]?.usedCount || 0
  };

  let body;
  if (existing && existing.length > 50) {
    const { body: existingBody } = parseFrontmatter(existing);
    const dateStr = new Date().toISOString().slice(0, 10);
    body = existingBody.trim() + `\n\n### Updated Recipe (${dateStr})\n${(recipe || '').trim()}\n`;
  } else {
    body = `> ${cleanSummary}\n\n## When to Use\n${cleanSummary}\n\n## Recipe & Playbook\n${(recipe || '').trim()}\n`;
  }

  const content = serializeFrontmatter(
    Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== undefined)),
    body
  );

  fs.writeFileSync(parsed.filePath, content, 'utf-8');
  meta2.skills[id] = {
    id,
    name: file,
    folder,
    file: `${file}.md`,
    relPath: parsed.relPath,
    title: cleanTitle,
    summary: cleanSummary,
    triggers: allTriggers,
    patterns: allPatterns,
    platforms: allPlatforms,
    disabled: false,
    usedCount: meta2.skills[id]?.usedCount || 0,
    createdAt: meta2.skills[id]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta2);

  return { ok: true, id, folder, file, name: file, title: cleanTitle, summary: cleanSummary, path: parsed.filePath, relPath: parsed.relPath };
}

// Refine an existing skill: merge new nuance without duplicating the full recipe
export async function refineExistingSkill(existingId, { newNuance, triggers: newTriggers = [] }) {
  const meta = readSkillsMeta();
  const rec = meta.skills[existingId];
  if (!rec) return { ok: false, error: `Skill ${existingId} not found for refinement.` };

  const filePath = path.join(SKILLS_DIR, rec.relPath || `${existingId}.md`);
  if (!fs.existsSync(filePath)) return { ok: false, error: `Skill file not found: ${filePath}` };

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { meta: fm, body } = parseFrontmatter(raw);

  // Merge triggers
  const allTriggers = [...new Set([...(fm.triggers || []), ...newTriggers])];
  fm.triggers = allTriggers;

  const dateStr = new Date().toISOString().slice(0, 10);
  const newBody = body.trim() + `\n\n### Refinement (${dateStr})\n${newNuance.trim()}\n`;
  const content = serializeFrontmatter(fm, newBody);

  fs.writeFileSync(filePath, content, 'utf-8');
  rec.triggers = allTriggers;
  rec.updatedAt = new Date().toISOString();
  writeSkillsMeta(meta);

  return { ok: true, id: existingId, folder: rec.folder, file: rec.name, name: rec.name, title: rec.title, summary: rec.summary, path: filePath, relPath: rec.relPath };
}

export async function distillSkillFromExchange({ userQuery, toolCalls, resultText, requestedTarget, errorCycles = [] }) {
  if (!toolCalls || toolCalls.length < 2) return null;

  // Build a richer trajectory including errors and fixes
  const trace = toolCalls.map(c => {
    const fn = c.name;
    const a = JSON.stringify(c.args || {}).slice(0, 180);
    return `${fn}(${a})`;
  }).join(' -> ');

  const errorCtx = errorCycles.length
    ? `\nErrors encountered and fixed:\n${errorCycles.map(e => `- ${e}`).join('\n')}`
    : '';

  // Load existing skills for dedup comparison
  const existingSkills = listSkills().filter(s => !s.disabled).map(s => `${s.id}: ${s.summary || ''}`);
  const existingCtx = existingSkills.length
    ? `\nExisting skills (check for duplicates):\n${existingSkills.slice(0, 20).map(s => `- ${s}`).join('\n')}`
    : '';

  const prompt = `You are a self-learning skill distillation engine for Levi, an AI coding assistant.
Analyze this completed task and decide: distill new skill, refine existing, or skip.

Task: "${userQuery}"
Actions: ${trace}${errorCtx}
Outcome: "${(resultText || '').slice(0, 400)}"${existingCtx}

Rules:
1. ONLY distill if this is a generalizable, non-trivial recipe, bug fix, CLI workflow, or config pattern.
2. Skip one-off edits, trivial questions, project-specific paths/names, or single file reads.
3. If >65% similar to an existing skill, set "mode":"refine" and name the existing skill in "existing_id" — provide only the NEW nuance to merge.
4. If novel, set "mode":"create".
5. Never hardcode project-specific paths (~/stardew-memory-match, ~/the-isle-evrima-fandom, etc.) in recipes. Use placeholders like <project-dir>.
6. Triggers must be short keyword phrases (2-4 words) that activate retrieval of this skill.

Return ONLY valid JSON:
{
  "should_learn": true|false,
  "mode": "create"|"refine",
  "existing_id": "folder/name" (only if mode=refine),
  "folder": "CATEGORY-NAME",
  "name": "kebab-case-slug",
  "title": "Short Title (3-6 words)",
  "triggers": ["keyword phrase 1", "keyword phrase 2", "keyword phrase 3"],
  "patterns": ["*.ext"] (file extensions this skill applies to, or []),
  "platforms": ["linux", "android", "termux"] (or []),
  "when_to_use": "1-line condition (max 20 words)",
  "recipe": "Concise step-by-step markdown recipe with commands and gotchas"
}`;

  try {
    const res = await chat([{ role: 'user', content: prompt }], { maxTokens: 600 });
    const raw = res?.text?.trim()?.replace(/^```(?:json)?\s*/i, '')?.replace(/\s*```$/i, '') || '';
    const parsed = JSON.parse(raw);

    if (!parsed.should_learn) return null;

    let folder = parsed.folder || 'LEARNED-SKILLS';
    let name = parsed.name;
    if (requestedTarget) {
      const p = parseSkillTarget(requestedTarget);
      if (p?.folder) folder = p.folder;
      if (p?.file) name = p.file;
    }

    if (parsed.mode === 'refine' && parsed.existing_id) {
      // Refine: merge new nuance into existing skill file
      return await refineExistingSkill(parsed.existing_id, {
        newNuance: parsed.recipe,
        triggers: parsed.triggers || [],
      });
    }

    // Create new structured skill with frontmatter
    return saveLearnedSkillStructured({
      folder,
      name,
      title: parsed.title,
      when_to_use: parsed.when_to_use,
      recipe: parsed.recipe,
      triggers: parsed.triggers || [],
      patterns: parsed.patterns || [],
      platforms: parsed.platforms || []
    });
  } catch { return null; }
}

export async function distillLastSessionSkill(sessionId, requestedTarget) {
  if (!sessionId) return { ok: false, error: 'No active session.' };
  try {
    const sessionDir = path.join(LEVI_HOME, 'SESSIONS', sessionId);
    const msgsFile = path.join(sessionDir, 'messages.json');
    if (!fs.existsSync(msgsFile)) return { ok: false, error: 'No message history found for this session.' };
    const messages = JSON.parse(fs.readFileSync(msgsFile, 'utf-8'));
    if (!messages.length) return { ok: false, error: 'Session has no messages.' };

    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastAgent = [...messages].reverse().find((m) => m.role === 'agent');
    if (!lastUser) return { ok: false, error: 'No user query found.' };

    const toolCalls = [];
    for (const m of messages.slice(-10)) {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          toolCalls.push({ name: tc.function?.name || tc.name, args: typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.args });
        }
      }
    }

    if (toolCalls.length < 1) {
      return { ok: false, error: 'Recent turn did not perform any tool actions to distill into a skill.' };
    }

    const res = await distillSkillFromExchange({
      userQuery: lastUser.text || lastUser.content || '',
      toolCalls,
      resultText: lastAgent?.text || lastAgent?.content || '',
      requestedTarget
    });

    if (res && res.ok) return res;
    return { ok: false, error: 'The recent task was too simple or project-specific to extract a generalizable skill.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Load full skill playbook into context and record usage
export function loadSkill(idOrSlug) {
  const all = listSkills();
  const slug = String(idOrSlug || '').toLowerCase().replace(/\s+/g, '-');

  // Exact match first
  let rec = all.find(s => s.id === idOrSlug);
  // Fuzzy: id contains the slug, or slug contains id fragment
  if (!rec) rec = all.find(s => s.id.toLowerCase().includes(slug) || slug.includes(s.id.toLowerCase().replace(/\//g, '-')));
  if (!rec) return { ok: false, error: `Skill "${idOrSlug}" not found in ~/.levi/SKILLS/` };

  const filePath = path.join(SKILLS_DIR, rec.relPath);
  if (!fs.existsSync(filePath)) return { ok: false, error: `Skill file missing: ${filePath}` };

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { body } = parseFrontmatter(raw);
    // Record usage
    const meta2 = readSkillsMeta();
    if (meta2.skills[rec.id]) {
      meta2.skills[rec.id].usedCount = (meta2.skills[rec.id].usedCount || 0) + 1;
      meta2.skills[rec.id].lastUsedAt = new Date().toISOString();
      writeSkillsMeta(meta2);
    }
    const header = `# Skill: ${rec.title || rec.name}\n`;
    return { ok: true, id: rec.id, path: filePath, content: header + body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function autoLearnIfEligible({ userQuery, toolCalls, resultText, onStep, errorCycles = [] }) {
  if (!toolCalls || toolCalls.length < 3) return;
  const hasModifier = toolCalls.some((c) => ['write_file', 'edit_file', 'bash'].includes(c.name));
  if (!hasModifier) return;
  if (!resultText || resultText.includes('API error') || resultText.includes('Interrupted')) return;

  setTimeout(async () => {
    try {
      const res = await distillSkillFromExchange({ userQuery, toolCalls, resultText, errorCycles });
      if (res && res.ok) {
        onStep?.('narrate', `✦ Distilled skill: "${res.id}" (~/.levi/SKILLS/${res.relPath})`);
      }
    } catch {}
  }, 100);
}
