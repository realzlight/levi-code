import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getEffort, setEffort, EFFORT_LIST } from '../agent/effort.js';
import { isSoloOnly, setSoloOnly, isDiaryEnabled, setDiaryEnabled } from '../agent/session.js';

const h = React.createElement;
const CYAN = '#afd7ff';
const SOFT = '#c4c4c4';
const GRAY = '#777777';
const GOLD = '#ffd700';
const GREEN = '#4ade80';
const RED = '#f87171';

const CONFIG_PATH = path.join(os.homedir(), '.levi', 'config.json');
const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
};
const writeConfig = (c) => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
};

export default function ConfigForm({ onDone, onCancel }) {
  const [config, setConfig] = useState(readConfig);
  const [effort, setEffortState] = useState(() => getEffort());
  const [solo, setSoloState] = useState(() => isSoloOnly());
  const [diary, setDiaryState] = useState(() => isDiaryEnabled());

  const modelsList = Object.keys(config.models || {});
  const initialModel = config.active_model || (modelsList.length ? modelsList[0] : 'default');
  const [activeModel, setActiveModel] = useState(initialModel);
  const [userName, setUserName] = useState(config?.auth?.user?.name || '');
  const [editor, setEditor] = useState(() => config?.editor || process.env.EDITOR || 'nano');

  // Row selection
  const [sel, setSel] = useState(0);
  // In-line editing state for text inputs ('alias' | 'editor')
  const [isEditing, setIsEditing] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [editText, setEditText] = useState('');

  const EDITOR_PRESETS = ['nano', 'vim', 'nvim', 'micro', 'hx', 'emacs'];

  const ITEMS = [
    { id: 'alias', label: 'Alias / Name', type: 'text', value: userName || '(none)' },
    { id: 'editor', label: 'Terminal Editor', type: 'cycle', value: editor },
    { id: 'effort', label: 'Effort Level', type: 'cycle', value: effort.label },
    { id: 'model', label: 'Active Model', type: 'cycle', value: activeModel },
    { id: 'subagents', label: 'Sub-agents', type: 'toggle', value: solo ? 'OFF (Solo only)' : 'ON (Enabled)' },
    { id: 'diary', label: 'Session Diary', type: 'toggle', value: diary ? 'ON' : 'OFF' },
    { id: 'save', label: '[ Save & Close ]', type: 'action' }
  ];

  const cycleEditor = (delta) => {
    const idx = EDITOR_PRESETS.indexOf(editor);
    if (idx === -1) {
      setEditor(delta > 0 ? EDITOR_PRESETS[0] : EDITOR_PRESETS[EDITOR_PRESETS.length - 1]);
    } else {
      const nextIdx = (idx + delta + EDITOR_PRESETS.length) % EDITOR_PRESETS.length;
      setEditor(EDITOR_PRESETS[nextIdx]);
    }
  };

  const cycleEffort = (delta) => {
    const idx = EFFORT_LIST.findIndex((e) => e.id === effort.id);
    const nextIdx = (idx + delta + EFFORT_LIST.length) % EFFORT_LIST.length;
    const next = EFFORT_LIST[nextIdx];
    setEffort(next.id);
    setEffortState(next);
  };

  const cycleModel = (delta) => {
    if (!modelsList.length) return;
    const idx = Math.max(0, modelsList.indexOf(activeModel));
    const nextIdx = (idx + delta + modelsList.length) % modelsList.length;
    const next = modelsList[nextIdx];
    setActiveModel(next);
    const c = readConfig();
    c.active_model = next;
    writeConfig(c);
  };

  const toggleSubagents = () => {
    const next = !solo;
    setSoloOnly(next);
    setSoloState(next);
  };

  const toggleDiary = () => {
    const next = !diary;
    setDiaryEnabled(next);
    setDiaryState(next);
  };

  const saveAllAndExit = () => {
    const c = readConfig();
    if (!c.auth) c.auth = {};
    if (!c.auth.user) c.auth.user = {};
    c.auth.user.name = userName.trim();
    c.editor = editor.trim();
    c.active_model = activeModel;
    c.soloOnly = solo;
    c.diaryEnabled = diary;
    c.effort = effort.id;
    writeConfig(c);

    onDone?.({
      effort,
      message: 'Settings updated successfully',
      fields: [
        { label: 'Alias', value: userName.trim() || 'default', color: CYAN },
        { label: 'Editor', value: editor.trim() || 'nano', color: CYAN },
        { label: 'Effort', value: effort.label, color: GOLD },
        { label: 'Model', value: activeModel, color: CYAN },
        { label: 'Sub-agents', value: solo ? 'OFF' : 'ON', color: solo ? RED : GREEN },
        { label: 'Diary', value: diary ? 'ON' : 'OFF', color: diary ? GREEN : RED }
      ]
    });
  };

  useInput((input, key) => {
    if (isEditing) {
      if (key.escape) {
        setIsEditing(false);
        setEditingField(null);
        return;
      }
      if (key.return) {
        if (editingField === 'alias') {
          setUserName(editText);
          const c = readConfig();
          if (!c.auth) c.auth = {};
          if (!c.auth.user) c.auth.user = {};
          c.auth.user.name = editText.trim();
          writeConfig(c);
        } else if (editingField === 'editor') {
          const cleanEd = editText.trim() || 'nano';
          setEditor(cleanEd);
          const c = readConfig();
          c.editor = cleanEd;
          writeConfig(c);
        }
        setIsEditing(false);
        setEditingField(null);
        return;
      }
      if (key.backspace || key.delete) {
        setEditText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setEditText((t) => t + input);
      }
      return;
    }

    if (key.escape) return onCancel?.();
    if (key.upArrow) return setSel((s) => (s - 1 + ITEMS.length) % ITEMS.length);
    if (key.downArrow) return setSel((s) => (s + 1) % ITEMS.length);

    const curItem = ITEMS[sel];
    if (key.leftArrow) {
      if (curItem.id === 'editor') cycleEditor(-1);
      if (curItem.id === 'effort') cycleEffort(-1);
      if (curItem.id === 'model') cycleModel(-1);
      if (curItem.id === 'subagents') toggleSubagents();
      if (curItem.id === 'diary') toggleDiary();
      return;
    }
    if (key.rightArrow || input === ' ') {
      if (curItem.id === 'editor') cycleEditor(1);
      if (curItem.id === 'effort') cycleEffort(1);
      if (curItem.id === 'model') cycleModel(1);
      if (curItem.id === 'subagents') toggleSubagents();
      if (curItem.id === 'diary') toggleDiary();
      return;
    }
    if (key.return) {
      if (curItem.id === 'alias') {
        setEditText(userName);
        setEditingField('alias');
        setIsEditing(true);
        return;
      }
      if (curItem.id === 'editor') {
        setEditText(editor);
        setEditingField('editor');
        setIsEditing(true);
        return;
      }
      if (curItem.id === 'effort') return cycleEffort(1);
      if (curItem.id === 'model') return cycleModel(1);
      if (curItem.id === 'subagents') return toggleSubagents();
      if (curItem.id === 'diary') return toggleDiary();
      if (curItem.id === 'save') return saveAllAndExit();
    }
  });

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: CYAN, paddingX: 1 },
    h(Box, { justifyContent: 'space-between', marginBottom: 1, height: 1, overflow: 'hidden' },
      h(Text, { color: CYAN, bold: true }, '✦ LEVI CONFIGURATION & SETTINGS'),
      h(Text, { color: GRAY }, `[effort: ${effort.name} · model: ${activeModel}]`)
    ),
    ITEMS.map((item, idx) => {
      const isSel = idx === sel;
      const marker = isSel ? '❯ ' : '  ';

      if (item.id === 'alias' && isEditing && editingField === 'alias') {
        return h(
          Box,
          { key: item.id, height: 1, overflow: 'hidden' },
          h(Text, { color: CYAN }, marker),
          h(Text, { color: CYAN, bold: true }, 'Alias: '),
          h(Text, { color: '#ffffff', backgroundColor: '#333333' }, editText + '█'),
          h(Text, { color: GRAY }, '  (enter to save, esc to cancel)')
        );
      }

      if (item.id === 'editor' && isEditing && editingField === 'editor') {
        return h(
          Box,
          { key: item.id, height: 1, overflow: 'hidden' },
          h(Text, { color: CYAN }, marker),
          h(Text, { color: CYAN, bold: true }, 'Editor: '.padEnd(20)),
          h(Text, { color: '#ffffff', backgroundColor: '#333333' }, editText + '█'),
          h(Text, { color: GRAY }, '  (enter to save custom cmd, esc to cancel)')
        );
      }

      let valColor = SOFT;
      if (item.id === 'editor') valColor = CYAN;
      if (item.id === 'effort') valColor = GOLD;
      if (item.id === 'model') valColor = CYAN;
      if (item.id === 'subagents') valColor = solo ? RED : GREEN;
      if (item.id === 'diary') valColor = diary ? GREEN : RED;
      if (item.id === 'save') valColor = isSel ? CYAN : SOFT;

      return h(
        Box,
        { key: item.id, height: 1, overflow: 'hidden' },
        h(Text, { color: isSel ? CYAN : GRAY }, marker),
        h(Text, { color: isSel ? '#ffffff' : SOFT, bold: isSel }, item.label.padEnd(20)),
        h(Text, { color: valColor, bold: isSel }, item.type === 'cycle' ? `< ${item.value} >` : item.value)
      );
    }),
    h(Box, { marginTop: 1, height: 1, overflow: 'hidden' },
      h(Text, { color: GRAY }, '↑↓ navigate · ←→ cycle · space/enter edit · esc cancel')
    )
  );
}
