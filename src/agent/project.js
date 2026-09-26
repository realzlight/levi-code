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
