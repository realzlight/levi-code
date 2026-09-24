// "/sh echo \"hi there\"" -> ['sh', 'echo', 'hi there']
export function tokenize(input) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

function coerce(raw, type = 'string', label) {
  if (type === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? { error: `${label} must be a number` } : { value: n };
  }
  if (type === 'boolean') return { value: raw !== 'false' };
  return { value: raw };
}

// spec = { args: [{ name, required, type, default, rest }], flags: [{ name, alias, type, default }] }
export function parseArgs(spec = {}, tokens = []) {
  const argSpecs = spec.args || [];
  const flagSpecs = spec.flags || [];
  const restIdx = argSpecs.findIndex(a => a.rest);
  const values = {};
  const positional = [];

  for (const f of flagSpecs) if (f.default !== undefined) values[f.name] = f.default;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // once we reach a "rest" arg, everything after is raw text (flags included)
    if (restIdx !== -1 && positional.length >= restIdx) { positional.push(t); continue; }

    const isLong = /^--[a-zA-Z]/.test(t);
    const isShort = /^-[a-zA-Z]$/.test(t);
    if (!isLong && !isShort) { positional.push(t); continue; }

    const [key, inline] = isLong ? t.slice(2).split(/=(.*)/s) : [t.slice(1)];
    const f = flagSpecs.find(x => x.name === key || x.alias === key);
    if (!f) return { error: `Unknown flag: ${t}` };

    if (f.type === 'boolean') {
      values[f.name] = inline === undefined ? true : inline !== 'false';
      continue;
    }

    const raw = inline !== undefined ? inline : tokens[++i];
    if (raw === undefined) return { error: `Flag --${f.name} needs a value` };
    const r = coerce(raw, f.type, `--${f.name}`);
    if (r.error) return r;
    values[f.name] = r.value;
  }

  for (let i = 0; i < argSpecs.length; i++) {
    const a = argSpecs[i];
    let raw;
    if (a.rest) {
      const joined = positional.slice(i).map(t => (/\s/.test(t) ? JSON.stringify(t) : t)).join(' ');
      raw = joined || undefined;
    } else {
      raw = positional[i];
    }

    if (raw === undefined) {
      if (a.default !== undefined) { values[a.name] = a.default; continue; }
      if (a.required) return { error: `Missing <${a.name}>` };
      continue;
    }
    const r = coerce(raw, a.type, `<${a.name}>`);
    if (r.error) return r;
    values[a.name] = r.value;
  }

  const max = restIdx !== -1 ? Infinity : argSpecs.length;
  if (positional.length > max) return { error: `Too many arguments (max ${max})` };

  return { values };
}

// "/models:use <name>", "/sh <command>", "/x [--force]"
export function usage(cmd) {
  const a = (cmd.args || []).map(x => (x.required ? `<${x.name}>` : `[${x.name}]`)).join(' ');
  const f = (cmd.flags || [])
    .map(x => `[--${x.name}${x.type === 'boolean' ? '' : ` <${x.type || 'string'}>`}]`)
    .join(' ');
  return [`/${cmd.name}`, a, f].filter(Boolean).join(' ');
}
