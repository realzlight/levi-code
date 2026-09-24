import fs from 'fs';
import path from 'path';
import os from 'os';

const LEVI_HOME = path.join(os.homedir(), '.levi');
console.log(`[levi] Bootstrapping ${LEVI_HOME}`);

// dirs
const dirs = ['MEMORY', 'MEMORY/ACTIVE-BUFFER', 'MEMORY/ENDED-BUFFER', 'MEMORY/PROJECTS', 'MEMORY/SKILLS'];
if (!fs.existsSync(LEVI_HOME)) fs.mkdirSync(LEVI_HOME, { recursive: true });

for (const dir of dirs) {
  const fullPath = path.join(LEVI_HOME, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
    console.log(`[levi] Created ${dir}/`);
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
    active_model: null
  }, null, 2),
  'LEVI.md': '# LEVI\n',
  'MEMORY/USER.MD': '# USER\n',
  'MEMORY/PREFERENCE.MD': '# PREFERENCES\n',
  'MEMORY/PATTERNS.MD': '# PATTERNS\n'
};

for (const [fileName, content] of Object.entries(files)) {
  const fullPath = path.join(LEVI_HOME, fileName);
  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, content);
    console.log(`[levi] Created ${fileName}`);
  } else {
    // patch existing config.json to add auth if missing
    if (fileName === 'config.json') {
      try {
        const cfg = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        if (!cfg.auth) {
          cfg.auth = { token: null, user: null, loggedIn: false };
          fs.writeFileSync(fullPath, JSON.stringify(cfg, null, 2));
          console.log(`[levi] Patched ${fileName} with auth field`);
        } else {
          console.log(`[levi] Skip ${fileName}`);
        }
      } catch {
        console.log(`[levi] Skip ${fileName} (invalid json)`);
      }
    } else {
      console.log(`[levi] Skip ${fileName}`);
    }
  }
}

console.log('[levi] Done ✓');
