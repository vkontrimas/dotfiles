/**
 * Shared "what am I doing" status-summary helper.
 *
 * Used by working-status/index.ts (main session) and seqagent/index.ts
 * (subagent side-channel) — both poll on the same turn cadence for a one-line
 * status. This holds everything that doesn't differ: the prompt, the
 * transcript renderer, model resolution, and the ephemeral complete() call.
 *
 * WHY THIS TALKS TO A DIFFERENT SERVER THAN THE AGENT DOES
 * -------------------------------------------------------
 * These polls used to go to the main model. That is fatal on the local
 * llama.cpp backend, which runs a SINGLE slot (-np 1): any request takes the
 * slot, so the live agent conversation gets swapped out — and on a hybrid
 * DeltaNet/full-attention model like Qwen3.6-27B there is no cheap rollback
 * for the recurrent state, so resuming means a full reprefill of the whole
 * context (measured 2026-08-02: 116-126s at ~100K tokens, 341s at 201K).
 *
 * Critically, shrinking the request does NOT fix this — the swap cost is paid
 * regardless of how small the poll is. An earlier attempt at truncating the
 * message history was therefore only a partial mitigation and has been
 * replaced by this: the poll goes to a dedicated tiny model on its own server
 * (local-llm/llama/compose/qwen3.5-2b-summariser.yml, :11437), so the main
 * slot is never touched at all.
 *
 * Measured effect: a poll went from ~65,000 prompt tokens (full system prompt
 * 18.3K chars + 15 tool schemas 13.1K chars + entire history) to ~220 tokens
 * at the original 2000-char transcript budget. The budget has since been
 * widened twice (see TRANSCRIPT_MAX_CHARS), so a full poll now runs closer to
 * ~3250 — still a 20x reduction, and on a server whose slot nothing else
 * contends for, which is the property that actually mattered.
 *
 * Plain relative import rather than a declared package dependency: pi's
 * extension loader gives each extension its own jiti instance with
 * `moduleCache: false`, so the `file:../tasks` + `await import()` pattern used
 * elsewhere can't share *live state* across extensions. This module is
 * stateless — every export is a pure function — so each extension
 * re-evaluating its own copy is harmless.
 */
import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Every other turn. This was 3 while the poll shared the agent's single-slot
// server and callers awaited it — each tick was latency on the critical path,
// so it was worth spacing out. Neither is true now: the poll goes to the
// dedicated 2B server and both callers fire it without awaiting, so the only
// cost of a tighter cadence is 2B tokens. A caller already in flight skips its
// tick, so this raises how often a poll *starts*, not how many run at once.
// No cadence constant any more. Both callers now fire from the `context`
// event, which pi emits before every LLM call, so the summary tracks turns
// one-for-one and also lands a first label off the user's own message before
// the opening turn runs. The old every-N-turns pacing was a workaround for the
// poll being awaited against the agent's single-slot server; with a dedicated
// 2B and an unawaited call there is nothing left to pace, and `summaryInFlight`
// in each caller provides the only backpressure that's actually needed — if a
// poll outlives its turn, the next tick is skipped rather than queued.

// The dedicated summariser, as registered in pi/agent/models.json. Routed
// through Bifrost (:11435 -> :11437) rather than straight at the container, so
// these polls show up in the gateway's log UI alongside every other request —
// worth one extra hop for the observability.
//
// The "write: broken pipe" 500s previously seen on gateway side-channel calls
// aren't a concern here: those came from a pooled connection being reused
// while the shared single slot was mid-generation. This model has its own
// server and two slots, so there's no generation to collide with.
const SUMMARY_PROVIDER = "summariser";
const SUMMARY_MODEL_ID = "vllm/qwen3.5-2b-summariser";

