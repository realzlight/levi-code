import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function activeModelConfig() {
  const file = path.join(os.homedir(), '.levi', 'config.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return c.models?.[c.active_model];
}

// short, cheap call — plain text back, no tools
export async function generateTitle(message) {
  const m = activeModelConfig();
  if (!m) return message.slice(0, 40);

  try {
    const res = await fetch(`${m.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.api_key}` },
      body: JSON.stringify({
        model: m.model,
        max_tokens: 20,
        messages: [
          { role: 'system', content: 'Reply with a 3-6 word title for this request. No quotes, no punctuation at the end. Never so big' },
          { role: 'user', content: message }
        ]
      })
    }).then((r) => r.json());

    const text = res.choices?.[0]?.message?.content?.trim();
    return text || message.slice(0, 40);
  } catch {
    return message.slice(0, 40);
  }
}
