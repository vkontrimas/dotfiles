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
 * from `seqagent/index.ts` — both now share the actual prompt/complete()
 * logic via `../lib/summary-status.ts`. Before every LLM call it renders a
 * bounded text transcript of recent activity and asks a small dedicated model
 * for a one-line label. The result never touches the real session/context —
 * it only ever reaches the UI via `ctx.ui.setWorkingMessage`.
 *
 * That call used to go to the agent's own model, passing the entire message
 * prefix, on the theory that an identical prefix rides the already-warm
 * prompt cache for free. It doesn't: on the local llama.cpp backend the
 * single slot (-np 1) has to swap the live conversation out, and a hybrid
 * recurrent model can't roll that back cheaply, so every poll cost a
 * multi-minute full reprefill. Shrinking the request didn't fix it — the swap
 * is what costs, not the size — so the poll now goes to a separate tiny
 * server entirely. `../lib/summary-status.ts` carries the full reasoning.
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
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestSummaryText } from "../lib/summary-status.ts";

const SUMMARY_MAX_CHARS = 80;

interface TaskCounts {
  total: number;
  remaining: number;
}

export default function (pi: ExtensionAPI) {
  // AgentMessage[], not Message[] — the `context` event fires upstream of
  // convertToLlm (see the header comment). Typed off convertToLlm's own
  // parameter so the distinction can't drift.
  let lastMessages: Parameters<typeof convertToLlm>[0] = [];
  let currentSummary: string | undefined;
  let taskCounts: TaskCounts = { total: 0, remaining: 0 };
  let agentEnded = false;
  // Fire-and-forget bookkeeping (see requestSummary below).
  let runController: AbortController | undefined;
  let runGeneration = 0;
  let summaryInFlight = false;

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

  // Fired without awaiting, so it has to defend itself on the way back in.
  // Four hazards, each handled below:
  //
  //   1. Late landing. The reply can arrive after agent_end/agent_settled has
  //      already reset the status line; writing then would put a stale
  //      "Working... · <summary>" on an idle UI. Guarded by `agentEnded` and
  //      by aborting `runController`, both re-checked *after* the await.
  //   2. Wrong run. A reply from the previous agent run must not leak into
  //      the next one. `runGeneration` is captured before the call and
  //      compared after; agent_start bumps it.
  //   3. Out-of-order overwrite. Two in-flight calls could resolve in reverse
  //      and leave the older label showing. `summaryInFlight` keeps it to one
  //      at a time, which also stops a stale `currentSummary` being fed back
  //      in as the PREVIOUS LABEL while a newer one is still pending.
  //   4. Unhandled rejection. requestSummaryText swallows its own errors, but
  //      refreshWorkingMessage could throw, and nothing awaits this promise —
  //      so the whole body is wrapped.
  const requestSummary = async (ctx: ExtensionContext) => {
    if (summaryInFlight) return;
    summaryInFlight = true;
    const generation = runGeneration;
    const signal = runController?.signal;
    try {
      const text = await requestSummaryText(pi, ctx, convertToLlm(lastMessages), currentSummary, signal);
      if (!text) return;
      if (generation !== runGeneration || agentEnded || signal?.aborted) return;
      currentSummary = text;
      refreshWorkingMessage(ctx);
    } catch {
      // best-effort: a status line is never worth surfacing an error for
    } finally {
      summaryInFlight = false;
    }
  };

  // `context` is the trigger as well as the capture point. It's documented as
  // "fired before each LLM call", which buys two things the old turn_end
  // cadence couldn't:
  //
  //   - Every turn, with no counter. The every-N-turns pacing existed because
  //     the poll was once awaited against the agent's own single-slot server;
  //     neither constraint survives (dedicated 2B, fired unawaited), so there
  //     was nothing left to pace against and the counters were deleted rather
  //     than set to 1.
  //   - A label for the user's own message. This fires *before* the first
  //     assistant turn, with `messages` already holding the new prompt, so the
  //     line is captioned from the moment the user hits enter instead of
  //     showing a bare "Working..." until the first turn finished. It also
  //     means the opening label is drawn from what was actually asked, which
  //     is usually a better description of the run than its first tool call.
  //
  // To be clear about what "before each LLM call" means: this is per *turn*,
  // not per user message. pi-agent-core calls transformContext at the top of
  // streamAssistantResponse, which the inner `while (hasMoreToolCalls || ...)`
  // loop re-enters for every tool-call continuation. Confirmed on a 3-turn
  // run — context fired at messages=1/lastRole=user, then twice more at
  // lastRole=toolResult, one per turn_start/turn_end pair. So the cadence
  // matches the old turn_end trigger exactly; it's just moved to the front of
  // each turn, which is what buys the extra label off the user's message.
  //
  // Registered after requestSummary so it isn't referencing a const declared
  // below it. Handlers here can rewrite the outgoing message list and are
  // therefore awaited by the runner, so this one stays synchronous — the
  // summary is fired unawaited and must remain so, or every LLM call in the
  // session would block on a status line.
  pi.on("context", (event, ctx) => {
    lastMessages = event.messages;
    if (agentEnded) return;
    void requestSummary(ctx);
  });

  const resetRun = () => {
    currentSummary = undefined;
    agentEnded = false;
    // Bumping the generation invalidates any reply still in flight from the
    // previous run, and aborting its controller stops that request rather
    // than leaving it to finish into a void.
    runGeneration++;
    runController?.abort();
    runController = new AbortController();
  };

  // Ends the run's summary work. Called from both agent_end and
  // agent_settled: agent_end is the earliest point we know no further status
  // line should be shown, and agent_settled is the backstop in case a run
  // ends without one (an aborted run, say).
  const stopRunSummaries = () => {
    agentEnded = true;
    runController?.abort();
  };

  // Reset state at the start of every agent run. The first summary now fires
  // from the `context` event immediately after this, before the first turn's
  // LLM call, so the bare "Working..." is only on screen for as long as the
  // 2B takes to answer rather than for a whole agent turn.
  pi.on("agent_start", (_event, ctx) => {
    resetRun();
    refreshWorkingMessage(ctx);
  });

  pi.on("agent_end", () => {
    stopRunSummaries();
  });

  // Task counts only. Requesting the summary moved to `context`, which fires
  // once per LLM call and so covers every turn anyway — keeping a second
  // trigger here would just double the poll rate for the same information.
  // pi awaits turn_end handlers before issuing the next turn's request, so
  // this deliberately stays synchronous and does no network work.
  pi.on("turn_end", (_event, ctx) => {
    refreshWorkingMessage(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    // Before the mode guard: a run that settles without agent_end must still
    // stop its summaries, and that has nothing to do with whether there's a
    // TUI to draw into.
    stopRunSummaries();
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingMessage(); // restore default; next run rebuilds fresh
  });
}
