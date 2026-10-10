import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { currentSessionId, setProject, searchSessions, readSessionOverview, isSoloOnly, getProject } from './session.js';
import { runSubAgent } from './subagent.js';
import { upsertSubAgent, getSubAgent, loadRegistry } from './subagent-registry.js';
import { recordUsage } from './usage.js';
import { RULES } from './prompts.js';
import { addCluster, setTaskDone, getTasks, editTask, deleteTask, deleteCluster, addTaskToCluster } from './tasks.js';

function resolve(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
export const CATEGORIES = {
  fs: ['read_file','write_file','edit_file','bash','find','list_dir','read_lines','grep_search'],
  web: ['web_launch','web_close','web_new_tab','web_goto','web_back','web_reload','web_click','web_dblclick','web_fill','web_press','web_hover','web_drag','web_scroll','web_screenshot','web_get_text','web_get_url','web_wait'],
  desktop: ['desktop_click','desktop_type','desktop_press','desktop_scroll','desktop_drag','desktop_screenshot','desktop_get_window_state','desktop_list_apps','desktop_launch_app'],
  tasks: ['add_task_cluster','get_tasks','set_task_done','edit_task','delete_task','delete_cluster','add_task_to_cluster'],
  memory: ['set_project','search_sessions','read_session'],
  meta: ['list_commands','list_fs_commands','list_web_commands','list_desktop_commands','list_task_commands','list_memory_commands','list_meta_commands','list_subagent_commands','list_mcp_commands','ask'],
  subagent: ['spawn_subagent','list_subagents','message_subagent'],
  mcp: ['mcp_search','mcp_list']
};

function buildUsage(fn) {
  const props = fn.parameters?.properties || {};
  const required = fn.parameters?.required || [];
  const args = Object.keys(props).map(k => required.includes(k)? k : `${k}?`).join(', ');
  return `${fn.name}(${args})`;
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
        properties: { path: { type: 'string', description: 'File path (~ ok)' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file (overwrites; creates parent dirs).',
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
      description: 'Replace old_str (must match exactly once) with new_str in a file.',
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
      description: 'Run a shell command.',
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
      name: 'find',
      description: 'Find files and directories by name or substring. Fast, ignores node_modules/.git. Caps at 50 results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'File name, extension, or substring to search for (e.g. "agent.py", ".json", "prompts")' },
          path: { type: 'string', description: 'Directory to search within (optional, defaults to current directory; ~ supported)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List contents of a directory with file types, sizes, and item counts. Fast, ignores node_modules/.git.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list (optional, defaults to current directory; ~ supported)' },
          depth: { type: 'number', description: 'Recursion depth (optional, 1 for shallow listing, max 3; default 1)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_lines',
      description: 'Read a specific line range from a text file (1-indexed, inclusive). Saves tokens on large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (~ supported)' },
          start: { type: 'number', description: '1-indexed starting line number' },
          end: { type: 'number', description: '1-indexed ending line number (inclusive)' }
        },
        required: ['path', 'start', 'end']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search for text or regex pattern across files. Fast, ignores node_modules/.git. Caps at 25 matches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regular expression pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search within (optional, defaults to current directory; ~ supported)' },
          extension: { type: 'string', description: 'Optional file extension filter, e.g. "js", "ts", "json", "py"' }
        },
        required: ['query']
      }
    }
  },

  { type: 'function', function: { name: 'list_tools', description: 'Load a tool category and see its usage: fs, web, desktop, tasks, memory, meta, subagent, or mcp.', parameters: { type: 'object', properties: { category: { type: 'string', enum: ['fs', 'web', 'desktop', 'tasks', 'memory', 'meta', 'subagent', 'mcp'] } }, required: ['category'] } } },

  {
    type: 'function',
    function: {
      name: 'set_project',
      description: 'Set the current session project. Creates ~/.levi/PROJECTS/<name>/ with DATA.md, PREFERENCE.md, PATTERNS.md; memory writes go there.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Short lowercase name' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_task_cluster',
      description: 'Create a task cluster: a titled, numbered group of concrete subtasks in TASK.md. Use for multi-step work.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short cluster title' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'One string per subtask' }
        },
        required: ['title', 'tasks']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_task_done',
      description: 'Mark a task done or not done by cluster number and 0-based task index. A cluster auto-completes when all its tasks are done.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'number', description: 'Cluster number' },
          taskIndex: { type: 'number', description: '0-based task index' },
          done: { type: 'boolean', description: 'Default true' }
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
  },
  {
    type: 'function',
    function: {
      name: 'search_sessions',
      description: 'Search other sessions by keyword. Use when the user refers to something from before or another session.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keyword' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_session',
      description: 'Read another session summary or truncated buffer by id. Use after search_sessions.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: 'Session id' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: 'Delegate ONE concrete, self-contained task to a sub-agent (file/bash only; no memory, tasks, or questions). Give exact file(s), change, and what to report. Blocked in solo mode (/alone).',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Short role name, e.g. "bugfixer"' },
          instruction: { type: 'string', description: 'Exact task: file(s), change, what to report' }
        },
        required: ['role', 'instruction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_subagents',
      description: 'List all sub-agents spawned so far this session, with their role, original task, status (done/stuck), and last report.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'message_subagent',
      description: 'Send a follow-up to an existing sub-agent by role instead of spawning a duplicate.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Existing sub-agent role' },
          message: { type: 'string', description: 'The follow-up instruction' }
        },
        required: ['role', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask',
      description: 'Ask the user a question with clickable options (e.g. yes/no). Ends your turn; their pick comes back as the next message.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask' },
          options: { type: 'array', items: { type: 'string' }, description: 'Short option labels, e.g. ["Yes", "No"]' },
          allowCustom: { type: 'boolean', description: 'Also allow a typed answer (default true)' }
        },
        required: ['question', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'google_search',
      description: 'Google search (Serper) for live info, docs, news, examples.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search query' },
          num: { type: 'number', description: 'Result count (default 10)' },
          site: { type: 'string', description: 'Limit to a domain, e.g. github.com' }
        },
        required: ['q']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'serper_search',
      description: 'Search Google via Serper API. Alias for google_search.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          num: { type: 'number', description: 'Number of results (default: 10)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch',
      description: 'Fetch a web page as readable markdown.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          max_length: { type: 'number', description: 'Max chars (default 5000)' },
          start_index: { type: 'number', description: 'Start offset (default 0)' },
          raw: { type: 'boolean', description: 'Raw HTML if true' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_launch',
      description: 'Start Chrome browser via Playwright. Visible window by default (headless=false).',
      parameters: {
        type: 'object',
        properties: {
          headless: { type: 'boolean', description: 'Run in headless mode (default false for visible browser)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_close',
      description: 'Close the browser and active session.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_new_tab',
      description: 'Open a new browser tab, optionally navigating to a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Optional URL to open in the new tab' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_goto',
      description: 'Navigate the active tab to a URL (e.g. https://youtube.com, https://twitch.tv, https://google.com).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target website URL' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_back',
      description: 'Navigate back to the previous page in history.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_reload',
      description: 'Reload the current page.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_click',
      description: 'Click an element by button/link text (e.g. "Play", "Follow", "Subscribe"), ID, or CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Button text, link text, CSS selector, or ID to click' }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_dblclick',
      description: 'Double click an element by text, ID, or CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Element text, CSS selector, or ID' }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fill',
      description: 'Type text into an input box, search field, or chat (matches placeholder, label, text, or CSS).',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Input field placeholder, label, name, or CSS selector' },
          text: { type: 'string', description: 'Text to type into the field' }
        },
        required: ['selector', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_press',
      description: 'Press a keyboard key (e.g. "Enter", "Escape", "Space", "f", "k", "m", "ArrowDown").',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name to press' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_hover',
      description: 'Hover over an element by text, ID, or CSS selector to reveal menus or toolbars.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Element text, CSS selector, or ID' }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_drag',
      description: 'Drag one element to another (e.g. sliders, progress bars, timeline scrubbers).',
      parameters: {
        type: 'object',
        properties: {
          from_selector: { type: 'string', description: 'Source element text or selector' },
          to_selector: { type: 'string', description: 'Destination element text or selector' }
        },
        required: ['from_selector', 'to_selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_scroll',
      description: 'Scroll the active page up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (up or down; default down)' },
          amount: { type: 'number', description: 'Distance to scroll in pixels (default 500)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_screenshot',
      description: 'Capture screenshot of current page (~/.levi/screenshots/ by default).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional output file path (~ supported)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_get_text',
      description: 'Read text from an element (video title, views, chat, comments) or full page.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional element text, CSS selector, or ID (reads page if omitted)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_get_url',
      description: 'Get current page URL and title.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_wait',
      description: 'Wait for an element to appear/load or wait for milliseconds.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Element text/selector to wait for, or milliseconds duration' },
          timeout: { type: 'number', description: 'Max wait timeout in milliseconds (default 10000)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_click',
      description: 'Click mouse at desktop screen coordinate (x, y) via cua-driver MCP.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Screen X coordinate in pixels' },
          y: { type: 'number', description: 'Screen Y coordinate in pixels' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default "left")' },
          double: { type: 'boolean', description: 'Double click if true' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_type',
      description: 'Type text into active desktop window/input via keyboard simulation (cua-driver).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text string to type' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_press',
      description: 'Press a keyboard key or hotkey (e.g. "Enter", "Escape", "Tab", "Space", "Super") via cua-driver.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name to press' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_scroll',
      description: 'Scroll mouse wheel up or down by pixel amount (cua-driver).',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default "down")' },
          amount: { type: 'number', description: 'Scroll distance in pixels (default 300)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_drag',
      description: 'Drag mouse from (from_x, from_y) to (to_x, to_y) coordinates (cua-driver).',
      parameters: {
        type: 'object',
        properties: {
          from_x: { type: 'number' },
          from_y: { type: 'number' },
          to_x: { type: 'number' },
          to_y: { type: 'number' }
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_screenshot',
      description: 'Capture screenshot of entire desktop display (~/.levi/screenshots/ by default).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional custom output file path' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_get_window_state',
      description: 'Get active focused desktop window name, title, and display geometry (cua-driver).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_list_apps',
      description: 'List active desktop applications and open window titles (cua-driver).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_launch_app',
      description: 'Launch a desktop application by name or executable (e.g. "code", "firefox", "slack").',
      parameters: {
        type: 'object',
        properties: {
          app_name: { type: 'string', description: 'Application name or command' }
        },
        required: ['app_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save one durable fact to memory. Picks the right file (project or global) and skips duplicates.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['user', 'preference', 'pattern', 'project'], description: 'user=who they are, preference=how they want things, pattern=recurring habit, project=project facts' },
          fact: { type: 'string', description: 'One short fact' }
        },
        required: ['kind', 'fact']
      }
    }
  },
  { type: 'function', function: { name: 'mcp_search', description: 'Search custom MCP tools by keyword and load the matches so you can call them.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Action or tool keyword, e.g. "repos", "pull requests", "issues", "commits"' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'mcp_list', description: 'List configured MCP servers. If server name is provided, lists all tools available on that server.', parameters: { type: 'object', properties: { server: { type: 'string', description: 'Optional MCP server name (e.g. "github", "youtube") to view its full tool catalog' } } } } }
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

if (name === 'mcp_search') {
      const { searchMcp } = await import('../mcp.js');
      return await searchMcp(args?.query);
    }

    if (name === 'mcp_list') {
      const { getMcpServerNames, connectedServers, getServerTools } = await import('../mcp.js');
      const names = getMcpServerNames();
      const connected = connectedServers();
      if (!names.length) return 'No MCP servers configured. Add with /mcp:add <name> <command> [args]';
      if (args?.server) {
        const s = String(args.server).toLowerCase().trim();
        if (!names.includes(s)) return `MCP server "${s}" not found. Configured servers: ${names.join(', ')}`;
        const tools = getServerTools(s);
        if (!tools.length) return `No tools indexed for server "${s}". Run mcp_search("${s}") to connect and discover.`;
        return `Tools on MCP server "${s}" (${tools.length} available):\n` +
          tools.map(t => `- ${t.n}: ${(t.d || '').slice(0, 100)}`).join('\n') +
          '\n\nUse mcp_search("<tool_name>") to load any of these tools into active context.';
      }
      return names.map(n => `${connected.includes(n) ? '🟢' : '⚪'} ${n}`).join('\n') +
        '\n\nTip: call mcp_list(server: "<name>") to see all tools available on a specific server.';
    }

    if (name === 'list_tools') {
      const cat = String(args?.category || '').toLowerCase().replace(/^task$/, 'tasks');
      const alias = { fs: 'list_fs_commands', web: 'list_web_commands', desktop: 'list_desktop_commands', tasks: 'list_task_commands', memory: 'list_memory_commands', meta: 'list_meta_commands', subagent: 'list_subagent_commands', mcp: 'list_mcp_commands' }[cat];
      if (!alias) return 'Error: category must be fs, web, desktop, tasks, memory, meta, subagent, or mcp';
      const out = await runTool(alias, {});
      return RULES[cat] && !out.startsWith('[SOLO') ? out + '\n\n' + RULES[cat] : out;
    }

    if (name === 'list_commands' || name === 'list_fs_commands' || name === 'list_web_commands' || name === 'list_desktop_commands' || name === 'list_task_commands' || name === 'list_memory_commands' || name === 'list_meta_commands' || name === 'list_subagent_commands' || name === 'list_mcp_commands') {

  // category filtering
  let filtered = toolDefs;
  if (name!== 'list_commands') {
    const cat = name.replace('list_','').replace('_commands','').replace(/^task$/, 'tasks'); // fs, web, tasks, memory, meta, subagent
    const names = CATEGORIES[cat] || [];
    if (cat === 'subagent' && isSoloOnly()) {
      return '[SOLO MODE ON - subagent tools hidden, /solo off to enable]';
    }
    filtered = toolDefs.filter(t => names.includes(t.function.name));
  } else {
    // index only - cheap
    return JSON.stringify(getAllCategoriesSummary(), null, 2);
  }

  const tools = filtered.map((t) => {
    const fn=t.function;
    const u = buildUsage(fn);
    return u;
  }).join('\n');

  return `Tools [${name}] now loaded, call them directly:\n${tools}`;
}
    if (name === 'remember') {
      const kind = String(args.kind || '').toLowerCase();
      const fact = String(args.fact || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!fact) return 'Error: fact required';
      if (!['user', 'preference', 'pattern', 'project'].includes(kind)) return 'Error: kind must be user, preference, pattern, or project';
      const sid = currentSessionId();
      const project = sid ? getProject(sid) : null;
      if (kind === 'project' && !project) return 'Error: no project set for this session. Use set_project first, or save as user or preference.';
      const home = path.join(os.homedir(), '.levi');
      const fileName = { user: 'USER.md', preference: 'PREFERENCE.md', pattern: 'PATTERNS.md', project: 'DATA.md' }[kind];
      const dir = kind !== 'user' && project ? path.join(home, 'PROJECTS', project) : path.join(home, 'MEMORY');
      const p = path.join(dir, fileName);
      fs.mkdirSync(dir, { recursive: true });
      const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
      if (existing.length > 8000) return `Error: ${fileName} is large (${existing.length} chars); condense it with edit_file first.`;
      const norm = (s) => s.toLowerCase().replace(/^[-*\s]+/, '').replace(/\|.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
      if (existing.split('\n').some((l) => norm(l) === norm(fact))) return 'Already saved.';
      const line = kind === 'pattern' ? `- ${fact} | status: unconfirmed | confidence: 0.5` : `- ${fact}`;
      fs.appendFileSync(p, (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n');
      return `Saved to ${path.relative(home, p)}: ${fact}`;
    }

    if (name === 'bash') {
      const r = await execa(args.command, { shell: true, reject: false, all: true });
      return r.all || `(exit ${r.exitCode}, no output)`;
    }

    if (name === 'find') {
      const q = String(args?.query || '').trim();
      if (!q) return 'Error: query required';
      const root = resolve(args?.path || '.');
      if (!fs.existsSync(root)) return `Error: path does not exist: ${root}`;
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) return `Error: ${root} is not a directory`;

      const qLower = q.toLowerCase();
      const results = [];
      const IGNORE_DIRS = new Set(['.git', 'node_modules', '.cache', '.npm', '.cargo', '.vscode', '.idea', 'dist', 'build', '.next', '.levi']);

      function walk(currentDir, depth) {
        if (depth > 12 || results.length >= 50) return;
        let entries;
        try {
          entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (results.length >= 50) break;
          const fullPath = path.join(currentDir, entry.name);
          const relPath = path.relative(root, fullPath) || entry.name;
          const nameLower = entry.name.toLowerCase();
          const relLower = relPath.toLowerCase();

          if (nameLower.includes(qLower) || relLower.includes(qLower)) {
            results.push(entry.isDirectory() ? relPath + '/' : relPath);
          }

          if (entry.isDirectory()) {
            if (!IGNORE_DIRS.has(entry.name)) {
              walk(fullPath, depth + 1);
            }
          }
        }
      }

      walk(root, 0);

      if (!results.length) return `No files or directories matching "${q}" found in ${root}`;
      const header = results.length >= 50
        ? `Found 50+ matches for "${q}" in ${root} (capped at 50):`
        : `Found ${results.length} match(es) for "${q}" in ${root}:`;
      return header + '\n' + results.join('\n');
    }

    if (name === 'list_dir') {
      const root = resolve(args?.path || '.');
      if (!fs.existsSync(root)) return `Error: path does not exist: ${root}`;
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) return `Error: ${root} is not a directory`;

      const maxDepth = Math.min(Math.max(1, parseInt(args?.depth) || 1), 3);
      const IGNORE_DIRS = new Set(['.git', 'node_modules', '.cache']);

      function formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1048576).toFixed(1)} MB`;
      }

      const lines = [];

      function listLevel(dir, currentDepth, indent) {
        if (currentDepth > maxDepth) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          lines.push(`${indent}[error reading directory: ${e.message}]`);
          return;
        }

        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            let countText = '';
            try {
              const children = fs.readdirSync(fullPath);
              countText = ` (${children.length} items)`;
            } catch {}
            lines.push(`${indent}📁 ${entry.name}/${countText}`);
            if (currentDepth < maxDepth && !IGNORE_DIRS.has(entry.name)) {
              listLevel(fullPath, currentDepth + 1, indent + '  ');
            }
          } else {
            let sizeText = '';
            try {
              const st = fs.statSync(fullPath);
              sizeText = ` (${formatSize(st.size)})`;
            } catch {}
            lines.push(`${indent}📄 ${entry.name}${sizeText}`);
          }
        }
      }

      listLevel(root, 1, '');
      if (!lines.length) return `Directory ${root} is empty.`;
      return `Contents of ${root}:\n` + lines.join('\n');
    }

    if (name === 'read_lines') {
      if (!args?.path) return 'Error: path required';
      const p = resolve(args.path);
      if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
      if (fs.statSync(p).isDirectory()) return `Error: ${p} is a directory, not a file`;

      const content = fs.readFileSync(p, 'utf-8');
      const allLines = content.split(/\r?\n/);
      const total = allLines.length;

      let start = parseInt(args?.start);
      let end = parseInt(args?.end);
      if (isNaN(start)) start = 1;
      if (isNaN(end)) end = total;

      if (start < 1) start = 1;
      if (end > total) end = total;
      if (start > end) return `Error: start line (${start}) cannot be greater than end line (${end}) (file has ${total} lines)`;

      const slice = allLines.slice(start - 1, end);
      const pad = String(end).length;
      const formatted = slice.map((line, idx) => {
        const lineNum = String(start + idx).padStart(pad, ' ');
        return `${lineNum} | ${line}`;
      }).join('\n');

      return `[${p} lines ${start}-${end} of ${total}]\n${formatted}`;
    }

    if (name === 'grep_search') {
      const q = String(args?.query || '').trim();
      if (!q) return 'Error: query required';
      const root = resolve(args?.path || '.');
      if (!fs.existsSync(root)) return `Error: path does not exist: ${root}`;

      const extFilter = args?.extension ? args.extension.replace(/^\./, '').toLowerCase() : null;
      const BINARY_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'svg', 'zip', 'tar', 'gz', 'mp3', 'mp4', 'pdf', 'exe', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'bin', 'lock']);
      const IGNORE_DIRS = new Set(['.git', 'node_modules', '.cache', '.npm', '.cargo', '.vscode', '.idea', 'dist', 'build', '.next', '.levi']);

      let regex = null;
      try {
        regex = new RegExp(q, 'i');
      } catch {
        regex = null;
      }

      const matches = [];
      const MAX_MATCHES = 25;

      function searchFile(filePath) {
        if (matches.length >= MAX_MATCHES) return;
        const ext = path.extname(filePath).slice(1).toLowerCase();
        if (BINARY_EXTS.has(ext)) return;
        if (extFilter && ext !== extFilter) return;

        let stat;
        try {
          stat = fs.statSync(filePath);
          if (stat.size > 2 * 1024 * 1024) return;
        } catch {
          return;
        }

        let content;
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          return;
        }

        const lines = content.split(/\r?\n/);
        const relPath = path.relative(process.cwd(), filePath) || filePath;

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_MATCHES) break;
          const line = lines[i];
          const matched = regex ? regex.test(line) : line.toLowerCase().includes(q.toLowerCase());
          if (matched) {
            matches.push(`${relPath}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      const stat = fs.statSync(root);
      if (stat.isDirectory()) {
        function walk(dir, depth) {
          if (depth > 12 || matches.length >= MAX_MATCHES) return;
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (matches.length >= MAX_MATCHES) break;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!IGNORE_DIRS.has(entry.name)) {
                walk(full, depth + 1);
              }
            } else if (entry.isFile()) {
              searchFile(full);
            }
          }
        }
        walk(root, 0);
      } else {
        searchFile(root);
      }

      if (!matches.length) return `No matches found for "${q}" in ${root}`;
      const header = matches.length >= MAX_MATCHES
        ? `Found 25+ matches for "${q}" (capped at 25):`
        : `Found ${matches.length} match(es) for "${q}":`;
      return header + '\n' + matches.join('\n');
    }

    if (name.startsWith('web_')) {
      const { runBrowserTool } = await import('./web-browser.js');
      return await runBrowserTool(name, args);
    }

    if (name.startsWith('desktop_')) {
      const { runDesktopTool } = await import('./desktop.js');
      return await runDesktopTool(name, args);
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

    if (name === 'search_sessions') {
      const currentId = currentSessionId();
      const results = searchSessions(args.query, { excludeId: currentId });
      if (!results.length) return 'No matching sessions found.';
      return JSON.stringify(results, null, 2);
    }

    if (name === 'read_session') {
      const overview = readSessionOverview(args.id);
      if (!overview) return `Error: session ${args.id} not found`;
      return JSON.stringify(overview, null, 2);
    }

    if (name === 'spawn_subagent') {
      if (isSoloOnly()) return 'Error: solo mode is on (/alone) — sub-agents are disabled. Do this work yourself.';

      const role = (args.role || 'subagent').trim();
      const id = currentSessionId();

      if (id && getSubAgent(id, role)) {
        return `Error: a sub-agent named "${role}" already exists this session. Use message_subagent to follow up with it instead of spawning a duplicate.`;
      }

      const { report, messages, usage } = await runSubAgent(role, args.instruction);

      if (id) {
        recordUsage(id, usage);
        upsertSubAgent(id, { role, task: args.instruction, report, messages });
        const reportPath = path.join(os.homedir(), '.levi', 'ACTIVE-BUFFER', `SESSION-${id}`, 'REPORT.MD');
        try {
          fs.appendFileSync(reportPath, `@${role}: ${report}\n\n`);
        } catch {}
      }

      return report;
    }

    if (name === 'list_subagents') {
      const id = currentSessionId();
      if (!id) return 'Error: no active session';
      const registry = loadRegistry(id);
      if (!registry.length) return '(no sub-agents spawned yet this session)';
      return registry
        .map((s) => `@${s.role} [${s.status}] — task: ${s.task}\nlast report: ${s.report}`)
        .join('\n\n');
    }

    if (name === 'message_subagent') {
      if (isSoloOnly()) return 'Error: solo mode is on (/alone) — sub-agents are disabled.';
      const id = currentSessionId();
      if (!id) return 'Error: no active session';

      const existing = getSubAgent(id, args.role);
      if (!existing) return `Error: no sub-agent named "${args.role}" found this session. Use spawn_subagent to create one first.`;

      const { report, messages, usage } = await runSubAgent(args.role, args.message, { existingMessages: existing.messages });
      recordUsage(id, usage);
      upsertSubAgent(id, { role: args.role, task: existing.task, report, messages });

      const reportPath = path.join(os.homedir(), '.levi', 'ACTIVE-BUFFER', `SESSION-${id}`, 'REPORT.MD');
      try {
        fs.appendFileSync(reportPath, `@${args.role} (follow-up): ${report}\n\n`);
      } catch {}

      return report;
    }

    if (name === 'ask') {
      // no filesystem side effect — this is a structured marker the UI layer
      // renders specially; runAgent detects it and surfaces it via onStep
      return JSON.stringify({
        __ask: true,
        question: args.question,
        options: Array.isArray(args.options) ? args.options : [],
        allowCustom: args.allowCustom !== false
      });
    }

    if (name === 'google_search' || name === 'serper_search' || name === 'brave_web_search') {
      const { runMcpTool, getSearchApiKey } = await import('../mcp.js');
      const apiKey = getSearchApiKey();
      if (!apiKey) {
        return 'Error: Serper API key is not configured. Set it using the slash command: /search:api <your-api-key>';
      }
      return await runMcpTool(name, args);
    }

    if (name === 'fetch') {
      const { runMcpTool } = await import('../mcp.js');
      return await runMcpTool(name, args);
    }

    const { isMcpTool, runMcpTool } = await import('../mcp.js');
    if (isMcpTool(name)) {
      return await runMcpTool(name, args);
    }

    return `Error: unknown tool ${name}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

export function getToolsByCategory(cat) {
  const names = CATEGORIES[cat] || [];
  if (isSoloOnly() && cat === 'subagent') return [];
  return toolDefs.filter(t => {
    const name = t.function.name;
    if (name.startsWith('/')) return false; // <-- exclude user commands
    return names.includes(name);
  }).map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    usage: buildUsage(t.function)
  }));
}

// new — for list_commands
export function getUserCommands() {
  return toolDefs.filter(t => t.function.name.startsWith('/')).map(t => ({
    name: t.function.name,
    description: t.function.description,
    usage: buildUsage(t.function)
  }));
}

export function getAllCategoriesSummary() {
  const solo = isSoloOnly();
  return {
    solo_mode: solo? "ON" : "OFF",
    usage: "Run list_<category>_commands to see tools with params, /commands for user commands",
    categories: {
      fs: "use list_fs_commands -> 8 tools",
      web: "use list_web_commands -> 17 tools (browser automation)",
      desktop: "use list_desktop_commands -> 9 tools (desktop automation & cua-driver)",
      tasks: "use list_task_commands -> 7 tools",
      memory: "use list_memory_commands -> 3 tools",
      meta: "use list_meta_commands -> 10 tools",
      subagent: solo? "HIDDEN (solo ON) - /solo off to enable" : "use list_subagent_commands -> 3 tools",
      mcp: "use list_mcp_commands -> 2 tools (mcp_search, mcp_list)",
      user: "use list_commands -> slash commands"
    }
  };
}
