import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const CONFIG_PATH = path.join(LEVI_HOME, 'config.json');

export const EFFORTS = {
  eternal: {
    id: 'eternal',
    name: 'Eternal',
    level: 'low',
    label: 'Eternal (low)',
    description: 'uses light mode with low effort or conversational mode',
    maxLiteSteps: 6,
    maxAgentSteps: 12,
    tokenBudgetMult: 0.6
  },
  empyrean: {
    id: 'empyrean',
    name: 'Empyrean',
    level: 'medium',
    label: 'Empyrean (medium)',
    description: 'uses light mode with medium effort, default for everything and best for everything',
    maxLiteSteps: 12,
    maxAgentSteps: 30,
    tokenBudgetMult: 1.0
  },
  abyssal: {
    id: 'abyssal',
    name: 'Abyssal',
    level: 'high',
    label: 'Abyssal (high)',
    description: 'uses light mode or agent mode sometimes but mostly light, thinks longer',
    maxLiteSteps: 18,
    maxAgentSteps: 40,
    tokenBudgetMult: 1.5
  },
  seraphic: {
    id: 'seraphic',
    name: 'Seraphic',
    level: 'max',
    label: 'Seraphic (max)',
    description: 'uses agent mode and light mode, mostly light mode but max effort',
    maxLiteSteps: 25,
    maxAgentSteps: 60,
    tokenBudgetMult: 2.0
  }
};

export const EFFORT_LIST = [
  EFFORTS.eternal,
  EFFORTS.empyrean,
  EFFORTS.abyssal,
  EFFORTS.seraphic
];

export function getEffort() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return EFFORTS.empyrean;
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const id = (c.effort || 'empyrean').toLowerCase().trim();
    return (
      EFFORTS[id] ||
      Object.values(EFFORTS).find((e) => e.level === id || e.name.toLowerCase() === id) ||
      EFFORTS.empyrean
    );
  } catch {
    return EFFORTS.empyrean;
  }
}

export function setEffort(id) {
  const norm = String(id || '').toLowerCase().trim();
  const found =
    EFFORTS[norm] ||
    Object.values(EFFORTS).find((e) => e.level === norm || e.name.toLowerCase() === norm);
  if (!found) {
    throw new Error(
      `Unknown effort: "${id}". Must be one of: eternal, empyrean, abyssal, seraphic (or low, medium, high, max).`
    );
  }
  let c = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  c.effort = found.id;
  fs.mkdirSync(LEVI_HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
  return found;
}
