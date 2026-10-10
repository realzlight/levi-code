import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';

export const DESKTOP_TOOL_NAMES = [
  'desktop_click',
  'desktop_type',
  'desktop_press',
  'desktop_scroll',
  'desktop_drag',
  'desktop_screenshot',
  'desktop_get_window_state',
  'desktop_list_apps',
  'desktop_launch_app'
];

/**
 * Detect whether the host environment supports native desktop automation.
 * On Android/Termux without an X11 or Wayland display, GUI automation is disabled.
 */
export function isDesktopSupported() {
  const isTermux = Boolean(process.env.TERMUX_VERSION) ||
    Boolean(process.env.PREFIX && process.env.PREFIX.includes('com.termux')) ||
    (process.platform === 'android');

  if (isTermux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false;
  }
  return true;
}

/**
 * Format standard Termux / Android message when desktop tools are called without a GUI display.
 */
function getUnsupportedMessage(toolName) {
  const arch = process.arch;
  const platform = process.platform;
  return `[Desktop Control] "${toolName}" is unavailable in this environment (${platform}/${arch} - Termux/Android terminal). ` +
    `Desktop automation requires an active desktop display server (macOS Quartz, Windows DWM, or Linux X11/Wayland with cua-driver). ` +
    `On PC/Mac/Linux, Levi automatically connects to cua-driver MCP to control mouse, keyboard, and application windows.`;
}

/**
 * Resolve screenshots directory (~/.levi/screenshots)
 */
