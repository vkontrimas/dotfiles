/**
 * Working Status Extension
 *
 * Composes the built-in "Working..." indicator into a single line:
 *
 *   Working... · 5/10 tasks · <live one-sentence summary>
 *
 * The tasks segment is a soft dependency on the `tasks` extension (same
 * pattern as `plan/index.ts`): folds its separate "tasks N/M" footer status
 * into this line instead, so it no longer renders as its own line.
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

let tasksApi: typeof import("pi-tasks") | null = null;
try {
  tasksApi = await import("pi-tasks");
} catch {
  tasksApi = null;
}

const SUMMARY_INTERVAL_TURNS = 4; // configurable cadence
const SUMMARY_PROMPT =
  "In one short sentence, summarize what you are currently doing or just accomplished, " +
  "for a live progress display. Respond with only that sentence, no preamble or markdown.";

export default function (pi: ExtensionAPI) {
  let lastMessages: Message[] = [];
  let turnsSinceSummary = 0;
  let summarizedOnce = false;
  let inFlight = false;
  let currentSummary: string | undefined;

  const buildWorkingMessage = (): string => {
    const parts = ["Working..."];
    const counts = tasksApi?.getTaskCounts();
    if (counts && counts.total > 0) {
      const done = counts.total - counts.remaining;
      parts.push(`${done}/${counts.total} tasks`);
    }
    if (currentSummary) parts.push(currentSummary);
    return parts.join(" · ");
  };

  const refreshWorkingMessage = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    // Fold the tasks extension's own separate footer readout into this line instead.
    if (tasksApi) ctx.ui.setStatus("tasks", undefined);
    ctx.ui.setWorkingMessage(buildWorkingMessage());
  };

  pi.on("context", (event) => {
    lastMessages = event.messages as Message[];
  });

  pi.on("agent_start", () => {
    turnsSinceSummary = 0;
    summarizedOnce = false;
    currentSummary = undefined;
  });

  const requestSummary = async (ctx: ExtensionContext) => {
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
        { role: "user", content: [{ type: "text", text: SUMMARY_PROMPT }], timestamp: Date.now() },
      ];

      const response = await complete(
        model,
        { systemPrompt: ctx.getSystemPrompt(), messages, tools },
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, reasoning: "off", maxTokens: 60, signal: ctx.signal },
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

  pi.on("turn_end", (_event, ctx) => {
    refreshWorkingMessage(ctx); // picks up latest task counts every turn regardless of summary cadence

    turnsSinceSummary++;
    const due = !summarizedOnce || turnsSinceSummary >= SUMMARY_INTERVAL_TURNS;
    if (!due || inFlight) return;
    turnsSinceSummary = 0;
    summarizedOnce = true;
    inFlight = true;
    requestSummary(ctx).finally(() => { inFlight = false; });
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingMessage(); // restore default; next run rebuilds fresh
  });
}
