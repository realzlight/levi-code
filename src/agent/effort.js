import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEVI_HOME = path.join(os.homedir(), '.levi');
const CONFIG_PATH = path.join(LEVI_HOME, 'config.json');

export const EFFORTS = {
  empyrean: {
    id: 'empyrean',
    name: 'Empyrean',
    level: 'low',
    label: 'Empyrean (low)',
    description: 'Blazing fast reply and light works or chit chat.',
    pacing: 'Blazing Fast · Minimal latency',
    mode: 'light',
    maxLiteSteps: 500,
    maxAgentSteps: 12,
    tokenBudgetMult: 1.0
  },
  oculus: {
    id: 'oculus',
    name: 'Oculus',
    level: 'medium',
    label: 'Oculus (medium)',
    description: 'For building (recommended). Harmonic balance of speed and precision.',
    pacing: 'Balanced · Standard cadence (recommended)',
    mode: 'light',
    maxLiteSteps: 500,
    maxAgentSteps: 30,
    tokenBudgetMult: 1.0
  },
  abyssal: {
    id: 'abyssal',
    name: 'Abyssal',
    level: 'high',
    label: 'Abyssal (high)',
    description: 'Leveling up oculus powers and doing more. Deep reasoning for complex tasks.',
    pacing: 'Deep Thinking · Extended capability',
    mode: 'auto',
    maxLiteSteps: 500,
    maxAgentSteps: 500,
    tokenBudgetMult: 1.0
  },
  seraphic: {
    id: 'seraphic',
    name: 'Seraphic',
    level: 'max',
    label: 'Seraphic (max)',
    description: 'Long thinking and complex tasks. Exhaustive reasoning and boundless resolve.',
    pacing: 'Maximum Depth · Boundless focus',
    mode: 'auto',
    maxLiteSteps: 500,
    maxAgentSteps: 500,
    tokenBudgetMult: 1.0
  }
};

export const EFFORT_LIST = [
  EFFORTS.empyrean,
  EFFORTS.oculus,
  EFFORTS.abyssal,
  EFFORTS.seraphic
];

const ALIASES = {
  eternal: 'empyrean',
  low: 'empyrean',
  oculus: 'oculus',
  medium: 'oculus',
  high: 'abyssal',
  max: 'seraphic'
};

export function getEffort() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return EFFORTS.oculus;
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const raw = (c.effort || 'oculus').toLowerCase().trim();
    const id = ALIASES[raw] || raw;
    return (
      EFFORTS[id] ||
      Object.values(EFFORTS).find((e) => e.level === id || e.name.toLowerCase() === id) ||
      EFFORTS.oculus
    );
  } catch {
    return EFFORTS.oculus;
  }
}

export function setEffort(id) {
  const raw = String(id || '').toLowerCase().trim();
  const norm = ALIASES[raw] || raw;
  const found =
    EFFORTS[norm] ||
    Object.values(EFFORTS).find((e) => e.level === norm || e.name.toLowerCase() === norm);
  if (!found) {
    throw new Error(
      `Unknown effort: "${id}". Must be one of: empyrean, oculus, abyssal, seraphic (or low, medium, high, max).`
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

