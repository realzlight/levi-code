import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { currentSessionId, setProject } from './session.js';

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

    return `Error: unknown tool ${name}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}