// Prompt shape is tuned for a 2B, which is far more example-suggestible than
// the 27B was. Two failure modes showed up in testing and both are addressed
// here deliberately:
//
//   1. With the examples last, the model echoed a "Good:" example verbatim
//      instead of reading the transcript. Fixed by moving all instruction and
//      examples into the system prompt, leaving the transcript as the last and
//      most salient thing in the request, and by labelling the examples as
//      form-only with an explicit "never copy" rule.
//   2. With the repeat-previous-label rule buried in the user message, the
//      model reworded the same task every tick — the exact flicker that
//      folding the previous summary in was meant to stop. Fixed by promoting
//      it to a top-level rule here.
//
// Verified 2026-08-02 against Qwen3.5-2B-Q8_0: repeats verbatim on an
// unchanged task (including when the transcript drifts to a different file),
// writes a fresh label on a genuine task switch, works with no previous
// label, and strips first-person/conversational bait
// ("Let me see! I need to figure out why my parser is crashing. This is
// getting complex." -> "Investigating parser crash").
const SUMMARY_SYSTEM_PROMPT = `You label an agent transcript with a status line.

Rules:
- 5 words or fewer, describing WHAT is being done.
- Cold third-person fragment. No first-person (I, we, my, our).
- No conversational text (Let me, Success!, Now I will). No greetings.
- Output ONLY the label. Never copy the examples below; they show FORM only.
- If a PREVIOUS LABEL is given and the transcript is still the same broad task, output that previous label character-for-character. Only write a new label if the task genuinely changed.

Form examples (do not reuse the wording):
  transcript about a segfault -> Investigating segfault
  transcript about missing exports -> Investigating missing functions
  transcript about reading settings -> Config file located, verifying settings`;

// Budget for the rendered transcript. Applied to the rendered text rather than
// to raw message objects, because that's what actually reaches the model: a
// message that renders to nothing (a toolResult, now dropped entirely) or to
// one capped line must not be charged for its raw size, or the window would
// give up earlier context to pay for bytes it never sends.
// Sized to fill ~80% of a slot, rather than to sit safely under it as before
// (2000/16, then 3500/28). The summariser now runs --ctx-size 8192 with -np 2,
// so a slot is 4096 tokens and the 80% target is ~3277 for the whole request.
// Against that: 167 tokens of system prompt, ~55 of wrapper and chat template,
// and 32 reserved for the reply leaves ~3020 for the transcript.
//
// Converted at 3.00 chars/token, measured with the summariser's own /tokenize
// on representative rendered-transcript lines rather than assumed — file paths,
// CLI flags and punctuation tokenize far denser than prose does (a prose-based
// guess of ~3.75 would have undershot this budget by a fifth). Hence 9000.
//
// The remaining ~20% is real headroom, not padding: content that tokenizes
// denser than 3.00 spends it. Below roughly 2.4 chars/token a maximal
// transcript would exceed the slot, at which point the poll fails and the
// status line is simply not updated — requestSummaryText swallows it.
//
// The same 9000 is spent on fewer, richer lines than it once was: 72x200
// became 50x500. An earlier note here argued the opposite — that the budget
// should buy more *events* — which is a real trade, but a 200-char slice
// truncated exactly the part that identifies the work (the tail of a path, the
// flag that says what a command was for).
//
// TOOL_ARG_MAX_CHARS matters more than LINE_MAX_CHARS for this. Tool calls are
// most of a transcript and render from their argument values, which were
// capped separately at 80 — so tool lines came out ~40-80 chars no matter what
// LINE_MAX_CHARS said, and raising only the line cap would have changed
// nothing for them. It moves to 300 alongside.
//
// The line count went 30 -> 50 once toolResults stopped rendering. At 30 the
// line ceiling bound in every case measured and polls ran at ~55-60% of the
// char budget, but before results were dropped that headroom would only have
// bought more log spew, so leaving it unused was right. With results gone the
// marginal line is another real action instead, which is worth paying for.
//
// The two caps interact through the char budget: lines are gathered backwards
// until either runs out, so the per-line caps decide how many lines the 9000
// covers, and TRANSCRIPT_MAX_LINES is a ceiling on *reach* — how far back a
// summary can see — rather than a target. Whichever binds first is a property
// of the traffic, not something to tune toward.
//
// WORTH RE-EXAMINING IF LABELS DEGRADE: this is now a transcript ~10x the
// original, fed to a 2B. Memory is not the risk — attention is. The prompt is
// built so the transcript is the last and most salient thing in the request,
// but a window this wide can span two unrelated tasks, and the failure mode is
// a confident label for the older one. If that shows up, cut this budget; do
// not reach for the context size, which is not what's binding.
const TRANSCRIPT_MAX_CHARS = 9000;
const TRANSCRIPT_MAX_LINES = 50;
const LINE_MAX_CHARS = 500;
const TOOL_ARG_MAX_CHARS = 300;

