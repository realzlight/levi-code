import { chatWithTools } from './client.js';
import { toolDefs, runTool } from './tools.js';

// Sub-agents get a strictly limited tool set — no memory tools, no task
// management, no ask, no set_project. They're given a concrete instruction
// and do exactly that, nothing more. They report back in plain text; they
// don't retrieve their own context or make planning decisions.
const ALLOWED_TOOL_NAMES = new Set(['read_file', 'write_file', 'edit_file', 'bash']);
// computed lazily (inside the function, not at module load) to avoid a
// circular-import init-order issue with tools.js, which imports this file
function getSubAgentToolDefs() {
  return toolDefs.filter((t) => ALLOWED_TOOL_NAMES.has(t.function.name));
}

function buildSubAgentSystem(role, originalTask) {
  return `You are a sub-agent named "${role}", working under a lead agent (Levi). You were given this original task:
${originalTask}

You do concrete work, then report back — you do not plan, do not manage tasks, do not ask the user anything, and do not look for your own context beyond what you're given. You may receive follow-up instructions from your lead agent after your initial report — treat those the same way, as direct, concrete asks to act on.

Use read_file/write_file/edit_file/bash as needed to actually complete whatever you're asked. If something is ambiguous, make the most reasonable decision yourself and note that assumption in your report — do not stop to ask, there's no one to ask. When finished (or if you get stuck), reply with a plain text report: what you did, what changed, and the result. Be concise and factual, this report goes to your lead agent, not the end user directly.`;
}

// Runs a sub-agent on one instruction. Pass existingMessages to continue a
// prior sub-agent's own thread (a follow-up), or omit it to start fresh.
// Returns { report, messages } — messages is the full thread so far, meant
// to be persisted by the caller and passed back in for any later follow-up.
export async function runSubAgent(role, instruction, { maxSteps = 15, existingMessages = null } = {}) {
  const originalTask = existingMessages && existingMessages.length ? existingMessages[0].content : instruction;
  const system = buildSubAgentSystem(role, originalTask);

  const messages = existingMessages
    ? [...existingMessages, { role: 'user', content: instruction }]
    : [{ role: 'user', content: instruction }];

  for (let step = 0; step < maxSteps; step++) {
    const { text, toolCalls, message } = await chatWithTools(messages, { system, tools: getSubAgentToolDefs() });

    if (!toolCalls.length) {
      if (!text || !text.trim()) {
        if (step < maxSteps - 1) {
          messages.push(message);
          messages.push({ role: 'user', content: '(that came back empty — give an actual report of what you did, or what you got stuck on.)' });
          continue;
        }
        const report = `[${role}] Ran out of steps without producing a clear report. Last state unknown — may need manual follow-up.`;
        return { report, messages };
      }
      messages.push(message);
      return { report: text, messages };
    }

    messages.push(message);

    for (const call of toolCalls) {
      const result = await runTool(call.name, call.args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }

  const report = `[${role}] Hit the step limit (${maxSteps}) before finishing. Work may be partially done — check the files directly.`;
  return { report, messages };
}
