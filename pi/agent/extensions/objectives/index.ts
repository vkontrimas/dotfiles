/**
 * Objectives Extension
 *
 * Gives the agent a `update_objectives` tool to track a to-do list for
 * long-running tasks, and periodically re-injects that list as a
 * <system-reminder> so the model doesn't lose track or stop early.
 *
 * The reminder is injected via the `context` event, so it's only visible
 * to the model on the next LLM call — it's never written to the session
 * log or shown in the UI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Objective {
	text: string;
	done: boolean;
}

// How many turns to let pass between reminders.
const REMINDER_EVERY_N_TURNS = 5;

export default function (pi: ExtensionAPI): void {
	let objectives: Objective[] = [];
	let turnsSinceReminder = 0;

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
		renderCall(_args, _theme, context) {
			// Everything is shown in renderResult instead — an empty Text renders
			// as zero lines, so no separate (and redundant) call row appears.
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText("");
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
			const remaining = objectives.filter((o) => !o.done).length;
			const done = objectives.length - remaining;

			let output = `${theme.fg("toolTitle", theme.bold("update_objectives"))} ${theme.fg("accent", `(${done}/${objectives.length} done, ${remaining} remaining)`)}`;

			if (objectives.length > 0) {
				const lines = objectives.map(
					(o) => `${o.done ? theme.fg("success", "✓") : theme.fg("muted", "✗")} ${o.text}`,
				);
				output += `\n\n${lines.join("\n")}`;
			}

			text.setText(output);
			return text;
		},
	});

	pi.on("turn_start", async () => {
		turnsSinceReminder++;
	});

	pi.on("context", async (event) => {
		if (objectives.length === 0) return;
		if (turnsSinceReminder < REMINDER_EVERY_N_TURNS) return;

		turnsSinceReminder = 0;

		const remaining = objectives.filter((o) => !o.done).length;
		const list = objectives.map((o) => `- [${o.done ? "x" : " "}] ${o.text}`).join("\n");

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
}
