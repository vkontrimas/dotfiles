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
 * logic via `../lib/summary-status.ts`. On the first agent turn, and every
 * SUMMARY_INTERVAL_TURNS turns after, it renders a bounded text transcript of
 * recent activity and asks a small dedicated model for a one-line label. The
 * result never touches the real session/context — it only ever reaches the UI
 * via `ctx.ui.setWorkingMessage`.
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
import { requestSummaryText, SUMMARY_INTERVAL_TURNS } from "../lib/summary-status.ts";

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
  let turnsSinceSummary = 0;
  let summarizedOnce = false;
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

  pi.on("context", (event) => {
    lastMessages = event.messages;
  });

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

  const resetRun = () => {
    turnsSinceSummary = 0;
    summarizedOnce = false;
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

  // Reset state at the start of every agent run. The first summary fires on the
  // first turn_end (`!summarizedOnce` makes it due), so the status line shows
  // a bare "Working..." for one turn while the first agent turn runs.
  pi.on("agent_start", (_event, ctx) => {
    resetRun();
    refreshWorkingMessage(ctx);
  });

  pi.on("agent_end", () => {
    stopRunSummaries();
  });

  // No longer async: the summary is fired without awaiting, so this handler
  // does no async work of its own and shouldn't hold up the next turn.
  pi.on("turn_end", (_event, ctx) => {
    refreshWorkingMessage(ctx); // picks up latest task counts every turn regardless of summary cadence
    if (agentEnded) return;

    turnsSinceSummary++;
    const due = !summarizedOnce || turnsSinceSummary >= SUMMARY_INTERVAL_TURNS;
    if (!due) return;
    turnsSinceSummary = 0;
    summarizedOnce = true;
    // Deliberately NOT awaited. pi awaits turn_end handlers before issuing the
    // next turn's request, so awaiting this put the summariser's round-trip
    // directly on the critical path of every third turn. That was unavoidable
    // when it shared the agent's single-slot (-np 1) server — an overlapping
    // request would have fought the live generation for the slot — but it now
    // has its own 2B server with two slots, so there is nothing to collide
    // with and no reason to make the user wait for it.
    //
    // `void` marks the floating promise as intentional; requestSummary owns
    // all the late-landing and ordering guards.
    void requestSummary(ctx);
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
