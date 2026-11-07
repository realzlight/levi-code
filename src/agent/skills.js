import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { chat } from './client.js';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const SKILLS_DIR = path.join(LEVI_HOME, 'SKILLS');
const META_FILE = path.join(LEVI_HOME, 'skills.json');

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
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      const h1 = lines.find((l) => l.startsWith('#'));
      const title = h1 ? h1.replace(/^#+\s*/, '').trim() : f.name;
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
        disabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      changed = true;
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

  const editor = process.env.EDITOR || 'nano';
  try {
    await execa(editor, [parsed.filePath], { stdio: 'inherit' });
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
export function getSkillsPromptList(query = '') {
  const skills = listSkills().filter((s) => !s.disabled);
  let selected = skills;

  // Progressive disclosure: If many skills exist and a query is available, filter top candidates
  if (skills.length > 12 && query && typeof query === 'string') {
    const qTokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    if (qTokens.length) {
      const scored = skills.map((s) => {
        const text = `${s.id} ${s.folder} ${s.name} ${s.title || ''} ${s.summary || ''}`.toLowerCase();
        let score = 0;
        for (const t of qTokens) {
          if (text.includes(t)) score += 1;
        }
        if (s.usedCount) score += Math.min(s.usedCount * 0.2, 1);
        return { s, score };
      });
      scored.sort((a, b) => b.score - a.score);
      const matches = scored.filter((x) => x.score > 0).map((x) => x.s);
      selected = matches.length ? matches.slice(0, 8) : scored.slice(0, 8).map((x) => x.s);
    }
  }

  return selected.map((s) => {
    let desc = '';
    if (s.title && s.summary) {
      if (s.summary.toLowerCase().startsWith(s.title.toLowerCase())) {
        desc = s.summary;
      } else {
        desc = `${s.title} — ${s.summary}`;
      }
    } else {
      desc = s.summary || s.title || `Instructions for ${s.id}`;
    }
    const usage = s.usedCount ? ` [used ${s.usedCount}x]` : '';
    return {
      id: s.id,
      name: s.name,
      folder: s.folder,
      relPath: s.relPath,
      filePath: s.filePath,
      title: s.title || s.name,
      summary: s.summary,
      line: `- ${s.id}${usage} (file: ~/.levi/SKILLS/${s.relPath}): ${desc}`
    };
  });
}

/**
 * Save a learned recipe directly into ~/.levi/SKILLS/<folder>/<name>.md
 */
export function saveLearnedSkill({ folder: rawFolder, name: rawName, title, when_to_use, recipe }) {
  const target = rawFolder && rawName ? `${rawFolder}/${rawName}` : (rawName || rawFolder || 'learned-recipe');
  const parsed = parseSkillTarget(target);
  if (!parsed || !parsed.folder) return { ok: false, error: 'Invalid skill or folder name.' };

  const folder = parsed.folder;
  const file = parsed.file || 'recipe';
  const id = `${folder}/${file}`;
  const folderPath = path.dirname(parsed.filePath);

  ensureSkillsDir();
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const cleanTitle = (title || file).trim().replace(/[\r\n]+/g, ' ');
  const cleanSummary = (when_to_use || `Instructions for ${cleanTitle}`).trim().replace(/[\r\n]+/g, ' ');

  const meta = readSkillsMeta();
  let content;
  const existing = fs.existsSync(parsed.filePath) ? fs.readFileSync(parsed.filePath, 'utf-8') : null;

  if (existing && existing.length > 50) {
    const dateStr = new Date().toISOString().slice(0, 10);
    content = existing.trim() + `\n\n### Additional Recipe (${dateStr})\n${(recipe || '').trim()}\n`;
  } else {
    content = `# ${cleanTitle}

> ${cleanSummary}

## When to use
${cleanSummary}

## Recipe & Playbook
${(recipe || '').trim()}
`;
  }

  fs.writeFileSync(parsed.filePath, content, 'utf-8');
  meta.skills[id] = {
    id,
    name: file,
    folder,
    file: `${file}.md`,
    relPath: parsed.relPath,
    title: cleanTitle,
    summary: cleanSummary,
    disabled: false,
    usedCount: meta.skills[id]?.usedCount || 0,
    createdAt: meta.skills[id]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);

  return { ok: true, id, folder, file, name: file, title: cleanTitle, summary: cleanSummary, path: parsed.filePath, relPath: parsed.relPath };
}

export async function distillSkillFromExchange({ userQuery, toolCalls, resultText, requestedTarget }) {
  if (!toolCalls || toolCalls.length < 2) return null;

  const trace = toolCalls.map((c) => {
    const fn = c.name;
    const a = JSON.stringify(c.args || {});
    return `${fn}(${a.slice(0, 150)})`;
  }).join(' -> ');

  const prompt = `You are a self-learning skill distillation engine for Levi, an AI coding assistant.
Analyze this completed, successful task and determine if it represents a REUSABLE skill, recipe, or non-obvious workaround that would save time and tokens if encountered again.

Task: "${userQuery}"
Actions taken: ${trace}
Outcome: "${(resultText || '').slice(0, 300)}"
${requestedTarget ? `Requested target: "${requestedTarget}"` : ''}

Rules:
1. ONLY distill if this is a generalizable, non-trivial recipe, bug fix, configuration, or CLI workflow.
2. If this is a one-off edit, trivial question, or simple file read, return {"should_learn": false}.
3. If it IS reusable, return:
{
  "should_learn": true,
  "folder": "CATEGORY-NAME (e.g. UI-UX-SKILLS, BACKEND-RECIPES, DEVOPS, ANDROID-TERMUX)",
  "name": "kebab-case-slug",
  "title": "Short Descriptive Title",
  "when_to_use": "Clear 1-line condition for when to activate this skill (max 20 words)",
  "recipe": "Concise step-by-step markdown recipe with exact commands and gotchas"
}

Output strictly valid JSON:`;

  try {
    const res = await chat([{ role: 'user', content: prompt }], { maxTokens: 450 });
    const raw = res?.text?.trim()?.replace(/^```(?:json)?\s*/i, '')?.replace(/\s*```$/i, '') || '';
    const parsed = JSON.parse(raw);
    if (parsed.should_learn && parsed.name && parsed.recipe) {
      let folder = parsed.folder || 'LEARNED-SKILLS';
      let name = parsed.name;
      if (requestedTarget) {
        const p = parseSkillTarget(requestedTarget);
        if (p?.folder) folder = p.folder;
        if (p?.file) name = p.file;
      }
      return saveLearnedSkill({
        folder,
        name,
        title: parsed.title,
        when_to_use: parsed.when_to_use,
        recipe: parsed.recipe
      });
    }
  } catch {}
  return null;
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

export async function autoLearnIfEligible({ userQuery, toolCalls, resultText, onStep }) {
  if (!toolCalls || toolCalls.length < 3) return;
  const hasModifier = toolCalls.some((c) => ['write_file', 'edit_file', 'bash'].includes(c.name));
  if (!hasModifier) return;
  if (!resultText || resultText.includes('API error') || resultText.includes('Interrupted')) return;

  setTimeout(async () => {
    try {
      const res = await distillSkillFromExchange({ userQuery, toolCalls, resultText });
      if (res && res.ok) {
        onStep?.('narrate', `✦ Distilled new skill: "${res.id}" (~/.levi/SKILLS/${res.relPath})`);
      }
    } catch {}
  }, 100);
}
