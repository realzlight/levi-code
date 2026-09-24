import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_BASE_URLS } from '../commands/models.js';

const h = React.createElement;
const CYAN = '#22d3ee';
const SOFT = '#c4c4c4';
const GRAY = '#666666';
const SDKS = ['openai', 'anthropic'];
const CONFIG_PATH = path.join(os.homedir(), '.levi', 'config.json');

const read = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const write = (c) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));

export default function ModelForm({ mode, name, onDone }) {
  const edit = mode === 'edit';
  const [config] = useState(read);
  const cur = (edit && config.models?.[name]) || {};

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [text, setText] = useState('');
  const [sel, setSel] = useState(Math.max(0, SDKS.indexOf(cur.sdk)));
  const [error, setError] = useState('');

  const sdkNow = answers.sdk || cur.sdk || 'openai';
  const fields = [
    { key: 'name', label: 'Name', hint: edit ? name : 'Astra', required: !edit },
    { key: 'sdk', label: 'SDK', select: true },
    { key: 'api_key', label: 'API key', secret: true, hint: edit ? 'keep current' : '', required: !edit },
    { key: 'model', label: 'Model', hint: edit ? cur.model : sdkNow === 'anthropic' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o', required: !edit },
    { key: 'base_url', label: 'Base URL', hint: edit ? cur.base_url : DEFAULT_BASE_URLS[sdkNow] }
  ];
  const f = fields[step];
  const last = step === fields.length - 1;

  const taken = (n) =>
    Object.keys(config.models || {}).some((k) => k !== name && k.toLowerCase() === n.toLowerCase());

  const save = (a) => {
    const c = read();
    c.models = c.models || {};
    if (!edit) {
      c.models[a.name] = { sdk: a.sdk, api_key: a.api_key, model: a.model, base_url: a.base_url || DEFAULT_BASE_URLS[a.sdk] };
    } else {
      const old = c.models[name] || {};
      const finalName = a.name || name;
      const updated = {
        sdk: a.sdk,
        api_key: a.api_key || old.api_key,
        model: a.model || old.model,
        base_url: a.base_url || (a.sdk !== old.sdk ? DEFAULT_BASE_URLS[a.sdk] : old.base_url)
      };
      if (finalName !== name) {
        delete c.models[name];
        if (c.active_model === name) c.active_model = finalName;
      }
      c.models[finalName] = updated;
    }
    write(c);
    onDone();
  };

  const advance = () => {
    const value = f.select ? SDKS[sel] : text.trim();
    if (!value && f.required) return setError(`${f.label} required`);
    if (f.key === 'name' && value && taken(value)) return setError(`"${value}" already exists`);
    const next = { ...answers, [f.key]: value };
    if (last) return save(next);
    setAnswers(next);
    setStep(step + 1);
    setText('');
    setError('');
  };

  useInput((input, key) => {
    if (key.escape) return onDone();
    if (key.return) return advance();
    if (f.select) {
      if (key.leftArrow || key.upArrow) setSel((sel + SDKS.length - 1) % SDKS.length);
      else if (key.rightArrow || key.downArrow || key.tab) setSel((sel + 1) % SDKS.length);
      return;
    }
    if (key.backspace || key.delete) { setText(text.slice(0, -1)); setError(''); return; }
    if (input && !key.ctrl && !key.meta) { setText(text + input); setError(''); }
  });

  const shown = f.secret ? '•'.repeat(text.length) : text;
  const keep = edit && !f.select ? ' · empty = keep' : '';

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null,
      h(Text, { color: CYAN, bold: true }, edit ? `Edit ${name}` : 'New model'),
      h(Text, { color: GRAY }, `  ${step + 1}/${fields.length}`)
    ),
    h(Box, null,
      h(Text, { color: CYAN }, '❯ '),
      h(Text, { color: SOFT }, `${f.label}: `),
      f.select
        ? h(Text, { color: CYAN }, SDKS.map((s, i) => `${i === sel ? '●' : '○'} ${s}`).join('   '))
        : h(Text, { color: 'white' }, shown),
      f.select ? null : h(Text, { inverse: true }, ' '),
      !f.select && !text && f.hint ? h(Text, { color: GRAY }, ` ${f.hint}`) : null
    ),
    error
      ? h(Text, { color: 'red' }, error)
      : h(Text, { color: GRAY }, `${f.select ? '←→ choose · ' : ''}enter ${last ? 'save' : 'next'} · esc cancel${keep}`)
  );
}
