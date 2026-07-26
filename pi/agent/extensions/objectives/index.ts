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
 * a few attempts before giving up and notifying the user.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Objective {
	text: string;
	done: boolean;
}

interface ObjectivesBannerData {
	content: string;
}

interface Stats {
	updateCalls: number;
	objectivesCreated: number;
	objectivesDeleted: number;
	remindersSent: number;
	autoContinues: number;
	stallGiveUps: number;
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
	const stats = newStats();

	// Renderer for the /objectives banner (visible in chat, hidden from tree, never sent to the LLM)
	pi.registerEntryRenderer<ObjectivesBannerData>("objectives-banner", (entry, _options, theme) => {
		const data = entry.data ?? { content: "" };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Markdown(data.content, 0, 0, getMarkdownTheme()));
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
				`- Auto-continues on stop: ${stats.autoContinues} resumed, ${stats.stallGiveUps} gave up (stalled)`,
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
			"Call update_objectives to add or change items as the task evolves. Don't stop the task before every objective is done.",
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
			const prevTexts = new Set(objectives.map((o) => o.text));
			const nextTexts = new Set(params.objectives.map((o) => o.text));
			stats.objectivesCreated += [...nextTexts].filter((t) => !prevTexts.has(t)).length;
			stats.objectivesDeleted += [...prevTexts].filter((t) => !nextTexts.has(t)).length;
			stats.updateCalls++;
			if (lastUpdateTurn !== null) {
				stats.turnGapsSinceLastUpdate.push(totalTurns - lastUpdateTurn);
			}
			lastUpdateTurn = totalTurns;

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
				details: { objectives },
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

			const objectives = (result.details as { objectives?: Objective[] } | undefined)?.objectives ?? [];
			text.setText(renderObjectivesBlock(theme, objectives));
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
						`This is a long-running task — keep working autonomously and do not stop to ask for ` +
						`confirmation. Call \`update_objectives\` as you make progress, and continue until every ` +
						`item is done.\n` +
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

		pi.sendUserMessage(
			`<system-reminder>\n` +
				`You stopped, but ${remaining} objective${remaining === 1 ? "" : "s"} ${remaining === 1 ? "is" : "are"} still not done:\n${list}\n\n` +
				`Continue working autonomously — call \`update_objectives\` as you make progress, and only stop once every item is done or you're genuinely blocked.\n` +
				`</system-reminder>`,
			{ deliverAs: "followUp" },
		);
	});
}
