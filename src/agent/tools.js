import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { currentSessionId, setProject } from './session.js';
import { addCluster, setTaskDone, getTasks, editTask, deleteTask, deleteCluster, addTaskToCluster } from './tasks.js';

function resolve(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// OpenAI-style function tool definitions
export const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a text file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path, absolute or relative to cwd, ~ allowed' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing one with new content. Creates parent folders if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact substring in a file with new text. old_str must match exactly once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_str: { type: 'string' },
          new_str: { type: 'string' }
        },
        required: ['path', 'old_str', 'new_str']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command and return its output.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_commands',
      description: "List everything Levi can do: both slash commands the user can type, and the tools Levi can call itself.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_project',
      description: 'Mark the current session as working on a specific project. Creates ~/.levi/PROJECTS/<name>/ with DATA.md, PREFERENCE.md, PATTERNS.md if they do not exist, and points future memory writes/compaction at that folder instead of the global MEMORY/ files.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Short lowercase project name, e.g. "pacman" or "calculator"' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_task_cluster',
      description: 'Create a new task cluster in the current session\'s TASK.md — a named, numbered group of related tasks/roadmap items. Use this when a request breaks down into multiple concrete steps worth tracking.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for this cluster, e.g. "Ghost AI" or "Scoring system"' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'List of task descriptions, one per subtask' }
        },
        required: ['title', 'tasks']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_task_done',
      description: 'Mark a task within a cluster done or not done, by cluster number and the task\'s 0-based index within that cluster. When every task in a cluster is marked done, the cluster auto-completes with a date and summary.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'number', description: 'Cluster number, e.g. 1' },
          taskIndex: { type: 'number', description: '0-based index of the task within the cluster' },
          done: { type: 'boolean', description: 'true to mark done, false to un-mark. Defaults to true.' }
        },
        required: ['cluster', 'taskIndex']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'Read all task clusters in the current session\'s TASK.md, with their status and individual task states.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_task',
      description: 'Change the text of an existing task within a cluster, by cluster number and 0-based task index.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'number' },
          taskIndex: { type: 'number' },
          text: { type: 'string', description: 'New task text' }
        },
        required: ['cluster', 'taskIndex', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Remove a single task from a cluster, by cluster number and 0-based task index.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'number' },
          taskIndex: { type: 'number' }
        },
        required: ['cluster', 'taskIndex']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_cluster',
      description: 'Remove an entire task cluster and all its tasks, by cluster number.',
      parameters: {
        type: 'object',
        properties: { cluster: { type: 'number' } },
        required: ['cluster']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_task_to_cluster',
      description: 'Add a new task to an existing cluster (instead of creating a whole new cluster). Re-opens the cluster if it was already completed.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'number' },
          text: { type: 'string' }
        },
        required: ['cluster', 'text']
      }
    }
  }
];

export async function runTool(name, args) {
  try {
    if (name === 'read_file') {
      const p = resolve(args.path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return `Error: ${p} is a directory, not a file`;
      return fs.readFileSync(p, 'utf-8');
    }

    if (name === 'write_file') {
      const p = resolve(args.path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return `Error: ${p} is a directory, not a file. Pick a different filename or remove the directory first.`;
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content);
      return `Wrote ${args.content.length} bytes to ${p}`;
    }

    if (name === 'edit_file') {
      const p = resolve(args.path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return `Error: ${p} is a directory, not a file`;
      const content = fs.readFileSync(p, 'utf-8');
      const count = content.split(args.old_str).length - 1;
      if (count === 0) return `Error: old_str not found in ${p}`;
      if (count > 1) return `Error: old_str matches ${count} times in ${p}, must be unique`;
      fs.writeFileSync(p, content.replace(args.old_str, args.new_str));
      return `Edited ${p}`;
    }

    if (name === 'list_commands') {
      const { getCommands } = await import('../ui/commands.js');
      const { usage } = await import('../ui/args.js');
      const slash = getCommands().map((c) => `${usage(c)} -- ${c.description}`).join('\n');
      const tools = toolDefs.map((t) => `${t.function.name}() -- ${t.function.description}`).join('\n');
      return `Slash commands (typed by the user, prefixed with /):\n${slash}\n\nTools I can call directly:\n${tools}`;
    }

    if (name === 'bash') {
      const r = await execa(args.command, { shell: true, reject: false, all: true });
      return r.all || `(exit ${r.exitCode}, no output)`;
    }

    if (name === 'set_project') {
      const projectName = (args.name || '').trim().toLowerCase().replace(/\s+/g, '-');
      if (!projectName) return 'Error: project name required';
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      setProject(id, projectName);
      const root = path.join(os.homedir(), '.levi', 'PROJECTS', projectName);
      fs.mkdirSync(root, { recursive: true });
      const seed = {
        'DATA.md': '# DATA\n',
        'PREFERENCE.md': '# PREFERENCES\n',
        'PATTERNS.md': 'summary:\nNo strong patterns yet.\n\n\n'
      };
      for (const [f, content] of Object.entries(seed)) {
        const p = path.join(root, f);
        if (!fs.existsSync(p)) fs.writeFileSync(p, content);
      }
      return `Project set to "${projectName}". Future memory facts go to ~/.levi/PROJECTS/${projectName}/`;
    }

    if (name === 'add_task_cluster') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      if (!args.title || !Array.isArray(args.tasks) || !args.tasks.length) return 'Error: title and non-empty tasks array required';
      const num = addCluster(id, args.title, args.tasks);
      return `Created cluster ${num} — "${args.title}" with ${args.tasks.length} task(s)`;
    }

    if (name === 'set_task_done') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const done = args.done === undefined ? true : !!args.done;
      const ok = setTaskDone(id, args.cluster, args.taskIndex, done);
      if (!ok) return `Error: cluster ${args.cluster} or task index ${args.taskIndex} not found`;
      return `Task ${args.taskIndex} in cluster ${args.cluster} marked ${done ? 'done' : 'not done'}`;
    }

    if (name === 'get_tasks') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const clusters = getTasks(id);
      if (!clusters.length) return '(no task clusters yet)';
      return JSON.stringify(clusters, null, 2);
    }

    if (name === 'edit_task') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const ok = editTask(id, args.cluster, args.taskIndex, args.text);
      if (!ok) return `Error: cluster ${args.cluster} or task index ${args.taskIndex} not found`;
      return `Task ${args.taskIndex} in cluster ${args.cluster} updated`;
    }

    if (name === 'delete_task') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const ok = deleteTask(id, args.cluster, args.taskIndex);
      if (!ok) return `Error: cluster ${args.cluster} or task index ${args.taskIndex} not found`;
      return `Task ${args.taskIndex} removed from cluster ${args.cluster}`;
    }

    if (name === 'delete_cluster') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const ok = deleteCluster(id, args.cluster);
      if (!ok) return `Error: cluster ${args.cluster} not found`;
      return `Cluster ${args.cluster} deleted`;
    }

    if (name === 'add_task_to_cluster') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const ok = addTaskToCluster(id, args.cluster, args.text);
      if (!ok) return `Error: cluster ${args.cluster} not found`;
      return `Task added to cluster ${args.cluster}`;
    }

    return `Error: unknown tool ${name}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}