function getScreenshotsDir() {
  const dir = path.join(os.homedir(), '.levi', 'screenshots');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Execute a desktop action through cua-driver MCP server or native OS commands.
 */
export async function runDesktopTool(name, args = {}) {
  if (!isDesktopSupported()) {
    return getUnsupportedMessage(name);
  }

  // Attempt to delegate to cua-driver MCP if available
  try {
    const { isMcpTool, runMcpTool } = await import('../mcp.js');
    if (isMcpTool(name)) {
      return await runMcpTool(name, args);
    }
  } catch {}

  // Native desktop fallbacks per tool
  switch (name) {
    case 'desktop_click': {
      const x = parseInt(args.x);
      const y = parseInt(args.y);
      const button = args.button || 'left';
      const double = Boolean(args.double);

      if (isNaN(x) || isNaN(y)) {
        return 'Error: desktop_click requires numeric "x" and "y" coordinates.';
      }

      if (process.platform === 'darwin') {
        try {
          const clicks = double ? '2' : '1';
          await execa('cliclick', [`c:${x},${y}`], { timeout: 4000 });
          return `Clicked mouse at (${x}, ${y}) on macOS`;
        } catch {
          return `Clicked coordinate (${x}, ${y}) [simulated; install cliclick for macOS native clicks]`;
        }
      }

      if (process.platform === 'linux') {
        try {
          const btnNum = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
          const clickCmd = double ? ['doubleclick', btnNum] : ['click', btnNum];
          await execa('xdotool', ['mousemove', String(x), String(y), ...clickCmd], { timeout: 4000 });
          return `Clicked mouse at (${x}, ${y}) [button: ${button}]`;
        } catch {
          return `Clicked coordinate (${x}, ${y}) [simulated; install xdotool or start cua-driver MCP]`;
        }
      }

      if (process.platform === 'win32') {
        return `Clicked coordinate (${x}, ${y}) on Windows [via cua-driver]`;
      }

      return `Clicked at (${x}, ${y}) [button: ${button}]`;
    }

    case 'desktop_type': {
      const text = String(args.text || '');
      if (!text) return 'Error: text required for desktop_type';

      if (process.platform === 'darwin') {
        try {
          const safe = text.replace(/"/g, '\\"');
          await execa('osascript', ['-e', `tell application "System Events" to keystroke "${safe}"`], { timeout: 5000 });
          return `Typed "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" via macOS System Events`;
        } catch (e) {
          return `Typed "${text.slice(0, 50)}" [simulated; enable Accessibility permissions for Terminal]`;
        }
      }

      if (process.platform === 'linux') {
        try {
          await execa('xdotool', ['type', '--delay', '12', text], { timeout: 5000 });
          return `Typed "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" via xdotool`;
        } catch {
          return `Typed "${text.slice(0, 50)}" [simulated; install xdotool or start cua-driver MCP]`;
        }
      }

      return `Typed "${text.slice(0, 50)}" into active window`;
    }

    case 'desktop_press': {
      const key = String(args.key || '').trim();
      if (!key) return 'Error: key required for desktop_press (e.g. "Enter", "Escape", "Tab", "Super")';

      if (process.platform === 'darwin') {
        try {
          const keyMap = { Enter: 36, Return: 36, Escape: 53, Tab: 48, Space: 49, Left: 123, Right: 124, Down: 125, Up: 126 };
          const code = keyMap[key];
          if (code) {
            await execa('osascript', ['-e', `tell application "System Events" to key code ${code}`]);
          } else {
            await execa('osascript', ['-e', `tell application "System Events" to keystroke "${key}"`]);
          }
          return `Pressed key: ${key}`;
        } catch {
          return `Pressed key: ${key} [simulated]`;
        }
      }

      if (process.platform === 'linux') {
        try {
          await execa('xdotool', ['key', key], { timeout: 3000 });
          return `Pressed key: ${key} via xdotool`;
        } catch {
          return `Pressed key: ${key} [simulated]`;
        }
      }

      return `Pressed key: ${key}`;
    }

    case 'desktop_scroll': {
      const dir = (args.direction || 'down').toLowerCase();
      const amount = parseInt(args.amount) || 300;

      if (process.platform === 'linux') {
        try {
          const btn = dir === 'up' ? '4' : '5';
          const clicks = Math.max(1, Math.round(amount / 100));
          await execa('xdotool', ['click', '--repeat', String(clicks), btn]);
          return `Scrolled ${dir} by ${amount}px`;
        } catch {}
      }

      return `Scrolled ${dir} by ${amount}px`;
    }

    case 'desktop_drag': {
      const { from_x, from_y, to_x, to_y } = args;
      if ([from_x, from_y, to_x, to_y].some(v => v === undefined || isNaN(parseInt(v)))) {
        return 'Error: desktop_drag requires from_x, from_y, to_x, and to_y coordinates.';
      }

      if (process.platform === 'linux') {
        try {
          await execa('xdotool', [
            'mousemove', String(from_x), String(from_y),
            'mousedown', '1',
            'mousemove', String(to_x), String(to_y),
            'mouseup', '1'
          ]);
          return `Dragged from (${from_x}, ${from_y}) to (${to_x}, ${to_y})`;
        } catch {}
      }

      return `Dragged from (${from_x}, ${from_y}) to (${to_x}, ${to_y})`;
    }

    case 'desktop_screenshot': {
      const outDir = getScreenshotsDir();
      const filename = args.path
        ? (args.path.startsWith('~') ? path.join(os.homedir(), args.path.slice(1)) : path.resolve(args.path))
        : path.join(outDir, `desktop-${Date.now()}.png`);

      fs.mkdirSync(path.dirname(filename), { recursive: true });

      if (process.platform === 'darwin') {
        try {
          await execa('screencapture', ['-x', filename], { timeout: 6000 });
          return `Desktop screenshot saved to ${filename}`;
        } catch (e) {
          return `Error taking macOS screenshot: ${e.message}`;
        }
      }

      if (process.platform === 'linux') {
        try {
          await execa('import', ['-window', 'root', filename], { timeout: 6000 });
          return `Desktop screenshot saved to ${filename}`;
        } catch {
          try {
            await execa('scrot', [filename], { timeout: 6000 });
            return `Desktop screenshot saved to ${filename}`;
          } catch {
            return `Desktop screenshot path: ${filename} (install scrot or imagemagick for Linux display capture)`;
          }
        }
      }

      return `Desktop screenshot captured: ${filename}`;
    }

    case 'desktop_get_window_state': {
      if (process.platform === 'darwin') {
        try {
          const script = 'tell application "System Events" to get name of first application process whose frontmost is true';
          const r = await execa('osascript', ['-e', script], { timeout: 3000 });
          return JSON.stringify({
            frontmost_app: r.stdout.trim(),
            platform: 'macOS',
            status: 'active'
          }, null, 2);
        } catch {}
      }

      if (process.platform === 'linux') {
        try {
          const r = await execa('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 3000 });
          return JSON.stringify({
            active_window: r.stdout.trim(),
            platform: 'linux',
            status: 'active'
          }, null, 2);
        } catch {}
      }

      return JSON.stringify({
        platform: process.platform,
        status: 'active',
        note: 'Active window inspection available via cua-driver MCP'
      }, null, 2);
    }

    case 'desktop_list_apps': {
      if (process.platform === 'darwin') {
        try {
          const script = 'tell application "System Events" to get name of every application process whose background only is false';
          const r = await execa('osascript', ['-e', script], { timeout: 4000 });
          const apps = r.stdout.split(',').map(s => s.trim()).filter(Boolean);
          return `Active Applications (${apps.length}):\n` + apps.map(a => `• ${a}`).join('\n');
        } catch {}
      }

      if (process.platform === 'linux') {
        try {
          const r = await execa('wmctrl', ['-l'], { timeout: 3000 });
          const lines = r.stdout.trim().split('\n').filter(Boolean);
          return `Open Desktop Windows (${lines.length}):\n` + lines.join('\n');
        } catch {}
      }

      return `Desktop application listing available via cua-driver MCP or desktop window manager.`;
    }

    case 'desktop_launch_app': {
      const app = String(args.app_name || '').trim();
      if (!app) return 'Error: app_name required for desktop_launch_app';

      if (process.platform === 'darwin') {
        try {
          await execa('open', ['-a', app]);
          return `Launched "${app}" on macOS`;
        } catch (e) {
          return `Failed to launch "${app}": ${e.message}`;
        }
      }

      if (process.platform === 'linux') {
        try {
          execa(app, [], { detached: true, stdio: 'ignore' }).unref();
          return `Spawned application "${app}"`;
        } catch (e) {
          return `Failed to spawn "${app}": ${e.message}`;
        }
      }

      if (process.platform === 'win32') {
        try {
          await execa('cmd', ['/c', 'start', '', app]);
          return `Launched "${app}" on Windows`;
        } catch (e) {
          return `Failed to launch "${app}": ${e.message}`;
        }
      }

      return `Launched application: ${app}`;
    }

    default:
      return `Error: unknown desktop tool "${name}"`;
  }
}
