import fs from 'node:fs';
import path from 'node:path';

// Walks up from a starting directory looking for a project root marker
// (package.json with a "name" field, or a .git folder). Returns a project
// name to key MEMORY/PROJECTS/<name>/ by, or null if no marker is found
// before hitting the filesystem root.
export function detectProject(startDir = process.cwd()) {
  let dir = startDir;

  while (true) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name) return pkg.name;
      } catch {}
    }

    if (fs.existsSync(path.join(dir, '.git'))) {
      return path.basename(dir);
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
}

// Walks up from startDir looking for a user-created project playbook (LEVI.md or .levirules)
export function readProjectPlaybook(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  const candidates = ['LEVI.md', '.levirules', 'levi.md'];

  while (true) {
    for (const file of candidates) {
      const p = path.join(dir, file);
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf-8').trim();
          if (content) {
            return {
              path: p,
              content: content.slice(0, 3000)
            };
          }
        } catch {}
      }
    }

    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
