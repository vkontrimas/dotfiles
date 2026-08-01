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
 * The style is deliberately *not* caveman-speak. The popular caveman skill
 * compresses by mangling the writing — dropping articles, using fragments,
 * inventing abbreviations — and its own docs concede the token savings are
 * far smaller than advertised once input tokens and the skill's own overhead
 * are counted. Anthropic argues the opposite directly in the current Claude
 * Code prompt: readable and concise are different things, and readable matters
 * more, because a summary the user has to reread has spent whatever brevity
 * saved. So this shortens by *dropping details that wouldn't change what the
 * reader does next*, and bans shortening words.
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
 *   - One bad/good pair. Enumerated bad examples at realistic length are what
 *     a model pattern-matches against; one earns its tokens, five don't.
 *
 * Everything else — that headers are optional, that bullets shouldn't nest —
 * the model already knows.
 *
 * Beyond that, a `<system-reminder>` is injected every N turns (default 20,
 * `PI_CONCISE_EVERY` to change it). Style instructions decay over a long
 * context — this is the standard fix, and it's the same mechanism the `tasks`
 * extension uses for its checklist. It goes through the `context` event, so
 * it's visible to the model on exactly one LLM call and never written to the
 * session log or shown in the UI. It's deliberately terse: it re-anchors the
 * contract, it doesn't restate it. Once every 20 turns is rare on purpose —
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
const DEFAULT_REMINDER_EVERY_N_TURNS = 20;

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
Lead with the outcome: the first sentence says what happened or what you found.

Cut preamble ("Sure!", "Great question", "Let me explain", "Based on the information provided"), postamble (summarizing edits the user just watched you make), framing ("Here is the content of...", "The answer is X" — just give X), hedging ("perhaps", "it seems like", "you might want to consider"), restating the question, and narrating tool calls before you make them.

Keep exact error strings, file_path:line_number, and the reason why when the fix is not obvious. One sentence before your first tool call, and one at each blocker or change of direction — brief is good, silent is not.

Shorten by dropping details that would not change what the reader does next, never by shortening words: no fragments, no dropped articles, no invented abbreviations, no arrow chains.

Write at whatever length is needed for security implications, destructive actions, or a user who seems confused — clarity beats brevity. Never announce this style.

<example>
user: does the retry wrapper handle 429s?
BAD: Great question! Let me take a look at the retry logic for you. Looking at the code, I can see that the retry wrapper does indeed appear to handle 429 responses. Here is what I found...
GOOD: No. retry.ts:34 retries on 5xx only, so 429 falls through to the error path.
</example>
</output_style>`;

const REMINDER_TEXT =
	`<system-reminder>\n` +
	`Stay concise: outcome first, no preamble or postamble, and do not re-summarize ` +
	`edits the user watched you make. Complete sentences, not fragments.\n` +
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
