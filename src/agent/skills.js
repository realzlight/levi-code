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
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export function sanitizeFolder(raw) {
  if (!raw || typeof raw !== 'string') return 'GENERAL';
  const clean = raw
    .trim()
    .replace(/[\/\\]+/g, '-')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'GENERAL';
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
 * Parse input arguments into a structured skill target:
 * e.g. ("UI-UX-SKILLS", "ui") -> { folder: "UI-UX-SKILLS", file: "ui", id: "UI-UX-SKILLS/ui", relPath: "UI-UX-SKILLS/ui.md" }
 * e.g. "UI-UX-SKILLS/ui"     -> { folder: "UI-UX-SKILLS", file: "ui", id: "UI-UX-SKILLS/ui", relPath: "UI-UX-SKILLS/ui.md" }
 * e.g. "ui"                  -> searches existing skills, or defaults to ("GENERAL", "ui")
 */
export function parseSkillTarget(target, optionalFile) {
  if (!target && !optionalFile) return null;
  let raw = String(target || '').trim();
  let fileRaw = optionalFile ? String(optionalFile).trim() : '';

  let folder = '';
  let file = '';

  if (fileRaw) {
    folder = sanitizeFolder(raw);
    file = sanitizeSlug(fileRaw);
  } else if (raw.includes('/')) {
    const parts = raw.split('/').filter(Boolean);
    folder = sanitizeFolder(parts[0]);
    file = sanitizeSlug(parts.slice(1).join('-'));
  } else {
    ensureSkillsDir();
    const directFolder = path.join(SKILLS_DIR, raw);
    if (fs.existsSync(directFolder) && fs.statSync(directFolder).isDirectory()) {
      folder = sanitizeFolder(raw);
      file = '';
    } else {
      // Check if target matches an existing skill across all folders
      const all = listSkills();
      const match = all.find((s) => s.file === `${sanitizeSlug(raw)}.md` || s.name === sanitizeSlug(raw));
      if (match) {
        folder = match.folder;
        file = sanitizeSlug(match.name);
      } else {
        folder = sanitizeFolder(raw);
        file = '';
      }
    }
  }

  const id = file ? `${folder}/${file}` : folder;
  const fileName = file ? `${file}.md` : '';
  const relPath = file ? path.join(folder, `${file}.md`) : folder;
  const filePath = file ? path.join(SKILLS_DIR, folder, `${file}.md`) : path.join(SKILLS_DIR, folder);

  return { id, folder, file, fileName, relPath, filePath };
}

/**
 * List all skill folders with their file counts.
 */
export function listSkillFolders() {
  ensureSkillsDir();
  const folders = [];
  try {
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        let count = 0;
        try {
          count = fs.readdirSync(path.join(SKILLS_DIR, ent.name)).filter((f) => f.endsWith('.md')).length;
        } catch {}
        folders.push({ name: ent.name, count, path: path.join(SKILLS_DIR, ent.name) });
      }
    }
  } catch {}
  return folders;
}

/**
 * Create a new skill folder under ~/.levi/SKILLS/<name>
 */
export function createSkillFolder(rawFolder) {
  const folder = sanitizeFolder(rawFolder);
  ensureSkillsDir();
  const folderPath = path.join(SKILLS_DIR, folder);
  if (fs.existsSync(folderPath)) {
    return { ok: true, folder, path: folderPath, existing: true };
  }
  fs.mkdirSync(folderPath, { recursive: true });
  const meta = readSkillsMeta();
  if (!meta.folders) meta.folders = {};
  meta.folders[folder] = {
    name: folder,
    createdAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);
  return { ok: true, folder, path: folderPath, existing: false };
}

/**
 * Scan SKILLS_DIR recursively for all skills organized by folder.
 * Discovers .levi/SKILLS/<folder>/<file>.md and synchronizes with metadata.
 */