function collapse(text: string, limit = LINE_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

// Renders one message to zero or more transcript lines. Three kinds of content
// are dropped outright:
//
//   - toolResult messages. The label describes what is being DONE, and the
//     call already says that ("Read server-context.cpp"); the result is the
//     output of doing it. It was also the worst content per char in here — log
//     spew, file bodies, JSON — arriving in the position the model weights
//     most heavily (nearest the end), which is precisely where noise does the
//     most damage on a 2B. Dropping it means the window reaches back over
//     roughly twice as many real actions for the same budget.
//   - thinking blocks: the model's scratch work, not what it's doing.
//   - image payloads, which become a placeholder rather than dragging base64
//     or the vision tower into a status poll.
//
// The cost is real and worth stating: a task identified only by its result
// ("the segfault is in parse_headers") no longer reaches the summariser, so
// the label leans on the user's message and the tool calls to place the work.
// That is the trade being made, not an oversight.
function renderMessage(message: Message): string[] {
  const lines: string[] = [];
  const content = message.content;

  if (message.role === "toolResult") return lines;

  if (typeof content === "string") {
    const text = collapse(content);
    if (text) lines.push(`[${message.role}] ${text}`);
    return lines;
  }

  for (const block of content) {
    switch (block.type) {
      case "text": {
        const text = collapse(block.text);
        if (text) lines.push(`[${message.role}] ${text}`);
        break;
      }
      case "toolCall": {
        // Argument values, not keys, are what identify the action ("Read
        // server-context.cpp" beats "Read(file_path)"), so join the values.
        // Capped separately from LINE_MAX_CHARS because tool calls dominate a
        // transcript: at the old 80 this was the real constraint on how much a
        // line carried, and the line cap never got a look in.
        const args = collapse(Object.values(block.arguments ?? {}).map((v) => String(v)).join(" "), TOOL_ARG_MAX_CHARS);
        lines.push(`[tool] ${block.name}(${args})`);
        break;
      }
      case "image":
        lines.push("[image]");
        break;
      // thinking: intentionally skipped
    }
  }
  return lines;
}

// Builds the transcript tail within budget, walking backwards so the most
// recent activity always wins. Returns oldest-first.
//
// Note this replaces the earlier `truncateForSummary` approach of slicing real
// Message objects and re-sending them. Flattening to text removes a whole
// class of problem: no orphaned toolResult can be cut loose from its toolCall
// (providers reject that), no tool schemas are needed, and no thinking blocks
// or image payloads can leak in.
export function renderTranscript(messages: Message[]): string {
  const lines: string[] = [];
  let chars = 0;
  outer: for (let i = messages.length - 1; i >= 0; i--) {
    const rendered = renderMessage(messages[i]);
    for (let j = rendered.length - 1; j >= 0; j--) {
      const line = rendered[j];
      if (lines.length > 0 && (chars + line.length > TRANSCRIPT_MAX_CHARS || lines.length >= TRANSCRIPT_MAX_LINES)) {
        break outer;
      }
      lines.unshift(line);
      chars += line.length;
    }
  }
  return lines.join("\n");
}

// Resolves the dedicated summariser. Deliberately does NOT fall back to the
// agent's own model: that is precisely the behaviour this module exists to
// avoid, and a silent fallback would quietly reintroduce multi-minute
// reprefills. If the summariser isn't registered or isn't running, callers
// get undefined and simply show no summary segment.
function resolveSummaryModel(ctx: ExtensionContext) {
  return ctx.modelRegistry.find(SUMMARY_PROVIDER, SUMMARY_MODEL_ID);
}

// Fires a standalone, ephemeral completion against the dedicated summariser.
// Best-effort: never throws — returns undefined on any failure (including the
// summariser being unregistered, down, or the call being aborted) so callers
// can no-op.
//
// `signal` is an explicit parameter rather than `ctx.signal` on purpose.
// ctx.signal is documented as "the current abort signal, or undefined when the
// agent is not streaming" — i.e. it belongs to the in-progress generation.
// That was fine while callers awaited this inside turn_end, but callers now
// fire it without awaiting, so the request outlives the turn that started it
// and ctx.signal would be aborted out from under it as soon as streaming
// stopped. Callers pass a run-scoped signal instead.
export async function requestSummaryText(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  priorMessages: Message[],
  lastSummary: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const model = resolveSummaryModel(ctx);
    if (!model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return undefined;

    const transcript = renderTranscript(priorMessages);
    if (!transcript) return undefined;

    const previous = lastSummary ? `PREVIOUS LABEL: ${lastSummary}\n\n` : "";
    const promptText = `${previous}Transcript:\n${transcript}\n\nLabel:`;

    const response = await complete(
      model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
        // No tools, deliberately: the summariser must never call anything, and
        // the agent's 15 schemas were 13.1K chars of the old request.
      },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, reasoning: "off", maxTokens: 32, signal },
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
