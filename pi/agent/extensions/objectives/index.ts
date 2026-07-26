/**
 * Objectives Extension
 *
 * Gives the agent `add_objectives` and `complete_objective` tools to track a
 * to-do list for long-running tasks, and periodically re-injects that list
 * as a <system-reminder> so the model doesn't lose track or stop early.
 *
 * `add_objectives` only appends — it cannot replace, edit, or remove existing
 * items. Each new objective requires a `reason`: what it's for and what
 * "done" will look like. `complete_objective` takes an objective's ID and a
 * `justification` — concrete evidence the work actually happened (a command
 * run, a test that passed, a file read back to confirm). Requiring a
 * justification at completion time — instead of just letting the model
 * assert a whole list is done — is a direct countermeasure to the
 * "Rationalization Loophole": a model marking things done because it wants
 * to stop, not because it verified them.
 *
 * `reason` is deliberately never shown in the chat UI (tool call/result
 * rendering, the /objectives banner) — it's not a status update for the
 * user, it's a commitment the model made to itself, and it's re-surfaced
 * only in the <system-reminder> text the model sees, so the model is the one
 * being held to it. `justification`, by contrast, IS shown in the chat UI —
 * it's the evidence a human would want to spot-check.
 *
 * The periodic reminder is injected via the `context` event, so it's only
 * visible to the model on the next LLM call — it's never written to the
 * session log or shown in the UI.
 *
 * If the agent stops (goes idle) while objectives remain, an `agent_end`
 * handler pushes a real follow-up message telling it to keep going, up to
 * a few attempts before giving up and notifying the user. That message also
 * mentions a second, deliberately hidden tool — `objectives_blocked` — with
 * specific examples of what counts as a genuine structural blocker (missing
 * credentials, contradictory requirements, decisions only a human can make,
 * irreversible actions needing authorization). It has no promptSnippet or
 * promptGuidelines, so it never appears in the "Available tools"/Guidelines
 * sections — the model only learns about it from that narrow framing, so
 * it isn't reached for as a casual "should I continue?" escape hatch.
 *
 * The objectives list itself lives in `add_objectives`/`complete_objective`
 * tool result `details` fields, which are already part of the persisted
 * session — so on `/reload`, `/resume`, or `/tree` navigation, it's
 * reconstructed by replaying those results on the current branch instead of
 * being lost with the rest of the extension's in-memory state. IDs are
 * sequential integers assigned by the tool (never the model), so replay just
 * needs the running count of objectives added since the last clear. Turn-based
 * counters (turnsSinceReminder, stalls, etc.) reset on reload since turn
 * numbering itself restarts — they're session-lifetime telemetry, not
 * functional state.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, renderDiff } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { diffLines } from "diff";
import { Type } from "typebox";

interface Objective {
	id: string;
	text: string;
	reason: string;
	done: boolean;
	justification?: string;
}

interface ObjectivesBannerData {
	content: string;
}

interface ObjectivesContinueDetails {
	remaining: number;
	objectives: Objective[];
}

interface Stats {
	addCalls: number;
	completeCalls: number;
	objectivesCreated: number;
	remindersSent: number;
	autoContinues: number;
	stallGiveUps: number;
	blockedStops: number;
	turnGapsSinceLastUpdate: number[];
}

function newStats(): Stats {
	return {
		addCalls: 0,
		completeCalls: 0,
		objectivesCreated: 0,
		remindersSent: 0,
		autoContinues: 0,
		stallGiveUps: 0,
		blockedStops: 0,
		turnGapsSinceLastUpdate: [],
	};
}

// User-facing rendering (chat UI: /objectives banner, tool call/result blocks).
// Deliberately omits `reason` — it's a model-facing commitment, not a status
// update. `justification` IS shown here — it's the evidence a human would
// want to spot-check.
function renderObjectivesBlock(theme: Theme, objectives: Objective[]): string {
	const remaining = objectives.filter((o) => !o.done).length;
	const done = objectives.length - remaining;

	let output = `${theme.fg("toolTitle", theme.bold("objectives"))} ${theme.fg("accent", `(${done}/${objectives.length} done, ${remaining} remaining)`)}`;

	if (objectives.length > 0) {
		const lines = objectives.map((o) => {
			const line = `${o.done ? theme.fg("success", "✓") : theme.fg("muted", "✗")} ${theme.fg("dim", `#${o.id}`)} ${o.text}`;
			return o.done && o.justification ? `${line}\n  ${theme.fg("muted", o.justification)}` : line;
		});
		output += `\n\n${lines.join("\n")}`;
	}

	return output;
}

// Model-facing rendering (<system-reminder> content only, never shown in the
// chat UI). Includes `reason` for pending items — the model's own stated
// reason for the objective, repeated back to it — and `justification` for
// completed ones, so past completions stay auditable across the reminder
// cycle too.
function renderObjectivesChecklistForModel(objectives: Objective[]): string {
	return objectives
		.map((o) => {
			const box = o.done ? "x" : " ";
			const suffix = o.done
				? o.justification
					? ` — done: ${o.justification}`
					: ""
				: o.reason
					? ` — reason: ${o.reason}`
					: "";
			return `- [${box}] #${o.id} ${o.text}${suffix}`;
		})
		.join("\n");
}

// Builds the "+N ", "-N ", " N " line format that Pi's own renderDiff (used
// by the built-in edit tool) expects, so add_objectives/complete_objective
// diffs get the same red/green + intra-line word-highlight rendering as file
// edits. Mirrors generateDiffString from pi-coding-agent's edit-diff.ts (not
// itself exported), minus context truncation — objectives lists are short
// enough to always show in full. Deliberately excludes `reason`/
// `justification` from the diffed text — those are handled separately by
// each tool's own renderResult.
function buildObjectivesDiff(oldObjectives: Objective[], newObjectives: Objective[]): string {
	const toLine = (o: Objective) => `#${o.id} [${o.done ? "x" : " "}] ${o.text}`;
	const oldText = oldObjectives.map(toLine).join("\n");
	const newText = newObjectives.map(toLine).join("\n");
	const parts = diffLines(oldText, newText);

	const output: string[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	for (const part of parts) {
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		for (const line of raw) {
			if (part.added) {
				output.push(`+${newLineNum} ${line}`);
				newLineNum++;
			} else if (part.removed) {
				output.push(`-${oldLineNum} ${line}`);
				oldLineNum++;
			} else {
				output.push(` ${oldLineNum} ${line}`);
				oldLineNum++;
				newLineNum++;
			}
		}
	}
	return output.join("\n");
}

// How many turns to let pass between reminders.
const REMINDER_EVERY_N_TURNS = 5;

// Give up auto-continuing after this many stops in a row with zero progress,
// so a genuinely stuck model doesn't spin forever without the user noticing.
const MAX_STALLED_CONTINUES = 3;

export default function (pi: ExtensionAPI): void {
	let objectives: Objective[] = [];
	let nextId = 1;
	let turnsSinceReminder = 0;
	let lastContinueSignature: string | null = null;
	let stalledContinues = 0;
	let totalTurns = 0;
	let lastActivityTurn: number | null = null;
	let blockedReason: string | null = null;
	let blockedIds: string[] = [];
	const stats = newStats();

	const recordActivity = () => {
		if (lastActivityTurn !== null) {
			stats.turnGapsSinceLastUpdate.push(totalTurns - lastActivityTurn);
		}
		lastActivityTurn = totalTurns;
		turnsSinceReminder = 0;
	};

	// Rebuild `objectives`/`nextId` (and the counters derivable from them) by
	// replaying every past add_objectives/complete_objective result on the
	// current branch, in order. Runs on session_start (covers /reload,
	// /resume, and fresh sessions) and session_tree (covers manual /tree
	// navigation onto a different branch).
	const reconstructObjectives = (ctx: ExtensionContext) => {
		objectives = [];
		nextId = 1;
		stats.addCalls = 0;
		stats.completeCalls = 0;
		stats.objectivesCreated = 0;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "objectives-cleared") {
				objectives = [];
				nextId = 1;
				continue;
			}

			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult") continue;

			if (msg.toolName === "add_objectives") {
				const details = msg.details as { added?: Objective[] } | undefined;
				if (!details?.added) continue;
				objectives = [...objectives, ...details.added];
				nextId = objectives.length + 1;
				stats.objectivesCreated += details.added.length;
				stats.addCalls++;
			} else if (msg.toolName === "complete_objective") {
				const details = msg.details as { objective?: Objective } | undefined;
				if (!details?.objective) continue;
				objectives = objectives.map((o) => (o.id === details.objective!.id ? details.objective! : o));
				stats.completeCalls++;
			}
		}

		// Turn numbering restarts on reload/resume, so a stale turn-gap baseline
		// would just produce a misleadingly huge first gap — drop it instead.
		turnsSinceReminder = 0;
		totalTurns = 0;
		lastActivityTurn = null;
		stalledContinues = 0;
		lastContinueSignature = null;
	};

	pi.on("session_start", async (_event, ctx) => reconstructObjectives(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructObjectives(ctx));

	// Renderer for the /objectives banner (visible in chat, hidden from tree, never sent to the LLM)
	pi.registerEntryRenderer<ObjectivesBannerData>("objectives-banner", (entry, _options, theme) => {
		const data = entry.data ?? { content: "" };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Markdown(data.content, 0, 0, getMarkdownTheme()));
		return box;
	});

	// Renderer for the agent_end auto-continue message — shows a plain summary
	// instead of the raw <system-reminder> XML the model actually receives.
	pi.registerMessageRenderer("objectives-continue", (message, _options, theme) => {
		const details = message.details as ObjectivesContinueDetails | undefined;
		const remaining = details?.remaining ?? 0;
		const list = details?.objectives ?? [];

		let text = theme.fg("accent", `↻ Continuing — ${remaining} objective${remaining === 1 ? "" : "s"} remaining`);

		if (list.length > 0) {
			const lines = list.map(
				(o) => `${o.done ? theme.fg("success", "✓") : theme.fg("muted", "✗")} ${theme.fg("dim", `#${o.id}`)} ${o.text}`,
			);
			text += `\n\n${lines.join("\n")}`;
		}

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// /objectives — show the current list without touching the session/context
	pi.registerCommand("objectives", {
		description: "Show the current objectives list without sending anything to the model",
		handler: async (_args, ctx) => {
			if (objectives.length === 0) {
				ctx.ui.notify("No objectives tracked yet.", "info");
				return;
			}

			const remaining = objectives.filter((o) => !o.done).length;
			const done = objectives.length - remaining;
			const lines = objectives.map((o) => {
				const line = `- ${o.done ? "✓" : "✗"} #${o.id} ${o.text}`;
				return o.done && o.justification ? `${line}\n  *${o.justification}*` : line;
			}).join("\n");

			pi.appendEntry<ObjectivesBannerData>("objectives-banner", {
				content: `**Objectives** (${done}/${objectives.length} done, ${remaining} remaining)\n\n${lines}`,
			});
		},
	});

	// /objectives-clear — drop the current list without touching the session/context
	pi.registerCommand("objectives-clear", {
		description: "Clear the current objectives list without sending anything to the model",
		handler: async (_args, ctx) => {
			if (objectives.length === 0) {
				ctx.ui.notify("No objectives to clear.", "info");
				return;
			}

			objectives = [];
			nextId = 1;
			turnsSinceReminder = 0;
			lastActivityTurn = null;
			stalledContinues = 0;
			lastContinueSignature = null;

			// Persist the clear so it survives /reload, /resume, and /tree —
			// otherwise reconstructObjectives would just replay the old list
			// back from the last add_objectives/complete_objective results.
			pi.appendEntry("objectives-cleared", {});

			ctx.ui.notify("Objectives cleared.", "info");
		},
	});

	// /objectives-stats — show tracking statistics without touching the session/context
	pi.registerCommand("objectives-stats", {
		description: "Show objectives tracking statistics without sending anything to the model",
		handler: async () => {
			const gaps = stats.turnGapsSinceLastUpdate;
			const avgGap = gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : "n/a";
			const minGap = gaps.length ? Math.min(...gaps) : "n/a";
			const maxGap = gaps.length ? Math.max(...gaps) : "n/a";

			const remaining = objectives.filter((o) => !o.done).length;
			const done = objectives.length - remaining;

			const lines = [
				"**Objectives Stats**",
				"",
				`- Current list: ${objectives.length} objectives (${done} done, ${remaining} remaining)`,
				`- add_objectives calls: ${stats.addCalls} (${stats.objectivesCreated} objectives created)`,
				`- complete_objective calls: ${stats.completeCalls}`,
				`- Turns between updates — avg: ${avgGap}, min: ${minGap}, max: ${maxGap} (n=${gaps.length})`,
				`- System reminders injected mid-task: ${stats.remindersSent}`,
				`- Auto-continues on stop: ${stats.autoContinues} resumed, ${stats.stallGiveUps} gave up (stalled), ${stats.blockedStops} stopped (blocked)`,
			];

			pi.appendEntry<ObjectivesBannerData>("objectives-banner", { content: lines.join("\n") });
		},
	});

	pi.registerTool({
		name: "add_objectives",
		label: "Add Objectives",
		description:
			"Add new objectives to the tracked to-do list for a long-running task. This only appends — it " +
			"cannot edit, reorder, or remove existing objectives. Call it again whenever you discover more work.",
		promptSnippet: "Add objectives to the tracked to-do list for long-running tasks",
		promptGuidelines: [
			"Use add_objectives to start and grow a to-do list on any task that will span many turns. It only adds — call it again as you discover more work instead of trying to replace the list.",
			"Give each objective a concrete `reason`: what problem it solves and what evidence would prove it's done. A vague reason like 'finish the task' is useless later when you have to justify completion with complete_objective.",
			"This tool assigns each objective its ID — use the IDs it returns when calling complete_objective. Don't invent your own IDs.",
		],
		parameters: Type.Object({
			objectives: Type.Array(
				Type.Object({
					text: Type.String({ description: "Short description of the objective" }),
					reason: Type.String({
						description:
							"Why this objective is needed and what completion looks like. Not shown to the user — this is " +
							"a commitment you're making to yourself, and you'll be asked to justify it with concrete evidence " +
							"when you call complete_objective.",
					}),
				}),
				{ minItems: 1, description: "New objectives to append to the list." },
			),
		}),
		async execute(_toolCallId, params) {
			const added: Objective[] = params.objectives.map((o) => ({
				id: String(nextId++),
				text: o.text,
				reason: o.reason,
				done: false,
			}));

			const prevObjectives = objectives;
			objectives = [...objectives, ...added];
			stats.objectivesCreated += added.length;
			stats.addCalls++;
			recordActivity();

			const diff = buildObjectivesDiff(prevObjectives, objectives);
			const remaining = objectives.filter((o) => !o.done).length;

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Added ${added.length} objective${added.length === 1 ? "" : "s"}: ` +
							`${added.map((o) => `#${o.id} ${o.text}`).join(", ")}. ` +
							`(${objectives.length - remaining}/${objectives.length} done, ${remaining} remaining)`,
					},
				],
				details: { objectives, diff, added },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			if (!context.isPartial) {
				text.setText("");
				return text;
			}

			const rawObjectives = Array.isArray((args as { objectives?: unknown[] } | undefined)?.objectives)
				? (args as { objectives: unknown[] }).objectives
				: [];
			const items = rawObjectives.map((o) =>
				typeof (o as { text?: unknown })?.text === "string" ? (o as { text: string }).text : "",
			);

			let output = theme.fg("toolTitle", theme.bold("add_objectives"));
			for (const item of items) {
				if (item) output += `\n${theme.fg("success", "+")} ${item}`;
			}
			text.setText(output);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			if (context.isError) {
				const output = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n");
				text.setText(output ? theme.fg("error", output) : "");
				return text;
			}

			const details = result.details as { objectives?: Objective[]; diff?: string; added?: Objective[] } | undefined;
			const objs = details?.objectives ?? [];
			const remaining = objs.filter((o) => !o.done).length;
			const done = objs.length - remaining;

			let output = `${theme.fg("toolTitle", theme.bold("add_objectives"))} ${theme.fg("accent", `(+${details?.added?.length ?? 0}, ${done}/${objs.length} done)`)}`;

			if (details?.diff) {
				output += `\n\n${renderDiff(details.diff)}`;
			}

			text.setText(output);
			return text;
		},
	});

	pi.registerTool({
		name: "complete_objective",
		label: "Complete Objective",
		description:
			"Mark a tracked objective as done. Requires a justification citing concrete evidence — a command " +
			"you ran and its output, a test that passed, a file you read back to confirm the change landed.",
		promptSnippet: "Mark a tracked objective done with evidence",
		promptGuidelines: [
			"Call complete_objective immediately after finishing each objective, before moving on to the next one — don't wait until everything is done.",
			"The `justification` must cite concrete evidence: a command you ran and its output, a test that passed, a file you read back to confirm. Do not complete an objective just because you believe it's probably done or ran out of other things to try — that's rationalizing, not verifying.",
			"If a check or test fails, don't complete the objective — fix the issue, or call objectives_blocked if you're genuinely stuck.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "ID of the objective to complete, as returned by add_objectives" }),
			justification: Type.String({
				description:
					"Concrete evidence this objective is actually done. Shown to the user — write it so a human could " +
					"spot-check your claim.",
			}),
		}),
		async execute(_toolCallId, params) {
			const idx = objectives.findIndex((o) => o.id === params.id);
			if (idx === -1) {
				const ids = objectives.map((o) => `#${o.id}`).join(", ") || "(none)";
				throw new Error(`No objective with id "${params.id}". Current ids: ${ids}`);
			}
			if (objectives[idx].done) {
				throw new Error(`Objective #${params.id} ("${objectives[idx].text}") is already marked done.`);
			}

			const prevObjectives = objectives;
			const updated: Objective = { ...objectives[idx], done: true, justification: params.justification };
			objectives = objectives.map((o, i) => (i === idx ? updated : o));
			stats.completeCalls++;
			recordActivity();

			const diff = buildObjectivesDiff(prevObjectives, objectives);
			const remaining = objectives.filter((o) => !o.done).length;

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Completed #${updated.id} — ${updated.text}. ` +
							`(${objectives.length - remaining}/${objectives.length} done, ${remaining} remaining)`,
					},
				],
				details: { objectives, diff, objective: updated },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			if (!context.isPartial) {
				text.setText("");
				return text;
			}

			const id = typeof (args as { id?: unknown } | undefined)?.id === "string" ? (args as { id: string }).id : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("complete_objective"))} ${theme.fg("accent", id ? `#${id}` : "")}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			if (context.isError) {
				const output = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n");
				text.setText(output ? theme.fg("error", output) : "");
				return text;
			}

			const details = result.details as { objectives?: Objective[]; diff?: string; objective?: Objective } | undefined;
			const objs = details?.objectives ?? [];
			const remaining = objs.filter((o) => !o.done).length;
			const done = objs.length - remaining;
			const completed = details?.objective;

			let output = `${theme.fg("toolTitle", theme.bold("complete_objective"))} ${theme.fg("accent", `#${completed?.id ?? "?"} (${done}/${objs.length} done)`)}`;

			if (completed?.justification) {
				output += `\n${theme.fg("success", "✓")} ${completed.text}\n  ${theme.fg("muted", completed.justification)}`;
			}

			if (details?.diff) {
				output += `\n\n${renderDiff(details.diff)}`;
			}

			text.setText(output);
			return text;
		},
	});

	// Deliberately has no promptSnippet/promptGuidelines, so it's absent from
	// the "Available tools" and "Guidelines" sections — the model only learns
	// about it from the specific, narrow framing in the agent_end continue
	// prompt below, so it isn't reached for casually.
	pi.registerTool({
		name: "objectives_blocked",
		label: "Objectives Blocked",
		description:
			"Stop the objectives auto-continue loop because it is structurally impossible to proceed — " +
			"not because you are uncertain or want to check in. Provide a specific, concrete reason and the " +
			"ids of the objectives you're blocked on.",
		parameters: Type.Object({
			reason: Type.String({
				description: "The specific structural or unresolvable blocker preventing further progress",
			}),
			ids: Type.Array(Type.String(), { description: "IDs of the objectives you are blocked on" }),
		}),
		async execute(_toolCallId, params) {
			blockedReason = params.reason;
			blockedIds = params.ids;
			const idList = params.ids.map((id) => `#${id}`).join(", ") || "(none)";
			return {
				content: [{ type: "text" as const, text: `Stopped: ${params.reason} (blocked on: ${idList})` }],
				details: { reason: params.reason, ids: params.ids },
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("error", theme.bold("objectives_blocked")));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as { reason?: string; ids?: string[] } | undefined;
			const reason = details?.reason ?? "";
			const names = (details?.ids ?? [])
				.map((id) => {
					const o = objectives.find((obj) => obj.id === id);
					return o ? `#${id} ${o.text}` : `#${id}`;
				})
				.join(", ");
			let output = theme.fg("error", `⛔ ${reason}`);
			if (names) output += `\n  ${theme.fg("muted", `Blocked on: ${names}`)}`;
			text.setText(output);
			return text;
		},
	});

	pi.on("turn_start", async () => {
		turnsSinceReminder++;
		totalTurns++;
	});

	pi.on("context", async (event) => {
		if (objectives.length === 0) return;
		if (turnsSinceReminder < REMINDER_EVERY_N_TURNS) return;

		turnsSinceReminder = 0;
		stats.remindersSent++;

		const remaining = objectives.filter((o) => !o.done).length;
		const list = renderObjectivesChecklistForModel(objectives);

		const reminder = {
			role: "user" as const,
			timestamp: Date.now(),
			content: [
				{
					type: "text" as const,
					text:
						`<system-reminder>\n` +
						`Objectives (${remaining} remaining):\n${list}\n\n` +
						`Keep working autonomously, no confirmation needed. Call complete_objective with concrete evidence ` +
						`as you finish items — don't mark something done because you assume it's fine. Call add_objectives ` +
						`if you discover more work.\n` +
						`</system-reminder>`,
				},
			],
		};

		return { messages: [...event.messages, reminder] };
	});

	// The agent stopped and is about to go idle — if objectives remain, push it
	// to keep going instead of waiting for the user. Bails out after a few
	// stalled attempts in a row (no change in objectives state) so a genuinely
	// stuck or blocked model doesn't spin forever unattended.
	pi.on("agent_end", async (_event, ctx) => {
		if (blockedReason) {
			stats.blockedStops++;
			const idList = blockedIds.map((id) => `#${id}`).join(", ");
			ctx.ui.notify(`objectives_blocked: ${blockedReason}${idList ? ` (blocked on: ${idList})` : ""}`, "error");
			blockedReason = null;
			blockedIds = [];
			stalledContinues = 0;
			lastContinueSignature = null;
			return;
		}

		const remaining = objectives.filter((o) => !o.done).length;
		if (remaining === 0) {
			stalledContinues = 0;
			lastContinueSignature = null;
			return;
		}

		const signature = JSON.stringify(objectives);
		if (signature === lastContinueSignature) {
			stalledContinues++;
		} else {
			stalledContinues = 0;
		}
		lastContinueSignature = signature;

		if (stalledContinues >= MAX_STALLED_CONTINUES) {
			stats.stallGiveUps++;
			ctx.ui.notify(
				`objectives: stopped auto-continuing — ${remaining} objective(s) still pending with no progress in the last ${MAX_STALLED_CONTINUES} attempts.`,
				"warning",
			);
			return;
		}

		stats.autoContinues++;
		turnsSinceReminder = 0;
		const list = renderObjectivesChecklistForModel(objectives);

		pi.sendMessage(
			{
				customType: "objectives-continue",
				content:
					`<system-reminder>\n` +
					`${remaining} objective${remaining === 1 ? "" : "s"} not done:\n${list}\n\n` +
					`Keep going — call \`complete_objective\` (id, justification) with concrete evidence as you finish items, ` +
					`and \`add_objectives\` if you discover more work.\n\n` +
					`Only call \`objectives_blocked\` (reason, ids) iff truly stuck — missing/unobtainable credentials, an ` +
					`unreachable dependency, contradictory requirements, a decision only a human can make, or an ` +
					`irreversible action needing authorization. Uncertainty, wanting confirmation, or asking whether ` +
					`to continue a long task are not blocks — keep working.\n` +
					`</system-reminder>`,
				display: true,
				details: { remaining, objectives } as ObjectivesContinueDetails,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
