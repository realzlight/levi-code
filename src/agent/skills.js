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

export function recordSkillUsage(rawName) {
  const name = sanitizeSkillName(rawName);
  if (!name) return;
  const meta = readSkillsMeta();
  if (meta.skills[name]) {
    meta.skills[name].usedCount = (meta.skills[name].usedCount || 0) + 1;
    meta.skills[name].lastUsedAt = new Date().toISOString();
    writeSkillsMeta(meta);
  }
}

export function getSkillsPromptList(query = '') {
  const skills = listSkills().filter((s) => !s.disabled);
  let selected = skills;

  // If we have more than 8 skills and a query is available, select top 5 most relevant to save context tokens
  if (skills.length > 8 && query && typeof query === 'string') {
    const qTokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    if (qTokens.length) {
      const scored = skills.map((s) => {
        const text = `${s.name} ${s.title || ''} ${s.summary || ''}`.toLowerCase();
        let score = 0;
        for (const t of qTokens) {
          if (text.includes(t)) score += 1;
        }
        if (s.usedCount) score += Math.min(s.usedCount * 0.2, 1);
        return { s, score };
      });
      scored.sort((a, b) => b.score - a.score);
      // Take matching ones, or top 5 by usage
      const matches = scored.filter((x) => x.score > 0).map((x) => x.s);
      selected = matches.length ? matches.slice(0, 5) : scored.slice(0, 5).map((x) => x.s);
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
      desc = s.summary || s.title || `Custom skill for ${s.name}`;
    }
    const usage = s.usedCount ? ` [used ${s.usedCount}x]` : '';
    return {
      name: s.name,
      title: s.title || s.name,
      summary: s.summary,
      line: `- ${s.name}${usage}: ${desc}`
    };
  });
}

// Save a learned skill directly to ~/.levi/SKILLS/<name>.md and update meta
export function saveLearnedSkill({ name: rawName, title, when_to_use, recipe }) {
  const name = sanitizeSkillName(rawName);
  if (!name) return { ok: false, error: 'Invalid skill name.' };
  ensureSkillsDir();
  const filePath = path.join(SKILLS_DIR, `${name}.md`);

  const cleanTitle = (title || name).trim().replace(/[\r\n]+/g, ' ');
  const cleanSummary = (when_to_use || `Instructions for ${cleanTitle}`).trim().replace(/[\r\n]+/g, ' ');

  const meta = readSkillsMeta();
  let content;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;

  if (existing && existing.length > 50) {
    // Evolutionary update: append new playbook notes to existing skill
    const dateStr = new Date().toISOString().slice(0, 10);
    content = existing.trim() + `\n\n### Additional Playbook / Workaround (${dateStr})\n${(recipe || '').trim()}\n`;
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
  meta.skills[name] = {
    name,
    title: cleanTitle,
    summary: cleanSummary,
    disabled: false,
    usedCount: meta.skills[name]?.usedCount || 0,
    createdAt: meta.skills[name]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeSkillsMeta(meta);
  return { ok: true, name, title: cleanTitle, summary: cleanSummary, path: filePath };
}

// Distill a reusable skill from a completed task's execution trace
export async function distillSkillFromExchange({ userQuery, toolCalls, resultText, requestedName }) {
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
${requestedName ? `Requested skill name: "${requestedName}"` : ''}

Rules:
1. ONLY distill if this is a generalizable, non-trivial recipe, bug fix, configuration, or CLI workflow (e.g. setting up a server, solving an obscure library bug, automating a workflow).
2. If this is a one-off edit, trivial question, simple file read, or project-specific code that cannot be reused elsewhere, return {"should_learn": false}.
3. If it IS reusable, return:
{
  "should_learn": true,
  "name": "${requestedName ? sanitizeSkillName(requestedName) : 'kebab-case-slug'}",
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
      return saveLearnedSkill({
        name: parsed.name,
        title: parsed.title,
        when_to_use: parsed.when_to_use,
        recipe: parsed.recipe
      });
    }
  } catch {}
  return null;
}

// Distill skill from the last session turns (for /learn command)
export async function distillLastSessionSkill(sessionId, requestedName) {
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
      requestedName
    });

    if (res && res.ok) return res;
    return { ok: false, error: 'The recent task was too simple or project-specific to extract a generalizable skill.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Background auto-learner hook triggered after a successful multi-step turn
export async function autoLearnIfEligible({ userQuery, toolCalls, resultText, onStep }) {
  // Eligibility: at least 3 tool calls, modifying action succeeded, no errors
  if (!toolCalls || toolCalls.length < 3) return;
  const hasModifier = toolCalls.some((c) => ['write_file', 'edit_file', 'bash'].includes(c.name));
  if (!hasModifier) return;
  if (!resultText || resultText.includes('API error') || resultText.includes('Interrupted')) return;

  // Run in next tick / background
  setTimeout(async () => {
    try {
      const res = await distillSkillFromExchange({ userQuery, toolCalls, resultText });
      if (res && res.ok) {
        onStep?.('narrate', `✦ Distilled new skill: "${res.name}" (~/.levi/SKILLS/${res.name}.md)`);
      }
    } catch {}
  }, 100);
}

