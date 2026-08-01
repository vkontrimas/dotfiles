/**
 * Working Status Extension
 *
 * Composes the built-in "Working..." indicator into a single line:
 *
 *   Working... · 5/10 tasks · <live one-sentence summary>
 *
 * The tasks segment reads task state directly from the session branch
 * (replaying add_tasks/complete_task/cancel_task tool results, the same
 * technique `tasks/index.ts`'s own `reconstructTasks` uses) instead of
 * importing the `tasks` extension's module. That import path was tried
 * first (an optionalDependency + `await import("pi-tasks")`, mirroring
 * `plan/index.ts`'s soft-dependency pattern) but doesn't work: pi's
 * extension loader (`core/extensions/loader.js`) creates a fresh jiti
 * instance per extension with `moduleCache: false`, so a sibling
 * extension's dynamic import re-evaluates that module from scratch in an
 * isolated instance — mutations from the real `tasks` extension's tool
 * calls are invisible to it. Reading straight from session entries sidesteps
 * that entirely and needs no npm/symlink setup, so it's also simpler.
 *
 * The summary segment reuses the ephemeral side-channel completion pattern
 * from `seqagent/index.ts`: on the first turn of a run, and every
 * SUMMARY_INTERVAL_TURNS turns after, fire a standalone `complete()` call
 * using the exact message prefix the model just saw (so it reuses whatever
 * prompt cache that prefix already warmed) plus one ephemeral user message
 * asking for a one-sentence status. The result never touches the real
 * session/context — it only ever reaches the UI via `ctx.ui.setWorkingMessage`.
 */
import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUMMARY_INTERVAL_TURNS = 3; // configurable cadence
const SUMMARY_MAX_CHARS = 80;
const SUMMARY_PROMPT =
  "8 words max, fragment (drop articles/\"I\"), no hedging (\"let me\", \"I will\"). " +
  "What are you doing right now?";
function buildKickoffPrompt(requestText: string): string {
  return (
    "8 words max, fragment (drop articles/\"I\"), no hedging, no greeting. " +
    `What does this request ask for?\n\nRequest: "${requestText}"`
  );
}

// Mirrors tasks/index.ts's Task shape and isOpen() just enough to count —
// see that file for the authoritative definition.
interface TaskLike {
  id: string;
  done?: boolean;
  cancelled?: boolean;
}

function isOpen(t: TaskLike): boolean {
  return !t.done && !t.cancelled;
}

// Replays add_tasks/complete_task/cancel_task tool results on the current
// session branch to derive live counts, the same way tasks/index.ts's own
// reconstructTasks() rebuilds its in-memory list on session_start/session_tree.
function getTaskCounts(ctx: ExtensionContext): { total: number; remaining: number } {
  let tasks: TaskLike[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "tasks-cleared") {
      tasks = [];
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult") continue;

    if (msg.toolName === "add_tasks") {
      const details = msg.details as { added?: TaskLike[] } | undefined;
      if (!details?.added) continue;
      tasks = [...tasks, ...details.added];
    } else if (msg.toolName === "complete_task" || msg.toolName === "cancel_task") {
      const details = msg.details as { task?: TaskLike } | undefined;
      if (!details?.task) continue;
      tasks = tasks.map((t) => (t.id === details.task!.id ? details.task! : t));
    }
  }
  return { total: tasks.length, remaining: tasks.filter(isOpen).length };
}

export default function (pi: ExtensionAPI) {
  let lastMessages: Message[] = [];
  let turnsSinceSummary = 0;
  let summarizedOnce = false;
  let currentSummary: string | undefined;

  const buildWorkingMessage = (ctx: ExtensionContext): string => {
    const parts = ["Working..."];
    const counts = getTaskCounts(ctx);
    if (counts.total > 0) {
      const done = counts.total - counts.remaining;
      parts.push(`${done}/${counts.total} tasks`);
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
    ctx.ui.setWorkingMessage(buildWorkingMessage(ctx));
  };

  pi.on("context", (event) => {
    lastMessages = event.messages as Message[];
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
        ...lastMessages,
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

  // Fires once per user prompt, before the real first request goes out — pi
  // awaits before_agent_start handlers before building that request (see
  // agent-session.js), so this stays serialized ahead of it, same as the
  // turn_end summary below. Resetting state here (not a separate agent_start
  // handler) matters: before_agent_start fires before agent_start, so a later
  // reset there would wipe out the kickoff summary this sets.
  pi.on("before_agent_start", async (event, ctx) => {
    turnsSinceSummary = 0;
    summarizedOnce = false;
    currentSummary = undefined;
    await requestSummary(ctx, buildKickoffPrompt(event.prompt));
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
