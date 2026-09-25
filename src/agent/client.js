import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_PATH = path.join(os.homedir(), '.levi', 'config.json');

export function activeModel() {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const m = c.models?.[c.active_model];
  if (!m) throw new Error('No active model. Use /models:create then /models:use <name>');
  return m;
}

// messages = [{ role: 'user' | 'assistant', content: string }]
// returns { text, raw }
export async function chat(messages, { system, maxTokens = 1024 } = {}) {
  const m = activeModel();
  const base = m.base_url.replace(/\/$/, '');

  if (m.sdk === 'anthropic') {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': m.api_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: m.model,
        max_tokens: maxTokens,
        system,
        messages
      })
    }).then((r) => r.json());

    if (res.error) throw new Error(res.error.message || 'Anthropic API error');
    const text = res.content?.find((b) => b.type === 'text')?.text || '';
    return { text, raw: res };
  }

  // openai-compatible (openai, groq, gemini-openai, nvidia, ollama, ...)
  const payload = {
    model: m.model,
    max_tokens: maxTokens,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages
  };

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.api_key}` },
    body: JSON.stringify(payload)
  }).then((r) => r.json());

  if (res.error) throw new Error(res.error.message || 'OpenAI-compatible API error');
  const text = res.choices?.[0]?.message?.content || '';
  return { text, raw: res };
}

// same as chat(), but supports tools. Returns { text, toolCalls, raw }
// toolCalls: [{ id, name, args }] — empty if the model just answered
export async function chatWithTools(messages, { system, tools = [], maxTokens = 2048 } = {}) {
  const m = activeModel();
  const base = m.base_url.replace(/\/$/, '');

  if (m.sdk === 'anthropic') {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': m.api_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: m.model,
        max_tokens: maxTokens,
        system,
        messages,
        tools: tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters
        }))
      })
    }).then((r) => r.json());

    if (res.error) throw new Error(res.error.message || 'Anthropic API error');

    const text = res.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || '';
    const toolCalls = (res.content || [])
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));

    return { text, toolCalls, message: { role: 'assistant', content: text }, raw: res };
  }

  const payload = {
    model: m.model,
    max_tokens: maxTokens,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    tools: tools.length ? tools : undefined
  };

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.api_key}` },
    body: JSON.stringify(payload)
  }).then((r) => r.json());

  if (res.error) throw new Error(res.error.message || 'OpenAI-compatible API error');

  const msg = res.choices?.[0]?.message || {};
  const text = msg.content || '';
  const toolCalls = (msg.tool_calls || []).map((c) => ({
    id: c.id,
    name: c.function.name,
    args: JSON.parse(c.function.arguments || '{}')
  }));

  return { text, toolCalls, message: msg, raw: res };
}
