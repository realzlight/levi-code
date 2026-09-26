import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BUFFER_ROOT = path.join(os.homedir(), '.levi', 'ACTIVE-BUFFER');

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
// Auto-completes the cluster (status, date, auto-summary) once every task in it is done.
export function setTaskDone(id, clusterNum, taskIndex, done = true) {
  const clusters = parseTasks(id);
  const cluster = clusters.find((c) => c.num === clusterNum);
  if (!cluster || !cluster.tasks[taskIndex]) return false;

  cluster.tasks[taskIndex].done = done;

  const allDone = cluster.tasks.every((t) => t.done);
  if (allDone && cluster.status !== 'completed') {
    cluster.status = 'completed';
    cluster.completedDate = new Date().toISOString().slice(0, 10);
    cluster.summary = `Completed: ${cluster.tasks.map((t) => t.text).join(', ')}`;
  } else if (!allDone && cluster.status === 'completed') {
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
