/**
 * Shared "what am I doing" status-summary helper.
 *
 * Used by working-status/index.ts (main session) and seqagent/index.ts
 * (subagent side-channel) — both poll the model on the same turn cadence
 * with the same low-cost prompt for a one-line status. This holds the parts
 * that don't differ: the prompt text (including folding the previous
 * summary in so repeated polls of the same task converge on stable wording
 * instead of rephrasing every cadence tick) and the standalone ephemeral
 * complete() call itself.
 *
 * Plain relative import rather than a declared package dependency (the
 * `pi-tasks`-style `file:../tasks` + `await import()` pattern used
 * elsewhere): pi's extension loader gives each extension its own jiti
 * instance with `moduleCache: false`, so that pattern can't share *live
 * state* across extensions (see working-status/index.ts's header comment).
 * This module is stateless — every export is a pure function — so each
 * extension re-evaluating its own copy is harmless, and a relative import
 * skips the node_modules/package.json bookkeeping entirely.
 */
import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SUMMARY_INTERVAL_TURNS = 3; // configurable cadence

const SUMMARY_PROMPT_BASE =
  "Write a 5 or less word high-level summary describing what you are currently doing. Only state *what* you are doing, not why, how, describing the problem itself.\n\n" +
  "Output a cold, third-person perspective fragment. High-level only — no low-level details.\n\n" +
  "No first-person (I, we, my, our). No conversational text — no 'Let me', 'That's odd', 'Success!', 'Let's see', 'I need to'. No greetings.\n\n" +
  "Bad: 'I found the config file and am checking it'\n" +
  "Good: 'Config file located, verifying settings'\n" +
  "Bad: 'Let me look into why the program is segfaulting'\n" +
  "Good: 'Investigating segfault'\n" +
  "Bad: 'It looks like bc_rescan_target_files and foo_bar are not exported'\n" +
  "Good: 'Investigating missing functions'\n" +
  "Bad: 'Now let me look at the remaining critical areas - how the 'complicated_function' handles some operation.'\n" +
  "Good: 'Investigating remaining critical areas.'";

// Folds the previous summary in so that repeated polls of the same task
// converge on identical wording instead of rephrasing it every cadence tick
// (e.g. "Investigating segfault" vs "Debugging crash" for the same work).
export function buildSummaryPrompt(lastSummary: string | undefined): string {
  if (!lastSummary) return SUMMARY_PROMPT_BASE;
  return (
    SUMMARY_PROMPT_BASE +
    `\n\nYour previous summary was: "${lastSummary}". If still working on the same task, repeat it verbatim. Only write a new summary if the task has genuinely changed.`
  );
}

// Fires a standalone, ephemeral complete() call using the messages the model
// just saw plus one user message asking for the status line. Best-effort:
// never throws — returns undefined on any failure so callers can no-op.
export async function requestSummaryText(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  priorMessages: Message[],
  promptText: string,
): Promise<string | undefined> {
  try {
    const model = ctx.model;
    if (!model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return undefined;

    const activeNames = new Set(pi.getActiveTools());
    const tools = pi.getAllTools()
      .filter((t) => activeNames.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

    const messages: Message[] = [
      ...priorMessages,
      { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() },
    ];

    const response = await complete(
      model,
      { systemPrompt: ctx.getSystemPrompt(), messages, tools },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, reasoning: "off", maxTokens: 32, signal: ctx.signal },
    );

    return response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(" ")
      .trim() || undefined;
  } catch {
    return undefined;
  }
}
