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
 * from `seqagent/index.ts`: on the first turn of a run, and every
 * SUMMARY_INTERVAL_TURNS turns after, fire a standalone `complete()` call
 * using the exact message prefix the model just saw (so it reuses whatever
 * prompt cache that prefix already warmed) plus one ephemeral user message
 * asking for a one-sentence status. The result never touches the real
 * session/context — it only ever reaches the UI via `ctx.ui.setWorkingMessage`.
 *
 * Two things about that side-channel are easy to get wrong, and both showed up
 * as the same symptom — the summary answering "Waiting for your instructions."
 * during a `/plan` run:
 *
 *   - `context` fires *upstream* of message conversion. pi-agent-core's
 *     documented pipeline is `AgentMessage[] -> transformContext() ->
 *     AgentMessage[] -> convertToLlm() -> Message[] -> LLM`, and the `context`
 *     event is that `transformContext` hook, so `event.messages` still holds
 *     pi-internal roles — `custom`, `bashExecution`, `branchSummary`,
 *     `compactionSummary`. `complete()` takes the post-conversion `Message[]`
 *     and silently drops everything it doesn't recognize. Usually that costs a
 *     message or two; under `/plan` it costs *everything*, because both
 *     messages `/plan` sends (the planning skill and the prompt itself) are
 *     `role: "custom"`. Hence `convertToLlm(lastMessages)` at the call site
 *     rather than a cast.
 *
 *   - `before_agent_start` does not fire for every run. `sendCustomMessage`
 *     with `triggerTurn` goes straight to `_runAgentPrompt`
 *     (agent-session.js:1086) and never calls `emitBeforeAgentStart` — and
 *     that is precisely how `/plan` starts its turn. `agent_start` fires on
 *     both paths, so the run reset lives there, with `kickoffHandled` keeping
 *     the two from fighting over it (before_agent_start runs first and seeds
 *     the kickoff summary, so agent_start must not clear it).
 */
import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUMMARY_INTERVAL_TURNS = 3; // configurable cadence
const SUMMARY_MAX_CHARS = 80;
const SUMMARY_PROMPT =
  "8 words max. High-level only — no low-level details. " +
  "Cold, third-person observation. No conversational text. Fragment.";
function buildKickoffPrompt(requestText: string): string {
  return (
    "8 words max. High-level only — no low-level details. " +
    "Cold, third-person observation. No greeting. Fragment.\n\n" +
    `Request: "${requestText}"`
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
  // Set by before_agent_start, consumed by agent_start — see those handlers.
  let kickoffHandled = false;

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
  };

  // Fires once per *typed* user prompt, before the real first request goes out
  // — pi awaits before_agent_start handlers before building that request (see
  // agent-session.js), so this stays serialized ahead of it, same as the
  // turn_end summary below.
  pi.on("before_agent_start", async (event, ctx) => {
    resetRun();
    kickoffHandled = true;
    await requestSummary(ctx, buildKickoffPrompt(event.prompt));
  });

  // Covers runs before_agent_start never sees: `sendCustomMessage` with
  // `triggerTurn` calls `_runAgentPrompt` directly and skips
  // `emitBeforeAgentStart` entirely (agent-session.js:1086), which is exactly
  // how `/plan` starts its turn. agent_start does fire on both paths, so it's
  // the only place stale state from the *previous* prompt can be cleared —
  // without it the widget kept showing the last typed prompt's summary for the
  // whole plan run.
  //
  // No kickoff summary here: this path carries no prompt text to summarize.
  // The first turn_end fills it in instead (`!summarizedOnce` makes it due),
  // so the plan run shows a bare "Working..." for one turn rather than a
  // wrong one.
  pi.on("agent_start", (_event, ctx) => {
    if (kickoffHandled) {
      kickoffHandled = false; // before_agent_start already reset and seeded this run
      return;
    }
    resetRun();
    refreshWorkingMessage(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    refreshWorkingMessage(ctx); // picks up latest task counts every turn regardless of summary cadence

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
    await requestSummary(ctx, SUMMARY_PROMPT);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingMessage(); // restore default; next run rebuilds fresh
  });
}