export function listSkills(filterFolder = null) {
  ensureSkillsDir();
  const meta = readSkillsMeta();
  let changed = false;
  const foundSkills = [];

  try {
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const folderName = ent.name;
        if (filterFolder && folderName.toLowerCase() !== filterFolder.toLowerCase()) continue;
        const subFiles = fs.readdirSync(path.join(SKILLS_DIR, folderName));
        for (const f of subFiles) {
          if (!f.endsWith('.md')) continue;
          const fileName = f.slice(0, -3);
          const id = `${folderName}/${fileName}`;
          const relPath = `${folderName}/${f}`;
          const fullPath = path.join(SKILLS_DIR, folderName, f);

          if (!meta.skills[id]) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
            const h1 = lines.find((l) => l.startsWith('#'));
            const title = h1 ? h1.replace(/^#+\s*/, '').trim() : fileName;
            const body = lines.find((l) => !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('>'));
            const summary = body ? body.slice(0, 120) : `Skill instructions for ${id}`;
            meta.skills[id] = {
              id,
              name: fileName,
              folder: folderName,
              file: f,
              relPath,
              title,
              summary,
              disabled: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
            changed = true;
          }
          foundSkills.push({
            ...meta.skills[id],
            id,
            name: fileName,
            folder: folderName,
            file: f,
            relPath,
            filePath: fullPath
          });
        }
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        // Flat legacy skill file support (e.g. ~/.levi/SKILLS/ui.md)
        const fileName = ent.name.slice(0, -3);
        const folderName = 'GENERAL';
        const id = `${folderName}/${fileName}`;
        const relPath = ent.name;
        const fullPath = path.join(SKILLS_DIR, ent.name);

        if (!meta.skills[id] && !meta.skills[fileName]) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
          const h1 = lines.find((l) => l.startsWith('#'));
          const title = h1 ? h1.replace(/^#+\s*/, '').trim() : fileName;
          const body = lines.find((l) => !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('>'));
          const summary = body ? body.slice(0, 120) : `Skill instructions for ${fileName}`;
          meta.skills[id] = {
            id,
            name: fileName,
            folder: folderName,
            file: ent.name,
            relPath,
            title,
            summary,
            disabled: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          changed = true;
        }
        const record = meta.skills[id] || meta.skills[fileName];
        foundSkills.push({
          ...record,
          id,
          name: fileName,
          folder: folderName,
          file: ent.name,
          relPath,
          filePath: fullPath
        });
      }
    }
  } catch {}

  // Prune deleted skills from meta
  for (const [id, entry] of Object.entries(meta.skills)) {
    const fullPath = entry.filePath || (entry.folder && entry.folder !== 'GENERAL' ? path.join(SKILLS_DIR, entry.folder, entry.file || `${entry.name}.md`) : path.join(SKILLS_DIR, entry.relPath || `${entry.name}.md`));
    if (!fs.existsSync(fullPath)) {
      delete meta.skills[id];
      changed = true;
    }
  }

  if (changed) {
    writeSkillsMeta(meta);
  }

  return foundSkills;
}

export function getSkill(target, optionalFile) {
  const parsed = parseSkillTarget(target, optionalFile);
  if (!parsed || !parsed.file) return null;
  const meta = readSkillsMeta();
  return meta.skills[parsed.id] || null;
}

/**
 * Create a new skill file inside a skill folder.
 * If target has no file name, defaults to 'main'.
 */
export async function createSkill(target, optionalFile, initialContent = null) {
  const parsed = parseSkillTarget(target, optionalFile);
  if (!parsed || !parsed.folder) {
    return { ok: false, error: 'Invalid folder or skill name.' };
  }

  const folder = parsed.folder;
  const file = parsed.file || 'main';
  const id = `${folder}/${file}`;
  const folderPath = path.join(SKILLS_DIR, folder);
  const filePath = path.join(folderPath, `${file}.md`);

  ensureSkillsDir();
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    return { ok: false, error: `Skill "${id}" already exists. Use /skills:edit ${id} to modify it.` };
  }

  const content = initialContent || `# ${file.toUpperCase()}\n\n> Describe what this skill accomplishes and when Levi should use it.\n\n## When to use\nState the trigger conditions or keywords.\n\n## Instructions & Recipes\n- Step 1: Detailed guidelines and commands\n- Step 2: Concrete code patterns or configurations\n`;
  fs.writeFileSync(filePath, content, 'utf-8');

  const meta = readSkillsMeta();
  meta.skills[id] = {
    id,
    name: file,
    folder,
    file: `${file}.md`,
    relPath: `${folder}/${file}.md`,
    title: `${file} (${folder})`,
    summary: `Instructions for ${id}`,
    disabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);

  return { ok: true, id, folder, file, path: filePath };
}

/**
 * Read the full markdown content of a skill.
 */
