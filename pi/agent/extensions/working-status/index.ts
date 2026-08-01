/**
 * Working Status Extension
 *
 * Composes the built-in "Working..." indicator into a single line:
 *
 *   Working... · 5/10 tasks · <live one-sentence summary>
 *
 * The tasks segment listens on the shared event bus (`pi.events`) for
 * `tasks:updated`, pushed by `tasks/index.ts` whenever its list changes.
 * This is not the same as importing the `tasks` extension's module —
 * that path was tried first (an optionalDependency + `await import("pi-tasks")`,
 * mirroring `plan/index.ts`'s soft-dependency pattern) but doesn't work:
 * pi's extension loader (`core/extensions/loader.js`) creates a fresh jiti
 * instance per extension with `moduleCache: false`, so a sibling extension's
 * dynamic import re-evaluates that module from scratch in an isolated
 * instance — mutations from the real `tasks` extension's tool calls are
 * invisible to it. `pi.events` doesn't have that problem: it's a single bus
 * owned by pi's core runtime and handed to every extension's `pi`, not
 * something each extension's own module recreates.
 *
 * The summary segment reuses the ephemeral side-channel completion pattern
 * from `seqagent/index.ts`: on the first agent turn, and every
 * SUMMARY_INTERVAL_TURNS turns after, fire a standalone `complete()` call
 * using the exact message prefix the model just saw (so it reuses whatever
 * prompt cache that prefix already warmed) plus one ephemeral user message
 * asking for a one-sentence status. The result never touches the real
 * session/context — it only ever reaches the UI via `ctx.ui.setWorkingMessage`.
 *
 * `context` fires *upstream* of message conversion. pi-agent-core's
 * documented pipeline is `AgentMessage[] -> transformContext() ->
 * AgentMessage[] -> convertToLlm() -> Message[] -> LLM`, and the `context`
 * event is that `transformContext` hook, so `event.messages` still holds
 * pi-internal roles — `custom`, `bashExecution`, `branchSummary`,
 * `compactionSummary`. `complete()` takes the post-conversion `Message[]`
 * and silently drops everything it doesn't recognize. Usually that costs a
 * message or two; under `/plan` it costs *everything*, because both
 * messages `/plan` sends (the planning skill and the prompt itself) are
 * `role: "custom"`. Hence `convertToLlm(lastMessages)` at the call site
 * rather than a cast.
 */
import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUMMARY_INTERVAL_TURNS = 3; // configurable cadence
const SUMMARY_MAX_CHARS = 80;
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
function buildSummaryPrompt(lastSummary: string | undefined): string {
  if (!lastSummary) return SUMMARY_PROMPT_BASE;
  return (
    SUMMARY_PROMPT_BASE +
    `\n\nYour previous summary was: "${lastSummary}". If still working on the same task, repeat it verbatim. Only write a new summary if the task has genuinely changed.`
  );
}

interface TaskCounts {
  total: number;
  remaining: number;
}

export default function (pi: ExtensionAPI) {
  // AgentMessage[], not Message[] — the `context` event fires upstream of
  // convertToLlm (see the header comment). Typed off convertToLlm's own
  // parameter so the distinction can't drift.
  let lastMessages: Parameters<typeof convertToLlm>[0] = [];
  let turnsSinceSummary = 0;
  let summarizedOnce = false;
  let currentSummary: string | undefined;
  let taskCounts: TaskCounts = { total: 0, remaining: 0 };
  let agentEnded = false;

  pi.events.on("tasks:updated", (data) => {
    taskCounts = data as TaskCounts;
  });

  const buildWorkingMessage = (): string => {
    const parts = ["Working..."];
    if (taskCounts.total > 0) {
      const done = taskCounts.total - taskCounts.remaining;
      parts.push(`${done}/${taskCounts.total} tasks`);
    }
    if (currentSummary) {
      const summary = currentSummary.length > SUMMARY_MAX_CHARS
        ? currentSummary.slice(0, SUMMARY_MAX_CHARS) + "…"
        : currentSummary;
      parts.push(summary);
    }
    return parts.join(" · ");
  };

  const refreshWorkingMessage = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    // Fold the tasks extension's own separate footer readout into this line instead.
    ctx.ui.setStatus("tasks", undefined);
    ctx.ui.setWorkingMessage(buildWorkingMessage());
  };

  pi.on("context", (event) => {
    lastMessages = event.messages;
  });

  const requestSummary = async (ctx: ExtensionContext, promptText: string) => {
    try {
      const model = ctx.model;
      if (!model) return;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return;

      const activeNames = new Set(pi.getActiveTools());
      const tools = pi.getAllTools()
        .filter((t) => activeNames.has(t.name))
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

      const messages: Message[] = [
        ...convertToLlm(lastMessages),
        { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() },
      ];

      const response = await complete(
        model,
        { systemPrompt: ctx.getSystemPrompt(), messages, tools },
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, reasoning: "off", maxTokens: 32, signal: ctx.signal },
      );

      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(" ")
        .trim();

      if (text) {
        currentSummary = text;
        refreshWorkingMessage(ctx);
      }
    } catch {
      // best-effort; never disrupt the real turn
    }
  };

  const resetRun = () => {
    turnsSinceSummary = 0;
    summarizedOnce = false;
    currentSummary = undefined;
    agentEnded = false;
  };

  // Reset state at the start of every agent run. The first summary fires on the
  // first turn_end (`!summarizedOnce` makes it due), so the status line shows
  // a bare "Working..." for one turn while the first agent turn runs.
  pi.on("agent_start", (_event, ctx) => {
    resetRun();
    refreshWorkingMessage(ctx);
  });

  pi.on("agent_end", () => {
    agentEnded = true;
  });

  pi.on("turn_end", async (_event, ctx) => {
    refreshWorkingMessage(ctx); // picks up latest task counts every turn regardless of summary cadence
    if (agentEnded) return;

    turnsSinceSummary++;
    const due = !summarizedOnce || turnsSinceSummary >= SUMMARY_INTERVAL_TURNS;
    if (!due) return;
    turnsSinceSummary = 0;
    summarizedOnce = true;
    // Awaited (not fire-and-forget): pi awaits turn_end handlers before the
    // next turn's request goes out, so this guarantees the summary call
    // never overlaps with a real generation request. The local llama.cpp
    // backend runs a single inference slot (-np 1) and doesn't tolerate
    // concurrent connections cleanly — overlapping requests were observed
    // causing intermittent "write: broken pipe" 500s from bifrost (stale
    // pooled connection reused while the slot was mid-generation).
    await requestSummary(ctx, buildSummaryPrompt(currentSummary));
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingMessage(); // restore default; next run rebuilds fresh
  });
}
