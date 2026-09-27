import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getProject } from './session.js';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const BUFFER_ROOT = path.join(LEVI_HOME, 'ACTIVE-BUFFER');

function taskFilePath(id) {
  return path.join(BUFFER_ROOT, `SESSION-${id}`, 'TASK.md');
}

export function ensureTaskFile(id) {
  const file = taskFilePath(id);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
}

// Parses TASK.md into an array of clusters:
// { num, title, status: 'active'|'completed', completedDate, summary, tasks: [{ text, done }] }
export function parseTasks(id) {
  let raw = '';
  try {
    raw = fs.readFileSync(taskFilePath(id), 'utf-8');
  } catch {
    return [];
  }
  if (!raw.trim()) return [];

  const clusters = [];
  const blocks = raw.split(/^## /m).slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0];
    const headerMatch = header.match(/^Cluster (\d+) — (.+?) \[status: (active|completed)\](?:\s*\[completed: (.+?)\])?/);
    if (!headerMatch) continue;

    const [, numStr, title, status, completedDate] = headerMatch;
    let summary = '';
    const tasks = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('Summary: ')) {
        summary = line.slice('Summary: '.length).trim();
      } else {
        const taskMatch = line.match(/^- \[( |x)\] (.+)/);
        if (taskMatch) {
          tasks.push({ text: taskMatch[2].trim(), done: taskMatch[1] === 'x' });
        }
      }
    }

    clusters.push({ num: Number(numStr), title: title.trim(), status, completedDate: completedDate || null, summary, tasks });
  }

  return clusters;
}

export function serializeTasks(clusters) {
  return clusters
    .map((c) => {
      const statusTag = c.status === 'completed' ? `[status: completed] [completed: ${c.completedDate}]` : `[status: active]`;
      let block = `## Cluster ${c.num} — ${c.title} ${statusTag}\n`;
      if (c.status === 'completed' && c.summary) block += `Summary: ${c.summary}\n`;
      block += c.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n');
      return block;
    })
    .join('\n\n');
}

function writeClusters(id, clusters) {
  fs.writeFileSync(taskFilePath(id), serializeTasks(clusters) + (clusters.length ? '\n' : ''));
}

function nextClusterNum(clusters) {
  return clusters.length ? Math.max(...clusters.map((c) => c.num)) + 1 : 1;
}

function autoCompleteCheck(cluster) {
  const allDone = cluster.tasks.length > 0 && cluster.tasks.every((t) => t.done);
  const wasCompleted = cluster.status === 'completed';
  if (allDone && !wasCompleted) {
    cluster.status = 'completed';
    cluster.completedDate = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    cluster.summary = 'Completed: ' + cluster.tasks.map((t) => t.text).join(', ');
    return true; // newly completed this call
  } else if (!allDone && wasCompleted) {
    cluster.status = 'active';
    cluster.completedDate = null;
    cluster.summary = '';
  }
  return false;
}

// Appends a one-line dated summary of a finished cluster into the right
// project file (DATA.md if a project is active, USER.md otherwise) — a
// lightweight, best-effort record, not a full history. Never throws; a
// failure here shouldn't break task completion itself.
function archiveCluster(id, cluster) {
  try {
    const projectName = getProject(id);
    const targetFile = projectName
      ? path.join(LEVI_HOME, 'PROJECTS', projectName, 'DATA.md')
      : path.join(LEVI_HOME, 'MEMORY', 'USER.md');

    const timestamp = cluster.completedDate || new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const line = `- [Completed ${timestamp}] ${cluster.title}: ${cluster.summary}`;

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    let existing = '';
    try {
      existing = fs.readFileSync(targetFile, 'utf-8');
    } catch {}
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(targetFile, existing + sep + line + '\n');
  } catch {
    // best-effort only, archiving is not critical enough to fail the task update over
  }
}

export function addCluster(id, title, taskTexts) {
  const clusters = parseTasks(id);
  const num = nextClusterNum(clusters);
  clusters.push({
    num,
    title,
    status: 'active',
    completedDate: null,
    summary: '',
    tasks: taskTexts.map((text) => ({ text, done: false }))
  });
  writeClusters(id, clusters);
  return num;
}

// Toggle a task's done state by cluster number + task index (0-based).
// Auto-completes the cluster once every task in it is done — when that
// happens, the cluster is archived (one line into DATA.md/USER.md) and then
// removed from TASK.md entirely, so completed work doesn't clutter the live
// task list or get mistakenly re-read as still-relevant context.
export function setTaskDone(id, clusterNum, taskIndex, done = true) {
  const clusters = parseTasks(id);
  const idx = clusters.findIndex((c) => c.num === clusterNum);
  if (idx === -1 || !clusters[idx].tasks[taskIndex]) return false;

  const cluster = clusters[idx];
  cluster.tasks[taskIndex].done = done;
  const newlyCompleted = autoCompleteCheck(cluster);

  if (newlyCompleted) {
    archiveCluster(id, cluster);
    clusters.splice(idx, 1);
  }

  writeClusters(id, clusters);
  return true;
}

export function editTask(id, clusterNum, taskIndex, newText) {
  const clusters = parseTasks(id);
  const cluster = clusters.find((c) => c.num === clusterNum);
  if (!cluster || !cluster.tasks[taskIndex]) return false;
  cluster.tasks[taskIndex].text = newText;
  writeClusters(id, clusters);
  return true;
}

export function deleteTask(id, clusterNum, taskIndex) {
  const clusters = parseTasks(id);
  const idx = clusters.findIndex((c) => c.num === clusterNum);
  if (idx === -1 || !clusters[idx].tasks[taskIndex]) return false;

  const cluster = clusters[idx];
  cluster.tasks.splice(taskIndex, 1);
  const newlyCompleted = autoCompleteCheck(cluster);

  if (newlyCompleted) {
    archiveCluster(id, cluster);
    clusters.splice(idx, 1);
  }

  writeClusters(id, clusters);
  return true;
}

export function deleteCluster(id, clusterNum) {
  const clusters = parseTasks(id);
  const idx = clusters.findIndex((c) => c.num === clusterNum);
  if (idx === -1) return false;
  clusters.splice(idx, 1);
  writeClusters(id, clusters);
  return true;
}

export function addTaskToCluster(id, clusterNum, text) {
  const clusters = parseTasks(id);
  const cluster = clusters.find((c) => c.num === clusterNum);
  if (!cluster) return false;
  cluster.tasks.push({ text, done: false });
  if (cluster.status === 'completed') {
    cluster.status = 'active';
    cluster.completedDate = null;
    cluster.summary = '';
  }
  writeClusters(id, clusters);
  return true;
}

export function getTasks(id) {
  return parseTasks(id);
}
