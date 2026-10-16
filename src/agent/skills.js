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

export function sanitizeSkillName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
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
      if (data && typeof data.skills === 'object') return data;
    }
  } catch {}
  return { skills: {} };
}

export function writeSkillsMeta(meta) {
  try {
    if (!fs.existsSync(LEVI_HOME)) fs.mkdirSync(LEVI_HOME, { recursive: true });
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save skills metadata:', err.message);
  }
}

export function listSkills() {
  ensureSkillsDir();
  const meta = readSkillsMeta();
  let changed = false;

  // 1. Sync files on disk -> meta
  try {
    const files = fs.readdirSync(SKILLS_DIR);
    for (const f of files) {
      if (f.endsWith('.md')) {
        const name = f.slice(0, -3);
        if (!meta.skills[name]) {
          const content = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf-8');
          const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
          const h1 = lines.find((l) => l.startsWith('#'));
          const title = h1 ? h1.replace(/^#+\s*/, '').trim() : name;
          const body = lines.find((l) => !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('>'));
          const summary = body ? body.slice(0, 100) : `Custom skill for ${name}`;
          meta.skills[name] = {
            name,
            title,
            summary,
            disabled: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          changed = true;
        }
      }
    }
  } catch {}

  // 2. Prune any meta entries whose files were deleted on disk
  for (const name of Object.keys(meta.skills)) {
    const filePath = path.join(SKILLS_DIR, `${name}.md`);
    if (!fs.existsSync(filePath)) {
      delete meta.skills[name];
      changed = true;
    }
  }

  if (changed) {
    writeSkillsMeta(meta);
  }

  return Object.values(meta.skills);
}

export function getSkill(rawName) {
  const name = sanitizeSkillName(rawName);
  if (!name) return null;
  const meta = readSkillsMeta();
  return meta.skills[name] || null;
}

export async function createSkill(rawName) {
  const name = sanitizeSkillName(rawName);
  if (!name) {
    return { ok: false, error: 'Invalid skill name. Use letters, numbers, and hyphens.' };
  }
  ensureSkillsDir();
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  if (fs.existsSync(filePath)) {
    return { ok: false, error: `Skill "${name}" already exists. Use /skills:edit ${name} to modify it.` };
  }

  const initialContent = `# ${name}\n\nDescribe the instructions and rules for this skill here.\n`;
  fs.writeFileSync(filePath, initialContent, 'utf-8');

  const meta = readSkillsMeta();
  meta.skills[name] = {
    name,
    title: name,
    summary: `Custom skill for ${name}`,
    disabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);

  return { ok: true, name, path: filePath };
}

export async function summarizeSkill(content, name) {
  const trimmed = (content || '').trim();
  if (!trimmed || trimmed === `# ${name}` || trimmed.includes('Describe the instructions and rules for this skill here.')) {
    return {
      title: name,
      summary: `Custom skill for ${name}`
    };
  }

  try {
    const prompt = `You are an AI assistant analyzing a custom skill definition for Levi (an AI coding assistant).
Skill name: "${name}"

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

  // Fallback heuristic extraction if LLM is unavailable or fails
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  let title = name;
  const h1 = lines.find((l) => l.startsWith('#'));
  if (h1) {
    title = h1.replace(/^#+\s*/, '').trim();
  }
  const firstBody = lines.find((l) => !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('>'));
  let summary = firstBody ? firstBody.replace(/\s+/g, ' ').slice(0, 100) : `Custom skill for ${name}`;
  if (summary.length === 100) summary += '...';

  return { title, summary };
}

export async function editSkill(rawName, ctx = {}) {
  const name = sanitizeSkillName(rawName);
  if (!name) {
    console.log('\x1b[31mInvalid skill name.\x1b[0m');
    return;
  }
  ensureSkillsDir();
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    await createSkill(name);
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
  const { title, summary } = await summarizeSkill(content, name);

  const meta = readSkillsMeta();
  meta.skills[name] = {
    name,
    title,
    summary,
    disabled: meta.skills[name]?.disabled || false,
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);

  console.log(`\x1b[32m✓ Skill "${name}" saved and summarized.\x1b[0m`);
  console.log(`  \x1b[2mTitle:\x1b[0m   ${title}`);
  console.log(`  \x1b[2mSummary:\x1b[0m ${summary}`);
  console.log(`  \x1b[2mStatus:\x1b[0m  ${meta.skills[name].disabled ? '\x1b[31mDisabled\x1b[0m' : '\x1b[32mActive (injected into context)\x1b[0m'}`);

  ctx.printPanel?.({
    title: `Skill: ${name}`,
    fields: [
      { label: 'Title', value: title, color: '#22d3ee' },
      { label: 'Summary', value: summary, color: '#4ade80' },
      { label: 'Status', value: meta.skills[name].disabled ? 'Disabled' : 'Active (injected into context)', color: meta.skills[name].disabled ? '#f87171' : '#ffd700' },
      { label: 'File', value: filePath, color: '#c0caf5' }
    ]
  });
}

export function deleteSkill(rawName) {
  const name = sanitizeSkillName(rawName);
  if (!name) return { ok: false, error: 'Invalid skill name.' };
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  const meta = readSkillsMeta();
  if (!fs.existsSync(filePath) && !meta.skills[name]) {
    return { ok: false, error: `Skill "${name}" not found.` };
  }
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
  delete meta.skills[name];
  writeSkillsMeta(meta);
  return { ok: true, name };
}

export function disableSkill(rawName) {
  const name = sanitizeSkillName(rawName);
  if (!name) return { ok: false, error: 'Invalid skill name.' };
  const meta = readSkillsMeta();
  if (!meta.skills[name]) {
    return { ok: false, error: `Skill "${name}" not found.` };
  }
  meta.skills[name].disabled = true;
  meta.skills[name].updatedAt = new Date().toISOString();
  writeSkillsMeta(meta);
  return { ok: true, name };
}

export function enableSkill(rawName) {
  const name = sanitizeSkillName(rawName);
  if (!name) return { ok: false, error: 'Invalid skill name.' };
  const meta = readSkillsMeta();
  if (!meta.skills[name]) {
    return { ok: false, error: `Skill "${name}" not found.` };
  }
  meta.skills[name].disabled = false;
  meta.skills[name].updatedAt = new Date().toISOString();
  writeSkillsMeta(meta);
  return { ok: true, name };
}

export function getSkillsPromptList() {
  const skills = listSkills().filter((s) => !s.disabled);
  return skills.map((s) => {
    let desc = '';
    if (s.title && s.summary) {
      if (s.summary.toLowerCase().startsWith(s.title.toLowerCase())) {
        desc = s.summary;
      } else {
        desc = `${s.title} — ${s.summary}`;
      }
    } else {
      desc = s.summary || s.title || `Custom skill for ${s.name}`;
    }
    return {
      name: s.name,
      title: s.title || s.name,
      summary: s.summary,
      line: `- ${s.name}: ${desc}`
    };
  });
}
