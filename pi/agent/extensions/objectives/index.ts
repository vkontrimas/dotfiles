/**
 * Objectives Extension
 *
 * Gives the agent a `update_objectives` tool to track a to-do list for
 * long-running tasks, and periodically re-injects that list as a
 * <system-reminder> so the model doesn't lose track or stop early.
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
 * The objectives list itself lives in the `update_objectives` tool result's
 * `details` field, which is already part of the persisted session — so on
 * `/reload`, `/resume`, or `/tree` navigation, it's reconstructed by scanning
 * the current branch for the most recent update_objectives result instead of
 * being lost with the rest of the extension's in-memory state. Turn-based
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
	text: string;
	done: boolean;
}

interface ObjectivesBannerData {
	content: string;
}

interface ObjectivesContinueDetails {
	remaining: number;
	objectives: Objective[];
}

interface Stats {
	updateCalls: number;
	objectivesCreated: number;
	objectivesDeleted: number;
	remindersSent: number;
	autoContinues: number;
	stallGiveUps: number;
	blockedStops: number;
	turnGapsSinceLastUpdate: number[];
}

function newStats(): Stats {
	return {
		updateCalls: 0,
		objectivesCreated: 0,
		objectivesDeleted: 0,
		remindersSent: 0,
		autoContinues: 0,
		stallGiveUps: 0,
		blockedStops: 0,
		turnGapsSinceLastUpdate: [],
	};
}

function renderObjectivesBlock(theme: Theme, objectives: Objective[]): string {
	const remaining = objectives.filter((o) => !o.done).length;
	const done = objectives.length - remaining;

	let output = `${theme.fg("toolTitle", theme.bold("update_objectives"))} ${theme.fg("accent", `(${done}/${objectives.length} done, ${remaining} remaining)`)}`;

	if (objectives.length > 0) {
		const lines = objectives.map(
			(o) => `${o.done ? theme.fg("success", "✓") : theme.fg("muted", "✗")} ${o.text}`,
		);
		output += `\n\n${lines.join("\n")}`;
	}

	return output;
}

function renderObjectivesChecklist(objectives: Objective[]): string {
	return objectives.map((o) => `- [${o.done ? "x" : " "}] ${o.text}`).join("\n");
}

// Builds the "+N ", "-N ", " N " line format that Pi's own renderDiff (used
// by the built-in edit tool) expects, so update_objectives diffs get the
// same red/green + intra-line word-highlight rendering as file edits. Mirrors
// generateDiffString from pi-coding-agent's edit-diff.ts (not itself
// exported), minus context truncation — objectives lists are short enough to
// always show in full.
function buildObjectivesDiff(oldObjectives: Objective[], newObjectives: Objective[]): string {
	const toLine = (o: Objective) => `[${o.done ? "x" : " "}] ${o.text}`;
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
	let turnsSinceReminder = 0;
	let lastContinueSignature: string | null = null;
	let stalledContinues = 0;
	let totalTurns = 0;
	let lastUpdateTurn: number | null = null;
	let blockedReason: string | null = null;
	const stats = newStats();

	// Rebuild `objectives` (and the counters derivable from it) by replaying
	// every past update_objectives result on the current branch, in order.
	// Runs on session_start (covers /reload, /resume, and fresh sessions) and
	// session_tree (covers manual /tree navigation onto a different branch).
	const reconstructObjectives = (ctx: ExtensionContext) => {
		objectives = [];
		stats.updateCalls = 0;
		stats.objectivesCreated = 0;
		stats.objectivesDeleted = 0;

		let prevTexts = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "update_objectives") continue;

			const details = msg.details as { objectives?: Objective[] } | undefined;
			if (!details?.objectives) continue;

			const nextTexts = new Set(details.objectives.map((o) => o.text));
			stats.objectivesCreated += [...nextTexts].filter((t) => !prevTexts.has(t)).length;
			stats.objectivesDeleted += [...prevTexts].filter((t) => !nextTexts.has(t)).length;
			stats.updateCalls++;
			prevTexts = nextTexts;

			objectives = details.objectives;
		}

		// Turn numbering restarts on reload/resume, so a stale turn-gap baseline
		// would just produce a misleadingly huge first gap — drop it instead.
		turnsSinceReminder = 0;
		totalTurns = 0;
		lastUpdateTurn = null;
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
			const lines = list.map((o) => `${o.done ? theme.fg("success", "✓") : theme.fg("muted", "✗")} ${o.text}`);
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
			const lines = objectives.map((o) => `- ${o.done ? "✓" : "✗"} ${o.text}`).join("\n");

			pi.appendEntry<ObjectivesBannerData>("objectives-banner", {
				content: `**Objectives** (${done}/${objectives.length} done, ${remaining} remaining)\n\n${lines}`,
			});
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
				`- update_objectives calls: ${stats.updateCalls}`,
				`- Objectives created: ${stats.objectivesCreated}, deleted: ${stats.objectivesDeleted}`,
				`- Turns between updates — avg: ${avgGap}, min: ${minGap}, max: ${maxGap} (n=${gaps.length})`,
				`- System reminders injected mid-task: ${stats.remindersSent}`,
				`- Auto-continues on stop: ${stats.autoContinues} resumed, ${stats.stallGiveUps} gave up (stalled), ${stats.blockedStops} stopped (blocked)`,
			];

			pi.appendEntry<ObjectivesBannerData>("objectives-banner", { content: lines.join("\n") });
		},
	});

	pi.registerTool({
		name: "update_objectives",
		label: "Update Objectives",
		description:
			"Tool for keeping track of objectives for long-running tasks. Call it with the full, " +
			"current list of objectives to set it initially, tick items off as done, or change it as " +
			"the task evolves — each call replaces the previous list.",
		promptSnippet: "Track objectives for long-running tasks",
		promptGuidelines: [
			"Use update_objectives to set and maintain a to-do list on any task that will span many turns. Pass the full, current list each call — it replaces the previous one.",
			"Call update_objectives immediately after finishing each objective, marking it done, before moving on to the next one — don't batch updates until the end.",
			"Call update_objectives to complete items, change existing ones, or add new items if you discover additional work. Don't stop the task before every objective is done.",
		],
		parameters: Type.Object({
			objectives: Type.Array(
				Type.Object({
					text: Type.String({ description: "Short description of the objective" }),
					done: Type.Boolean({ description: "Whether this objective is complete" }),
				}),
				{ description: "Full, current list of objectives — replaces whatever was tracked before" },
			),
		}),
		async execute(_toolCallId, params) {
			const prevObjectives = objectives;
			const prevTexts = new Set(prevObjectives.map((o) => o.text));
			const nextTexts = new Set(params.objectives.map((o) => o.text));
			stats.objectivesCreated += [...nextTexts].filter((t) => !prevTexts.has(t)).length;
			stats.objectivesDeleted += [...prevTexts].filter((t) => !nextTexts.has(t)).length;
			stats.updateCalls++;
			if (lastUpdateTurn !== null) {
				stats.turnGapsSinceLastUpdate.push(totalTurns - lastUpdateTurn);
			}
			lastUpdateTurn = totalTurns;

			const diff = buildObjectivesDiff(prevObjectives, params.objectives);

			objectives = params.objectives;
			turnsSinceReminder = 0;

			const remaining = objectives.filter((o) => !o.done).length;
			return {
				content: [
					{
						type: "text" as const,
						text: `Objectives updated (${objectives.length - remaining}/${objectives.length} done, ${remaining} remaining).`,
					},
				],
				details: { objectives, diff },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			// Once a final result exists, context.isPartial flips to false for both
			// slots — let renderResult own the display and go blank here instead
			// of showing a stale, duplicate copy of the same block.
			if (!context.isPartial) {
				text.setText("");
				return text;
			}

			const rawObjectives = Array.isArray((args as { objectives?: unknown[] } | undefined)?.objectives)
				? (args as { objectives: unknown[] }).objectives
				: [];
			// Args may still be mid-stream — tolerate partially-parsed entries.
			const objectives: Objective[] = rawObjectives.map((o) => ({
				text: typeof (o as { text?: unknown })?.text === "string" ? (o as { text: string }).text : "",
				done: (o as { done?: unknown })?.done === true,
			}));

			text.setText(renderObjectivesBlock(theme, objectives));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			if (result.isError) {
				const output = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n");
				text.setText(output ? theme.fg("error", output) : "");
				return text;
			}

			const details = result.details as { objectives?: Objective[]; diff?: string } | undefined;
			const objectives = details?.objectives ?? [];
			const remaining = objectives.filter((o) => !o.done).length;
			const done = objectives.length - remaining;

			let output = `${theme.fg("toolTitle", theme.bold("update_objectives"))} ${theme.fg("accent", `(${done}/${objectives.length} done, ${remaining} remaining)`)}`;

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
			"not because you are uncertain or want to check in. Provide a specific, concrete reason.",
		parameters: Type.Object({
			reason: Type.String({
				description: "The specific structural or unresolvable blocker preventing further progress",
			}),
		}),
		async execute(_toolCallId, params) {
			blockedReason = params.reason;
			return {
				content: [{ type: "text" as const, text: `Stopped: ${params.reason}` }],
				details: { reason: params.reason },
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("error", theme.bold("objectives_blocked")));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const reason = (result.details as { reason?: string } | undefined)?.reason ?? "";
			text.setText(theme.fg("error", `⛔ ${reason}`));
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
		const list = renderObjectivesChecklist(objectives);

		const reminder = {
			role: "user" as const,
			timestamp: Date.now(),
			content: [
				{
					type: "text" as const,
					text:
						`<system-reminder>\n` +
						`Objectives (${remaining} remaining):\n${list}\n\n` +
						`Keep working autonomously, no confirmation needed. Update objectives as you progress.\n` +
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
			ctx.ui.notify(`update_objectives: stopped — ${blockedReason}`, "error");
			blockedReason = null;
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
				`update_objectives: stopped auto-continuing — ${remaining} objective(s) still pending with no progress in the last ${MAX_STALLED_CONTINUES} attempts.`,
				"warning",
			);
			return;
		}

		stats.autoContinues++;
		turnsSinceReminder = 0;
		const list = renderObjectivesChecklist(objectives);

		pi.sendMessage(
			{
				customType: "objectives-continue",
				content:
					`<system-reminder>\n` +
					`${remaining} objective${remaining === 1 ? "" : "s"} not done:\n${list}\n\n` +
					`Keep going — call \`update_objectives\` as you progress.\n\n` +
					`Only call \`objectives_blocked\` (reason) iff truly stuck — missing/unobtainable credentials, an ` +
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
