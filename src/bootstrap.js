import fs from 'fs';
import path from 'path';
import os from 'os';

export function runBootstrap({ onProgress = null, quiet = false } = {}) {
  const LEVI_HOME = path.join(os.homedir(), '.levi');
  if (!quiet) console.log(`[levi] Bootstrapping ${LEVI_HOME}`);

  const results = {
    home: LEVI_HOME,
    dirsCount: 5,
    createdDirs: [],
    verifiedDirs: [],
    createdFiles: [],
    verifiedFiles: [],
    patchedFiles: []
  };

  // dirs
  const dirs = ['ACTIVE-BUFFER', 'ENDED-BUFFER', 'PROJECTS', 'SKILLS', 'MEMORY'];
  if (!fs.existsSync(LEVI_HOME)) {
    fs.mkdirSync(LEVI_HOME, { recursive: true });
    results.createdDirs.push('.levi');
  }

  for (const dir of dirs) {
    const fullPath = path.join(LEVI_HOME, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      results.createdDirs.push(dir);
      if (!quiet) console.log(`[levi] Created ${dir}/`);
    } else {
      results.verifiedDirs.push(dir);
    }
  }

  // files
  const files = {
    'config.json': JSON.stringify({
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      auth: {
        token: null,
        user: null,
        loggedIn: false
      },
      models: {},
      active_model: null,
      soloOnly: false,
      currentSession: null
    }, null, 2),
    'mcp.json': JSON.stringify({
      mcpServers: {
        serper: {
          command: "npx",
          args: ["-y", "mcp-server-serper"],
          env: { SERPER_API_KEY: "" }
        },
        fetch: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-fetch"]
        },
        github: {
          url: "https://api.githubcopilot.com/mcp/",
          headers: {}
        }
      }
    }, null, 2),
    'LEVI.md': '# LEVI\n',
    'MEMORY/USER.md': '# USER\n',
    'MEMORY/PREFERENCE.md': '# PREFERENCES\n',
    'MEMORY/PATTERNS.md': 'summary:\nNo strong patterns yet.\n\n\n'
  };

  for (const [fileName, content] of Object.entries(files)) {
    const fullPath = path.join(LEVI_HOME, fileName);
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, content);
      results.createdFiles.push(fileName);
      if (!quiet) console.log(`[levi] Created ${fileName}`);
    } else {
      results.verifiedFiles.push(fileName);
      // patch existing config.json to add auth if missing
      if (fileName === 'config.json') {
        try {
          const cfg = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          if (!cfg.auth) {
            cfg.auth = { token: null, user: null, loggedIn: false };
            fs.writeFileSync(fullPath, JSON.stringify(cfg, null, 2));
            results.patchedFiles.push(fileName);
            if (!quiet) console.log(`[levi] Patched ${fileName} with auth field`);
          } else {
            if (!quiet) console.log(`[levi] Skip ${fileName}`);
          }
        } catch {
          if (!quiet) console.log(`[levi] Skip ${fileName} (invalid json)`);
        }
      } else {
        if (!quiet) console.log(`[levi] Skip ${fileName}`);
      }
    }
  }

  if (!quiet) console.log('[levi] Done ✓');
  return results;
}

export function boot() {
  return runBootstrap({ quiet: false });
}

// Auto-run only when executed directly via CLI
if (process.argv[1] && process.argv[1].endsWith('bootstrap.js')) {
  boot();
}

export default boot;
