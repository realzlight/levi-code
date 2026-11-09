import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const BUFFER_ROOT = path.join(LEVI_HOME, 'ACTIVE-BUFFER');

function sessionDir(id) {
  return path.join(BUFFER_ROOT, `SESSION-${id}`);
}

function taskJsonPath(id) {
  return path.join(sessionDir(id), 'TASKS.json');
}

function taskMdPath(id) {
  return path.join(sessionDir(id), 'TASK.md');
}

export function ensureTaskFile(id) {
  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Get flat list of tasks for the session:
 * [{ id: '1', text: '...', status: 'todo'|'in_progress'|'done' }]
 */
export function getTaskList(id) {
  if (!id) return [];
  const jPath = taskJsonPath(id);
  if (fs.existsSync(jPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jPath, 'utf-8'));
      if (Array.isArray(data)) return data;
    } catch {}
  }

  // Fallback: parse TASK.md if TASKS.json doesn't exist yet
  const mPath = taskMdPath(id);
  if (fs.existsSync(mPath)) {
    try {
      const raw = fs.readFileSync(mPath, 'utf-8');
      const lines = raw.split('\n');
      const tasks = [];
      let idx = 1;
      for (const line of lines) {
        const m = line.match(/^-\s*\[([ x/])\]\s*(.*)$/i);
        if (m) {
          const char = m[1].toLowerCase();
          const status = char === 'x' ? 'done' : char === '/' ? 'in_progress' : 'todo';
          tasks.push({
            id: String(idx++),
            text: m[2].trim(),
            status
          });
        }
      }
      if (tasks.length) return tasks;
    } catch {}
  }

  return [];
}

/**
 * Save updated task list to TASKS.json and human-readable TASK.md.
 * Does NOT self-delete completed tasks, preserving full session visibility.
 */
export function updateTasks(id, rawTasks) {
  if (!id || !Array.isArray(rawTasks)) return [];
  ensureTaskFile(id);

  const normalized = rawTasks.map((t, i) => {
    const rawStatus = String(t.status || '').toLowerCase().trim();
    let status = 'todo';
    if (rawStatus === 'done' || rawStatus === 'completed' || t.done === true) status = 'done';
    else if (rawStatus === 'in_progress' || rawStatus === 'active' || rawStatus === 'working') status = 'in_progress';

    return {
      id: String(t.id || i + 1),
      text: String(t.text || t.title || '').trim(),
      status
    };
  }).filter((t) => t.text.length > 0);

  // Write TASKS.json
  try {
    fs.writeFileSync(taskJsonPath(id), JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  } catch {}

  // Write clean markdown TASK.md
  try {
    const mdLines = ['# Session Tasks\n'];
    for (const t of normalized) {
      const check = t.status === 'done' ? '[x]' : t.status === 'in_progress' ? '[/]' : '[ ]';
      const tag = t.status === 'in_progress' ? ' *(in progress)*' : '';
      mdLines.push(`- ${check} ${t.text}${tag}`);
    }
    fs.writeFileSync(taskMdPath(id), mdLines.join('\n') + '\n', 'utf-8');
  } catch {}

  return normalized;
}

/**
 * Get tasks formatted for prompt context.
 * Returns concise summary to guide the agent:
 * "active tasks (use task_update to advance):
 *  ✔ [done] Step 1
 *  ◼ [in_progress] Step 2
 *  ◻ [todo] Step 3"
 */
export function getActiveTasksPrompt(id) {
  if (!id) return '';
  const list = getTaskList(id);
  if (!list.length) return '';

  const doneCount = list.filter((t) => t.status === 'done').length;
  const lines = [`current task checklist (${doneCount}/${list.length} completed — use task_update to advance status):`];
  for (const t of list) {
    const icon = t.status === 'done' ? '✔ [done]' : t.status === 'in_progress' ? '◼ [in_progress]' : '◻ [todo]';
    lines.push(`  ${icon} ${t.text}`);
  }
  return lines.join('\n');
}

/**
 * Backward-compatible getTasks adapter for existing callers (loop.js, index.js, thought.js).
 * Returns [{ num: 1, title: 'Tasks', status: 'active'|'completed', tasks: [{ text, done, status }] }]
 */
export function getTasks(id) {
  const list = getTaskList(id);
  if (!list.length) return [];

  const allDone = list.length > 0 && list.every((t) => t.status === 'done');
  return [
    {
      num: 1,
      title: 'Current Tasks',
      status: allDone ? 'completed' : 'active',
      completedDate: allDone ? new Date().toISOString() : null,
      summary: `${list.filter((t) => t.status === 'done').length}/${list.length} tasks completed`,
      tasks: list.map((t) => ({
        id: t.id,
        text: t.text,
        done: t.status === 'done',
        status: t.status
      }))
    }
  ];
}

/**
 * Format todo items directly for ClaudeTodoList UI widget.
 */
export function getTodoItems(id) {
  if (!id) return null;
  const list = getTaskList(id);
  if (!list.length) return null;

  return list.map((t) => ({
    label: t.text,
    status: t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'active' : 'todo'
  }));
}

// --- Legacy adapters for old tools so existing calls never crash ---

export function addCluster(id, title, taskTexts) {
  const existing = getTaskList(id);
  const startId = existing.length + 1;
  const newItems = (taskTexts || []).map((text, i) => ({
    id: String(startId + i),
    text: String(text).trim(),
    status: 'todo'
  }));
  updateTasks(id, [...existing, ...newItems]);
  return 1;
}

export function setTaskDone(id, clusterNum, taskIndex, done = true) {
  const list = getTaskList(id);
  const idx = typeof taskIndex === 'number' ? taskIndex : 0;
  if (!list[idx]) return false;
  list[idx].status = done ? 'done' : 'todo';
  updateTasks(id, list);
  return true;
}

export function editTask(id, clusterNum, taskIndex, newText) {
  const list = getTaskList(id);
  const idx = typeof taskIndex === 'number' ? taskIndex : 0;
  if (!list[idx]) return false;
  list[idx].text = newText;
  updateTasks(id, list);
  return true;
}

export function deleteTask(id, clusterNum, taskIndex) {
  const list = getTaskList(id);
  const idx = typeof taskIndex === 'number' ? taskIndex : 0;
  if (!list[idx]) return false;
  list.splice(idx, 1);
  updateTasks(id, list);
  return true;
}

export function deleteCluster(id, clusterNum) {
  updateTasks(id, []);
  return true;
}

export function addTaskToCluster(id, clusterNum, text) {
  const list = getTaskList(id);
  list.push({
    id: String(list.length + 1),
    text: String(text).trim(),
    status: 'todo'
  });
  updateTasks(id, list);
  return true;
}
