import { chatWithTools } from './client.js';
import { toolDefs, runTool } from './tools.js';
import { getCustomAgent, sanitizeAgentName } from './custom-agents.js';

// Sub-agents have full tool access to complete their assigned goal autonomously.
// Recursive orchestration (spawn_subagent, message_subagent, list_subagents) and interactive ask are excluded.
const EXCLUDED_SUB_TOOLS = new Set(['spawn_subagent', 'message_subagent', 'list_subagents', 'ask']);

function getSubAgentToolDefs() {
  return toolDefs.filter((t) => !EXCLUDED_SUB_TOOLS.has(t.function.name));
}

function buildSubAgentSystem(role, originalTask) {
  const cleanRole = sanitizeAgentName(role);
  const custom = getCustomAgent(cleanRole);

  if (custom && custom.systemPrompt) {
    return `${custom.systemPrompt}

You are working under lead orchestrator Levi. You have full tool access.
Your assigned goal:
${originalTask}

You are fully autonomous: complete the work using your tools, do not stop to ask questions, and when finished (or if you get stuck), reply with a concise, factual report of what you did, what changed, and the result for Levi.`;
  }

  return `You are a sub-agent named "${cleanRole || role}", working under lead orchestrator Levi. You were given this assigned goal:
${originalTask}

You do concrete work autonomously with full tool access, then report back — you do not plan for the lead agent, do not manage session tasks, do not ask the user anything, and do not look for context beyond your assigned goal.

Use your tools as needed to complete whatever you're asked. If something is ambiguous, make the most reasonable decision yourself and note that assumption in your report — do not stop to ask. When finished (or if you get stuck), reply with a plain text report: what you did, what changed, and the result. Be concise and factual, this report goes to your lead orchestrator (Levi), not the end user directly.`;
}

// Runs a sub-agent on one instruction. Pass existingMessages to continue a
// prior sub-agent's own thread (a follow-up), or omit it to start fresh.
// Returns { report, messages } — messages is the full thread so far, meant
// to be persisted by the caller and passed back in for any later follow-up.
export async function runSubAgent(role, instruction, { maxSteps = 15, existingMessages = null, onStep = null } = {}) {
  const originalTask = existingMessages && existingMessages.length ? existingMessages[0].content : instruction;
  const system = buildSubAgentSystem(role, originalTask);

  const messages = existingMessages
    ? [...existingMessages, { role: 'user', content: instruction }]
    : [{ role: 'user', content: instruction }];

  const usage = { inputTokens: 0, outputTokens: 0 };
  onStep?.('subagent_start', { role, task: instruction });

  for (let step = 0; step < maxSteps; step++) {
    onStep?.('subagent_progress', { role, status: `step ${step + 1}/${maxSteps}`, action: 'thinking...', task: instruction });
    const { text, toolCalls, message, usage: stepUsage } = await chatWithTools(messages, { system, tools: getSubAgentToolDefs() });
    usage.inputTokens += stepUsage?.inputTokens || 0;
    usage.outputTokens += stepUsage?.outputTokens || 0;

    if (!toolCalls.length) {
      if (!text || !text.trim()) {
        if (step < maxSteps - 1) {
          messages.push(message);
          messages.push({ role: 'user', content: '(that came back empty — give an actual report of what you did, or what you got stuck on.)' });
          continue;
        }
        const report = `[${role}] Ran out of steps without producing a clear report. Last state unknown — may need manual follow-up.`;
        onStep?.('subagent_done', { role });
        return { report, messages, usage };
      }
      messages.push(message);
      onStep?.('subagent_done', { role });
      return { report: text, messages, usage };
    }

    messages.push(message);

    for (const call of toolCalls) {
      const actionName = `${call.name} ${call.args?.path || call.args?.command || ''}`.trim().slice(0, 45);
      onStep?.('subagent_progress', { role, status: `step ${step + 1}/${maxSteps}`, action: actionName, task: instruction });
      const result = await runTool(call.name, call.args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }

  onStep?.('subagent_done', { role });
  const report = `[${role}] Hit the step limit (${maxSteps}) before finishing. Work may be partially done — check the files directly.`;
  return { report, messages, usage };
}