export function readSkill(target, optionalFile) {
  const parsed = parseSkillTarget(target, optionalFile);
  if (!parsed) return { ok: false, error: 'Skill not found.' };

  let targetPath = parsed.filePath;
  if (!parsed.file && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
    // If folder was passed without file, pick first .md in folder or list them
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
  const fallbackTitle = folder ? `${name} (${folder})` : name;
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

export async function editSkill(target, optionalFile, ctx = {}) {
  const parsed = parseSkillTarget(target, optionalFile);
  if (!parsed || !parsed.folder) {
    console.log('\x1b[31mInvalid folder or skill name.\x1b[0m');
    return;
  }

  let folder = parsed.folder;
  let file = parsed.file;

  if (!file) {
    // If folder was passed without file, pick first existing file or default to main
    const folderPath = path.join(SKILLS_DIR, folder);
    if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
      const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.md'));
      file = files.length ? files[0].slice(0, -3) : 'main';
    } else {
      file = 'main';
    }
  }

  const id = `${folder}/${file}`;
  const folderPath = path.join(SKILLS_DIR, folder);
  const filePath = path.join(folderPath, `${file}.md`);

  ensureSkillsDir();
  if (!fs.existsSync(filePath)) {
    await createSkill(folder, file);
  }

  const editor = process.env.EDITOR || 'nano';
  try {
    await execa(editor, [filePath], { stdio: 'inherit' });
  } catch (err) {
    console.error(`\x1b[31mFailed to launch editor (${editor}): ${err.message}\x1b[0m`);
    return;
  }

  if (!fs.existsSync(filePath)) {
    console.log(`\x1b[33mSkill file ${filePath} was removed.\x1b[0m`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  console.log('\n\x1b[36mSummarizing skill instructions...\x1b[0m');
  const { title, summary } = await summarizeSkill(content, file, folder);

  const meta = readSkillsMeta();
  meta.skills[id] = {
    id,
    name: file,
    folder,
    file: `${file}.md`,
    relPath: `${folder}/${file}.md`,
    title,
    summary,
    disabled: meta.skills[id]?.disabled || false,
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);

  console.log(`\x1b[32m✓ Skill "${id}" saved and indexed.\x1b[0m`);
  console.log(`  \x1b[2mTitle:\x1b[0m   ${title}`);
  console.log(`  \x1b[2mSummary:\x1b[0m ${summary}`);
  console.log(`  \x1b[2mPath:\x1b[0m    ~/.levi/SKILLS/${folder}/${file}.md`);

  ctx.printPanel?.({
    title: `Skill: ${id}`,
    fields: [
      { label: 'Folder', value: folder, color: '#38bdf8' },
      { label: 'Title', value: title, color: '#22d3ee' },
      { label: 'Summary', value: summary, color: '#4ade80' },
      { label: 'File', value: `~/.levi/SKILLS/${folder}/${file}.md`, color: '#c0caf5' },
      { label: 'Status', value: meta.skills[id].disabled ? 'Disabled' : 'Active (lazy-loaded in context)', color: meta.skills[id].disabled ? '#f87171' : '#ffd700' }
    ]
  });
}

export function deleteSkill(target, optionalFile) {
  const parsed = parseSkillTarget(target, optionalFile);
  if (!parsed) return { ok: false, error: 'Invalid skill or folder.' };

  const meta = readSkillsMeta();

  if (!parsed.file) {
    // Delete entire folder
    const folderPath = path.join(SKILLS_DIR, parsed.folder);
    if (!fs.existsSync(folderPath)) return { ok: false, error: `Folder "${parsed.folder}" not found.` };
    try {
      fs.rmSync(folderPath, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: `Failed to remove folder: ${err.message}` };
    }
    // Remove all skills in that folder from meta
    for (const k of Object.keys(meta.skills)) {
      if (meta.skills[k].folder === parsed.folder) {
        delete meta.skills[k];
      }
    }
    if (meta.folders && meta.folders[parsed.folder]) {
      delete meta.folders[parsed.folder];
    }
    writeSkillsMeta(meta);
    return { ok: true, id: parsed.folder, isFolder: true };
  }

  // Delete specific skill file
  const filePath = parsed.filePath;
  if (!fs.existsSync(filePath) && !meta.skills[parsed.id]) {
    return { ok: false, error: `Skill "${parsed.id}" not found.` };
  }
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
  delete meta.skills[parsed.id];
  writeSkillsMeta(meta);
  return { ok: true, id: parsed.id, isFolder: false };
}

export function disableSkill(target, optionalFile) {
  const parsed = parseSkillTarget(target, optionalFile);
  if (!parsed) return { ok: false, error: 'Invalid skill or folder.' };
  const meta = readSkillsMeta();

  if (!parsed.file) {
    // Disable all skills in folder
    let count = 0;
    for (const [k, v] of Object.entries(meta.skills)) {
      if (v.folder === parsed.folder) {
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

export function enableSkill(target, optionalFile) {
  const parsed = parseSkillTarget(target, optionalFile);
  if (!parsed) return { ok: false, error: 'Invalid skill or folder.' };
  const meta = readSkillsMeta();

  if (!parsed.file) {
    // Enable all skills in folder
    let count = 0;
    for (const [k, v] of Object.entries(meta.skills)) {
      if (v.folder === parsed.folder) {
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
  const folderPath = path.join(SKILLS_DIR, folder);
  const filePath = path.join(folderPath, `${file}.md`);

  ensureSkillsDir();
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const cleanTitle = (title || file).trim().replace(/[\r\n]+/g, ' ');
  const cleanSummary = (when_to_use || `Instructions for ${cleanTitle}`).trim().replace(/[\r\n]+/g, ' ');

  const meta = readSkillsMeta();
  let content;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;

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

  fs.writeFileSync(filePath, content, 'utf-8');
  meta.skills[id] = {
    id,
    name: file,
    folder,
    file: `${file}.md`,
    relPath: `${folder}/${file}.md`,
    title: cleanTitle,
    summary: cleanSummary,
    disabled: false,
    usedCount: meta.skills[id]?.usedCount || 0,
    createdAt: meta.skills[id]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);

  return { ok: true, id, folder, file, name: file, title: cleanTitle, summary: cleanSummary, path: filePath };
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
        onStep?.('narrate', `✦ Distilled new skill: "${res.id}" (~/.levi/SKILLS/${res.folder}/${res.file}.md)`);
      }
    } catch {}
  }, 100);
}
