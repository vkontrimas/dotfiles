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
 * The register is ordinary English — short, complete sentences. Two of
 * caveman's habits are banned outright: invented abbreviations (cfg, impl, fn)
 * and arrow chains (A -> B -> fails). The tokenizer splits those the same as
 * the full word, so they save nothing and cost the reader a decode. They were
 * never the part of caveman that was concise.
 *
 * Both of those choices were measured against the local bifrost log, not
 * guessed. The first sample (300 requests, 85 carrying assistant prose,
 * qwen3.6-27b): 60% contained "Let me", 65% ended in a trailing colon, 88%
 * were under 200 chars. Nearly all of that volume was one shape — a wind-up
 * narrating the tool call about to happen ("Now let me run the test suite to
 * check all fixes:"). An earlier revision of this block caused it: it licensed
 * "one sentence before your first tool call", which the model applied to every
 * tool call. So the rule now targets the wind-up rather than the act, and the
 * banned-opener list is literal because that is what actually catches.
 *
 * That worked. Re-sampling 250 requests after the change: "Let me" fell to
 * 24%, trailing colons to 36%. A telegraphic register was pushed at the same
 * time — fragments, dropped articles, dropped subject pronouns — and that half
 * did not take. The model kept writing complete sentences anyway ("Reading the
 * deref and addr_of type checker implementations."), which is both fine to
 * read and what it wants to do, so the mandate was paying tokens to lose an
 * argument. It's gone. What stays is the part with evidence behind it: kill
 * the wind-up, the preamble, and the recap, and leave the grammar alone.
 *
 * On size, this block deliberately breaks with Pi. Pi's whole system prompt
 * and tool definitions together come in under 1000 tokens, on the stated
 * grounds that frontier models "have been RL-trained up the wazoo, so they
 * inherently understand what a coding agent is. There does not appear to be a
 * need for 10,000 tokens of system prompt." That reasoning holds for frontier
 * models. It does not hold here: the local qwen3.6-27b ignored the terse
 * version, and every measured improvement came from spending more tokens, not
 * fewer. This block runs ~640 tokens against a ~510-token base prompt — larger
 * than the prompt it modifies, which would be indefensible if the numbers said
 * otherwise. They don't, so the cost is accepted rather than argued away.
 * Revisit it against a stronger model, where Pi's reasoning probably does
 * apply and most of this can go.
 *
 * What earns the tokens:
 *
 *   - Literal banned phrases. "Be concise" is already in Guidelines and gets
 *     ignored; a named string is what actually catches.
 *   - The carve-outs (security, destructive actions, a confused user) — what
 *     makes a terse style safe to leave always-on, since otherwise the model
 *     compresses exactly where ambiguity costs most.
 *   - Four bad/good pairs: the direct question, the tool-call wind-up, the
 *     continuation line that trails off in a colon, and the end-of-turn recap.
 *     Bad examples at realistic length are what a model pattern-matches
 *     against, and the pairs are what moved the numbers — the same lesson the
 *     `working-status` SUMMARY_PROMPT landed on independently (1eb8b5d), where
 *     adding pairs was what finally made that prompt stick. Every BAD side is
 *     lifted verbatim from the bifrost sample rather than invented, so each
 *     pair is aimed at a shape this setup actually produces.
 *
 *     Four, not seven. Three more were drafted — the meta-comprehension
 *     opener, "Done. Here's the summary:", and a reaction to a failed build —
 *     and cut: the first two ran at 3/75 and 2/75 in the sample, and the third
 *     was half-invented rather than observed. The four that stayed cover the
 *     two dominant classes and the longest messages. The continuation pair
 *     looks redundant beside the wind-up one and isn't: it carries no banned
 *     opener, only a colon, so a model that learns "avoid Let me" still
 *     produces it.
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
Lead with the outcome: the first sentence says what happened or what you found. Write short, complete sentences — cut the filler, not the grammar.

Say what you are doing in one short sentence, or say nothing. Never open with a wind-up ("Let me", "Now let me", "I'll now", "Let's") or an acknowledgment ("Good", "Perfect", "Great", "Found it", "All tests pass!"). Do not end a line with a colon just to introduce a tool call.

Cut preamble ("Sure!", "Great question", "Based on the information provided"), framing ("Here is the report", "The answer is X" — just give X), hedging ("perhaps", "seems like", "you might want to consider"), and restating the question.

End-of-turn summary: structure is welcome — headers, bold labels, a per-file list — but keep the prose inside to one line per entry. No re-pasted code, no paragraph re-narrating a diff the user watched scroll past.

Keep exact error strings, file_path:line_number, and the reason why when the fix is not obvious. Never invent abbreviations (cfg, impl, fn) or arrow chains (A → B → fails); both cost tokens and cost the reader.

Write at full length for security implications, destructive actions, or a confused user — clarity beats brevity there. Never mention this style.

<example>
user: does the retry wrapper handle 429s?
BAD: Great question! Let me take a look at the retry logic for you. Looking at the code, I can see that the retry wrapper does indeed appear to handle 429 responses. Here is what I found...
GOOD: No — retry.ts:34 retries on 5xx only, so 429 falls through to the error path.
</example>

<example>
[about to grep for callers]
BAD: Now let me search for where this is called:
GOOD: Checking the call sites.
</example>

<example>
[applying the same change to the second file]
BAD: Now the same for \`working-status/index.ts\`:
GOOD: Making the same change in \`working-status/index.ts\`.
</example>

<example>
[end of turn, after edits]
BAD: **Compiler changes** (\`tc_move.c\`): 1. **Struct/union copy classification**: Changed from \`!droppable || has_copy\` to just \`has_copy\`. A struct/union is now copyable **only** with \`@copy\`.
GOOD: **\`tc_move.c\`** — struct/union copy now requires \`@copy\`, and arrays compose from the element type.
**12 tests** — added \`@copy\` to 8, restructured 3 (generics segfault). All 1381 pass.
</example>
</output_style>`;

const REMINDER_TEXT =
	`<system-reminder>\n` +
	`Stay concise. Lead with the outcome. No wind-up before a tool call ("Let me...", ` +
	`"Now let me..."), no preamble, and no recap of edits the user watched. Short, ` +
	`complete sentences.\n` +
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
