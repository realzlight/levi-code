import { chat } from './client.js';
import { recordUsage } from './usage.js';

// constant string on purpose: identical prefix every call, so it stays cacheable
const ROUTER_SYSTEM = `Route a message for a coding assistant. Output ONLY JSON: {"route":"conversation"|"agent","insight":"max 15 words"}
agent = needs tools or multi-step work: coding, files, bash/git, browser, MCP, research needing tools, planning, tasks, sub-agents, refers to a past conversation, or continues agent work (e.g. "yes", "the second one" when last_route is agent).
conversation = casual chat, general questions, explanations, short follow-ups that need no tools.
When unsure, choose agent.`;

const GREETING = /^(hi+|hey+|yo|hello|sup|thanks|thank you|thx|ty|cool|nice|lol|gm|gn|bye)[\s!.?]*$/i;
const FILE_HINT = /(```|~\/|\.\/|\bsrc\/|\b[\w-]+\.(js|jsx|ts|tsx|py|json|md|sh|css|html|yml|yaml|toml|env)\b)/i;

let lastRoute = 'conversation';

export function resetRouter() {
  lastRoute = 'conversation';
}

async function classify(query, recent, sessionId) {
  const prompt = `last_route: ${lastRoute}
recent user messages:
${recent.length ? recent.map((m) => `- ${m}`).join('\n') : '(none)'}
current: ${query.slice(0, 600)}`;
  try {
    const res = await chat([{ role: 'user', content: prompt }], { system: ROUTER_SYSTEM });
    if (sessionId) recordUsage(sessionId, res.usage);
    const data = JSON.parse(res.text.trim().replace(/^```json\s*|```\s*$/g, ''));
    return {
      route: data.route === 'conversation' ? 'conversation' : 'agent',
      insight: String(data.insight || '').slice(0, 120)
    };
  } catch {
    return { route: 'agent', insight: 'router failed, defaulting to agent' };
  }
}

// recentUser = last user messages only (no AI replies), excluding the current one
export async function route(query, { recentUser = [], forceAgent = false, sessionId } = {}) {
  const q = query.trim();
  const recent = recentUser.slice(-3).map((m) => String(m).slice(0, 300));

  let r;
  if (forceAgent) r = { route: 'agent', insight: 'agent mode forced' };
  else if (GREETING.test(q)) r = { route: 'conversation', insight: 'greeting or thanks' };
  else if (FILE_HINT.test(q)) r = { route: 'agent', insight: 'mentions code or file paths' };
  else r = await classify(q, recent, sessionId);

  lastRoute = r.route;
  return { route: r.route, query: q, recentMessages: recent, insight: r.insight };
}
