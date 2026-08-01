/**
 * Concise Extension
 *
 * Pi's default system prompt carries exactly one conciseness instruction — the
 * bullet `- Be concise in your responses`, hardcoded into every prompt at
 * `pi-coding-agent/dist/core/system-prompt.js`. An abstract instruction like
 * that reliably loses to an enumerated list of banned phrases, and the local
 * models this setup runs against ignore it outright: replies come back with
 * preamble, a restatement of the question, and a paragraph summarizing edits
 * the user just watched scroll past.
 *
 * This replaces that one bullet with an explicit contract, injected as an
 * `<output_style>` block on `before_agent_start`. Position matters, so it's
 * placed by string surgery rather than appended: anchoring on the default
 * template's `Guidelines:` header lands the block immediately after
 * `Available tools:`, near the top of the prompt where instructions actually
 * get followed, rather than buried under the Pi documentation section, the
 * project context files, and the skills listing. A custom system prompt
 * (`--system-prompt`, `SYSTEM.md`) has no such template and therefore no
 * anchor — that case falls back to appending, so the block is never silently
 * dropped.
 *
 * The register is telegraphic — fragments, dropped articles, dropped subject
 * pronouns — but two of caveman's habits are still banned: invented
 * abbreviations (cfg, impl, fn) and arrow chains (A -> B -> fails). The
 * tokenizer splits those the same as the full word, so they save nothing and
 * cost the reader a decode. They were never the part of caveman that was
 * concise.
 *
 * What the register is worth was measured, not guessed. Sampling 300 requests
 * from the local bifrost log (85 carrying assistant prose, qwen3.6-27b): 60%
 * contained "Let me", 65% ended in a trailing colon, and 88% were under 200
 * chars. Nearly all of that volume was one shape — a wind-up narrating the
 * tool call about to happen ("Now let me run the test suite to check all
 * fixes:"). An earlier revision of this block caused it: it licensed "one
 * sentence before your first tool call", which the model applied to every tool
 * call, and simultaneously banned fragments, which forced each of those into a
 * full grammatical sentence. So the rule now targets the wind-up rather than
 * the act — "Running suite." is fine, and the banned-opener list is literal
 * because that is what actually catches.
 *
 * The block is kept short on purpose, and that constraint is Pi's, not a
 * guess. Pi's whole system prompt and tool definitions together come in under
 * 1000 tokens, on the stated grounds that frontier models "have been RL-trained
 * up the wazoo, so they inherently understand what a coding agent is. There
 * does not appear to be a need for 10,000 tokens of system prompt." A 700-token
 * essay about brevity bolted onto a ~480-token prompt would more than double it
 * to say "be brief", which is self-refuting on both counts. So the block keeps
 * only what the model can't infer:
 *
 *   - Literal banned phrases. "Be concise" is already in Guidelines and gets
 *     ignored; a named string is what actually catches.
 *   - The carve-outs (security, destructive actions, a confused user) — what
 *     makes a terse style safe to leave always-on, since otherwise the model
 *     compresses exactly where ambiguity costs most.
 *   - Two bad/good pairs. Bad examples at realistic length are what a model
 *     pattern-matches against; the second covers the tool-call wind-up, which
 *     the measurement above makes the dominant failure by a wide margin.
 *
 * Everything else — that headers are optional, that bullets shouldn't nest —
 * the model already knows.
 *
 * Beyond that, a `<system-reminder>` is injected every N turns (default 10,
 * `PI_CONCISE_EVERY` to change it). Style instructions decay over a long
 * context — this is the standard fix, and it's the same mechanism the `tasks`
 * extension uses for its checklist. It goes through the `context` event, so
 * it's visible to the model on exactly one LLM call and never written to the
 * session log or shown in the UI. It's deliberately terse: it re-anchors the
 * contract, it doesn't restate it. Once every 10 turns is rare on purpose —
 * the system prompt is the primary instruction, and a reminder frequent enough
 * to notice is frequent enough to start reading as nagging to the model.
 *
 * `turnsSinceReminder` resets on `/reload` along with the rest of the
 * extension's memory. That's fine — turn numbering restarts there too, and the
 * counter is pacing, not state anything depends on.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Turns between reminders. Rare on purpose — see the header comment. Override
// with PI_CONCISE_EVERY; 0 or negative disables reminders entirely, leaving
// just the system-prompt block.
const DEFAULT_REMINDER_EVERY_N_TURNS = 10;

const REMINDER_EVERY_N_TURNS = (() => {
	const raw = process.env.PI_CONCISE_EVERY;
	if (!raw) return DEFAULT_REMINDER_EVERY_N_TURNS;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) ? DEFAULT_REMINDER_EVERY_N_TURNS : n;
})();

// The default system prompt runs: intro → `Available tools:` → custom-tools
// note → `Guidelines:` → Pi docs. Inserting before this header puts the block
// directly after the tools section.
const GUIDELINES_ANCHOR = "\n\nGuidelines:\n";

const CONCISE_BLOCK = `<output_style>
Outcome first. Fragments over sentences — drop articles, drop "I", drop filler verbs.

Status lines are one fragment, or nothing. Saying what comes next is fine, the wind-up isn't: "Running suite." "Grepping callers." "12 fails, all @copy classify." Never open with "Let me", "Now let me", "I'll", "Let's", or an acknowledgment ("Good", "Perfect", "Found it", "All tests pass!"). No trailing colon before a tool call.

Cut preamble ("Sure!", "Great question", "Based on the information provided"), framing ("Here is the report", "The answer is X" — give X), hedging ("perhaps", "seems like", "you might want to consider"), restating the question.

End-of-turn summary: structure is welcome — headers, bold labels, a per-file list. Terseness applies inside it. One line per entry, fragments, no re-pasted code, no paragraph re-narrating a diff the user watched scroll past.

Keep exact error strings, file_path:line_number, and why when the fix isn't obvious. Never invent abbreviations (cfg, impl, fn) or arrow chains (A → B → fails); both cost tokens and cost the reader.

Full prose, full length for security implications, destructive actions, or a confused user — clarity beats brevity there. Never mention this style.

<example>
user: does the retry wrapper handle 429s?
BAD: Great question! Let me take a look at the retry logic for you. Looking at the code, I can see that the retry wrapper does indeed appear to handle 429 responses. Here is what I found...
GOOD: No. retry.ts:34 retries 5xx only. 429 falls to the error path.
</example>

<example>
[about to grep for callers]
BAD: Now let me search for where this is called:
GOOD: Grepping callers.
</example>

<example>
[end of turn, after edits]
BAD: **Compiler changes** (\`tc_move.c\`): 1. **Struct/union copy classification**: Changed from \`!droppable || has_copy\` to just \`has_copy\`. A struct/union is now copyable **only** with \`@copy\`, regardless of whether it owns resources.
GOOD: **\`tc_move.c\`** — struct/union copy now needs \`@copy\`; arrays compose from element type.
**12 tests** — added \`@copy\`, 3 restructured (generics segfault). 1381 pass.
</example>
</output_style>`;

const REMINDER_TEXT =
	`<system-reminder>\n` +
	`Concise. Status lines are one fragment — no "Let me...", no preamble, no recap ` +
	`of edits the user watched. Outcome first.\n` +
	`</system-reminder>`;

export default function (pi: ExtensionAPI): void {
	let turnsSinceReminder = 0;

	pi.on("before_agent_start", async (event) => {
		const prompt = event.systemPrompt;
		const i = prompt.indexOf(GUIDELINES_ANCHOR);

		// No anchor means a custom system prompt is in play — append rather than
		// drop the block.
		if (i === -1) {
			return { systemPrompt: `${prompt}\n\n${CONCISE_BLOCK}` };
		}

		return {
			systemPrompt: `${prompt.slice(0, i)}\n\n${CONCISE_BLOCK}${prompt.slice(i)}`,
		};
	});

	pi.on("turn_start", async () => {
		turnsSinceReminder++;
	});

	pi.on("context", async (event) => {
		if (REMINDER_EVERY_N_TURNS <= 0) return;
		if (turnsSinceReminder < REMINDER_EVERY_N_TURNS) return;
		turnsSinceReminder = 0;

		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					timestamp: Date.now(),
					content: [{ type: "text" as const, text: REMINDER_TEXT }],
				},
			],
		};
	});
}
