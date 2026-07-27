/**
 * Tasks Extension
 *
 * Gives the agent `add_tasks` and `complete_task` tools to track a to-do list
 * for long-running work, and periodically re-injects that list as a
 * <system-reminder> so the model doesn't lose track or stop early.
 *
 * `add_tasks` only appends — it cannot replace, edit, or remove existing
 * items. Each new task carries two model-authored fields:
 *   - `reason`: why the task is needed. Asked once, to force the thought.
 *   - `evidence`: the specific check that will prove *this task alone* is
 *     done. This is the acceptance criterion, and it's the half that gets
 *     repeated back in every reminder.
 * `complete_task` takes a task's ID and the `evidence` actually observed (a
 * command run, a test that passed, a file read back to confirm). Requiring
 * evidence at completion time — instead of just letting the model assert a
 * whole list is done — is a direct countermeasure to the "Rationalization
 * Loophole": a model marking things done because it wants to stop, not
 * because it verified them.
 *
 * The two fields are split because they have different lifetimes. `reason` is
 * prose that only matters when the task is written; the model's own
 * `add_tasks` call arguments stay in the conversation history, so repeating it
 * in every reminder was pure duplication (measured at ~62% of the reminder's
 * bytes, re-sent every few turns). `evidence` earns its place next to the
 * checkbox: it's the criterion the model has to check itself against to
 * decide whether it can complete the task now.
 *
 * Per-task criteria are also what make incremental completion possible at all.
 * If every task's criterion is "the whole suite passes at the end", then no
 * task can be completed until the end, and the model is forced into a single
 * batch of completions whose evidence is reconstructed from memory rather than
 * observed. The tool descriptions push for criteria that are checkable the
 * moment that one task ends.
 *
 * `reason` is deliberately never shown in the chat UI (tool call/result
 * rendering, the /tasks banner) — it's not a status update for the user, it's
 * a commitment the model made to itself. Completion `evidence`, by contrast,
 * IS shown in the chat UI — it's what a human would want to spot-check. It's
 * scoped to verification only (the tool description and guidelines say so
 * explicitly) — a changelog of what was edited belongs in the model's reply,
 * not in this field.
 *
 * The periodic reminder is injected via the `context` event, so it's only
 * visible to the model on the next LLM call — it's never written to the
 * session log or shown in the UI. It lists only what's still pending: a
 * completed task's tool call and result are already in history, evidence and
 * all, so repeating it every few turns spent tokens restating what the model
 * just did.
 *
 * The user's view of progress is the footer status bar (`ui.setStatus`), kept
 * at "tasks done/total" for the life of the list — the whole list is still one
 * `/tasks` away, but the count is always on screen and costs no context.
 *
 * If the agent stops (goes idle) while tasks remain, an `agent_end` handler
 * pushes a real follow-up message telling it to keep going, up to a few
 * attempts before giving up and notifying the user. A run the user aborted
 * (escape) is exempt — that's an interrupt, not the agent deciding it's done,
 * and re-prompting through it would make escape unusable mid-list. That message also mentions
 * a second, deliberately hidden tool — `tasks_blocked` — with specific
 * examples of what counts as a genuine structural blocker (missing
 * credentials, contradictory requirements, decisions only a human can make,
 * irreversible actions needing authorization). It has no promptSnippet or
 * promptGuidelines, so it never appears in the "Available tools"/Guidelines
 * sections — the model only learns about it from that narrow framing, so
 * it isn't reached for as a casual "should I continue?" escape hatch.
 *
 * The task list itself lives in `add_tasks`/`complete_task` tool result
 * `details` fields, which are already part of the persisted session — so on
 * `/reload`, `/resume`, or `/tree` navigation, it's reconstructed by replaying
 * those results on the current branch instead of being lost with the rest of
 * the extension's in-memory state. IDs are `task_N`, sequentially assigned by
 * the tool (never the model), so replay just needs the running count of tasks
 * added since the last clear. Turn-based counters (turnsSinceReminder, stalls,
 * etc.) reset on reload since turn numbering itself restarts — they're
 * session-lifetime telemetry, not functional state.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, renderDiff } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { diffLines } from "diff";
import { Type } from "typebox";

interface Task {
	id: string;
	text: string;
	reason: string;
	// The acceptance criterion, written up front by add_tasks: what check will
	// prove this task is done.
	evidence: string;
	done: boolean;
	// What was actually observed, supplied by complete_task. Distinct from the
	// criterion above so a completed task shows the claim and the proof.
	completedEvidence?: string;
}

interface TasksBannerData {
	content: string;
	// Optional checklist rendered below `content` with themed ✓/✗ markers.
	tasks?: Task[];
}

interface TasksContinueDetails {
	remaining: number;
	tasks: Task[];
}

interface Stats {
	addCalls: number;
	completeCalls: number;
	tasksCreated: number;
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
		tasksCreated: 0,
		remindersSent: 0,
		autoContinues: 0,
		stallGiveUps: 0,
		blockedStops: 0,
		turnGapsSinceLastUpdate: [],
	};
}

// User-facing checklist rendering (chat UI: /tasks banner, the auto-continue
// message). Deliberately omits `reason` — a model-facing commitment, not a
// status update — the up-front `evidence` criterion, which is a promise rather
// than a result, and the task's id, which is just a handle for complete_task.
// Completion evidence IS shown, when asked for: it's what a human would want
// to spot-check.
//
// Always themed, so a done task's ✓ is green everywhere it appears.
function renderTaskLines(theme: Theme, tasks: Task[], showEvidence = false): string {
	return tasks
		.map((t) => {
			const line = `${t.done ? theme.fg("success", "✓") : theme.fg("muted", "✗")} ${t.text}`;
			return showEvidence && t.done && t.completedEvidence
				? `${line}\n  ${theme.fg("muted", t.completedEvidence)}`
				: line;
		})
		.join("\n");
}

// Model-facing rendering (<system-reminder> content only, never shown in the
// chat UI). Only pending tasks are listed — a completed task's complete_task
// call and result are already in history saying so, with the evidence, so
// re-listing it in every reminder spent tokens restating what the model just
// did. What's left is the part it still has to act on.
//
// Each item carries its `evidence` criterion — the check the model committed
// to, repeated back so it can tell whether the task is completable right now.
//
// `reason` is deliberately absent: it's already in the model's own add_tasks
// call arguments, which stay in history, so repeating it here only spent
// tokens.
function renderPendingChecklistForModel(tasks: Task[]): string {
	return tasks
		.filter((t) => !t.done)
		.map((t) => `- [ ] ${t.id} ${t.text}${t.evidence ? ` — evidence: ${t.evidence}` : ""}`)
		.join("\n");
}

// Builds the "+N ", "-N ", " N " line format that Pi's own renderDiff (used
// by the built-in edit tool) expects, so complete_task diffs get the same
// red/green + intra-line word-highlight rendering as file edits. Mirrors
// generateDiffString from pi-coding-agent's edit-diff.ts (not itself
// exported), minus context truncation — task lists are short enough to always
// show in full. Deliberately excludes `reason`/`evidence` from the diffed
// text — those are handled separately by each tool's own renderResult.
//
// add_tasks deliberately doesn't diff: appending only ever produces added
// lines, so the diff was just the new tasks with a `+` — which renderResult
// already lists directly.
function buildTasksDiff(oldTasks: Task[], newTasks: Task[]): string {
	const toLine = (t: Task) => `[${t.done ? "x" : " "}] ${t.text}`;
	const oldText = oldTasks.map(toLine).join("\n");
	const newText = newTasks.map(toLine).join("\n");
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
	let tasks: Task[] = [];
	let nextId = 1;
	let turnsSinceReminder = 0;
	let lastContinueSignature: string | null = null;
	let stalledContinues = 0;
	let totalTurns = 0;
	let lastActivityTurn: number | null = null;
	let blockedReason: string | null = null;
	let blockedIds: string[] = [];
	const stats = newStats();

	// Live "tasks done/total" in the footer status bar. The list is the one bit
	// of state the user otherwise has to run /tasks to see, and the footer shows
	// it continuously for zero context. Cleared when no list is active.
	const updateStatus = (ctx: ExtensionContext) => {
		if (tasks.length === 0) {
			ctx.ui.setStatus("tasks", undefined);
			return;
		}
		const done = tasks.filter((t) => t.done).length;
		ctx.ui.setStatus("tasks", `tasks ${done}/${tasks.length}`);
	};

	const recordActivity = () => {
		if (lastActivityTurn !== null) {
			stats.turnGapsSinceLastUpdate.push(totalTurns - lastActivityTurn);
		}
		lastActivityTurn = totalTurns;
		turnsSinceReminder = 0;
	};

	// Rebuild `tasks`/`nextId` (and the counters derivable from them) by
	// replaying every past add_tasks/complete_task result on the current branch,
	// in order. Runs on session_start (covers /reload, /resume, and fresh
	// sessions) and session_tree (covers manual /tree navigation onto a
	// different branch).
	const reconstructTasks = (ctx: ExtensionContext) => {
		tasks = [];
		nextId = 1;
		stats.addCalls = 0;
		stats.completeCalls = 0;
		stats.tasksCreated = 0;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "tasks-cleared") {
				tasks = [];
				nextId = 1;
				continue;
			}

			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult") continue;

			if (msg.toolName === "add_tasks") {
				const details = msg.details as { added?: Task[] } | undefined;
				if (!details?.added) continue;
				tasks = [...tasks, ...details.added];
				nextId = tasks.length + 1;
				stats.tasksCreated += details.added.length;
				stats.addCalls++;
			} else if (msg.toolName === "complete_task") {
				const details = msg.details as { task?: Task } | undefined;
				if (!details?.task) continue;
				tasks = tasks.map((t) => (t.id === details.task!.id ? details.task! : t));
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

		updateStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstructTasks(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructTasks(ctx));

	// Renderer for the /tasks banner (visible in chat, hidden from tree, never sent to the LLM).
	// A checklist is rendered here rather than inlined into `content` as markdown,
	// so its ✓/✗ markers get themed the same as everywhere else — the Markdown
	// component styles its own text and would swallow the colors.
	pi.registerEntryRenderer<TasksBannerData>("tasks-banner", (entry, _options, theme) => {
		const data = entry.data ?? { content: "" };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Markdown(data.content, 0, 0, getMarkdownTheme()));
		if (data.tasks?.length) {
			box.addChild(new Text(`\n${renderTaskLines(theme, data.tasks, true)}`, 0, 0));
		}
		return box;
	});

	// Renderer for the agent_end auto-continue message — shows a plain summary
	// instead of the raw <system-reminder> XML the model actually receives.
	pi.registerMessageRenderer("tasks-continue", (message, _options, theme) => {
		const details = message.details as TasksContinueDetails | undefined;
		const remaining = details?.remaining ?? 0;
		const list = details?.tasks ?? [];

		let text = theme.fg("accent", `↻ Continuing — ${remaining} task${remaining === 1 ? "" : "s"} remaining`);

		if (list.length > 0) {
			text += `\n\n${renderTaskLines(theme, list)}`;
		}

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// /tasks — show the current list without touching the session/context
	pi.registerCommand("tasks", {
		description: "Show the current task list without sending anything to the model",
		handler: async (_args, ctx) => {
			if (tasks.length === 0) {
				ctx.ui.notify("No tasks tracked yet.", "info");
				return;
			}

			const remaining = tasks.filter((t) => !t.done).length;
			const done = tasks.length - remaining;

			pi.appendEntry<TasksBannerData>("tasks-banner", {
				content: `**Tasks** (${done}/${tasks.length} done, ${remaining} remaining)`,
				tasks,
			});
		},
	});

	// /tasks-clear — drop the current list without touching the session/context
	pi.registerCommand("tasks-clear", {
		description: "Clear the current task list without sending anything to the model",
		handler: async (_args, ctx) => {
			if (tasks.length === 0) {
				ctx.ui.notify("No tasks to clear.", "info");
				return;
			}

			tasks = [];
			nextId = 1;
			turnsSinceReminder = 0;
			lastActivityTurn = null;
			stalledContinues = 0;
			lastContinueSignature = null;

			// Persist the clear so it survives /reload, /resume, and /tree —
			// otherwise reconstructTasks would just replay the old list back from
			// the last add_tasks/complete_task results.
			pi.appendEntry("tasks-cleared", {});

			updateStatus(ctx);
			ctx.ui.notify("Tasks cleared.", "info");
		},
	});

	// /tasks-stats — show tracking statistics without touching the session/context
	pi.registerCommand("tasks-stats", {
		description: "Show task tracking statistics without sending anything to the model",
		handler: async () => {
			const gaps = stats.turnGapsSinceLastUpdate;
			const avgGap = gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : "n/a";
			const minGap = gaps.length ? Math.min(...gaps) : "n/a";
			const maxGap = gaps.length ? Math.max(...gaps) : "n/a";

			const remaining = tasks.filter((t) => !t.done).length;
			const done = tasks.length - remaining;

			const lines = [
				"**Task Stats**",
				"",
				`- Current list: ${tasks.length} tasks (${done} done, ${remaining} remaining)`,
				`- add_tasks calls: ${stats.addCalls} (${stats.tasksCreated} tasks created)`,
				`- complete_task calls: ${stats.completeCalls}`,
				`- Turns between updates — avg: ${avgGap}, min: ${minGap}, max: ${maxGap} (n=${gaps.length})`,
				`- System reminders injected mid-task: ${stats.remindersSent}`,
				`- Auto-continues on stop: ${stats.autoContinues} resumed, ${stats.stallGiveUps} gave up (stalled), ${stats.blockedStops} stopped (blocked)`,
			];

			pi.appendEntry<TasksBannerData>("tasks-banner", { content: lines.join("\n") });
		},
	});

	pi.registerTool({
		name: "add_tasks",
		label: "Add Tasks",
		description:
			"Add new tasks to the tracked to-do list for long-running work. This only appends — it cannot " +
			"edit, reorder, or remove existing tasks. Call it again whenever you discover more work.",
		promptSnippet: "Add tasks to the tracked to-do list for long-running work",
		promptGuidelines: [
			"Use add_tasks to start and grow a to-do list on any job that will span many turns. It only adds — call it again as you discover more work instead of trying to replace the list.",
			"Give each task a `reason` (why it's needed) and an `evidence` criterion: the specific check that will prove that one task is done — a test to write and run, a command and the output you expect from it.",
			"Make each criterion checkable the moment that task ends, not after later tasks land. If several tasks all say 'the full suite passes at the end', none of them can be completed until the end, and you'll be stuck reconstructing evidence from memory instead of reporting what you just saw. Split the verification up so each task carries its own.",
			"This tool assigns each task its ID — use the IDs it returns when calling complete_task. Don't invent your own IDs.",
		],
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					text: Type.String({ description: "Short description of the task" }),
					reason: Type.String({
						description:
							"Why this task is needed. Not shown to the user — this is a commitment you're making to " +
							"yourself, and you'll be asked for real evidence when you call complete_task.",
					}),
					evidence: Type.String({
						description:
							"The check that will prove this task alone is done — the test to write and run, or the command " +
							"and the output you expect. It must be verifiable as soon as this task ends, without waiting " +
							"on later tasks. This criterion is repeated back to you as you work.",
					}),
				}),
				{ minItems: 1, description: "New tasks to append to the list." },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const added: Task[] = params.tasks.map((t) => ({
				id: `task_${nextId++}`,
				text: t.text,
				reason: t.reason,
				evidence: t.evidence,
				done: false,
			}));

			tasks = [...tasks, ...added];
			stats.tasksCreated += added.length;
			stats.addCalls++;
			recordActivity();
			updateStatus(ctx);

			const remaining = tasks.filter((t) => !t.done).length;

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Added ${added.length} task${added.length === 1 ? "" : "s"}: ` +
							`${added.map((t) => `${t.id} ${t.text}`).join(", ")}. ` +
							`(${tasks.length - remaining}/${tasks.length} done, ${remaining} remaining)`,
					},
				],
				details: { tasks, added },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			if (!context.isPartial) {
				text.setText("");
				return text;
			}

			const rawTasks = Array.isArray((args as { tasks?: unknown[] } | undefined)?.tasks)
				? (args as { tasks: unknown[] }).tasks
				: [];
			const items = rawTasks.map((t) =>
				typeof (t as { text?: unknown })?.text === "string" ? (t as { text: string }).text : "",
			);

			let output = theme.fg("toolTitle", theme.bold("add_tasks"));
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

			const details = result.details as { tasks?: Task[]; added?: Task[] } | undefined;
			const all = details?.tasks ?? [];
			const added = details?.added ?? [];
			const remaining = all.filter((t) => !t.done).length;
			const done = all.length - remaining;

			let output = `${theme.fg("toolTitle", theme.bold("add_tasks"))} ${theme.fg("accent", `(+${added.length}, ${done}/${all.length} done)`)}`;

			if (added.length > 0) {
				const lines = added.map((t) => `${theme.fg("success", "+")} ${t.text}`);
				output += `\n\n${lines.join("\n")}`;
			}

			text.setText(output);
			return text;
		},
	});

	pi.registerTool({
		name: "complete_task",
		label: "Complete Task",
		description: "Mark a tracked task done, with evidence of what you observed proving it.",
		promptSnippet: "Mark a tracked task done with evidence",
		promptGuidelines: [
			"Run the task's evidence check as its last step, then call complete_task immediately — before starting the next task. Don't batch completions at the end; if a task can't be completed until later work lands, its criterion was written wrong.",
			"`evidence` = what you actually saw: the command and its output, the test that passed, the file you read back — not what you believe, and not a changelog of what you changed (that belongs in your reply to the user, not here). Believing a task is probably done is rationalizing, not verifying.",
			"Failing check: fix the issue, don't complete it. Impossible or no-longer-applicable task: call tasks_blocked instead of completing it with an excuse.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "ID of the task to complete, as returned by add_tasks" }),
			evidence: Type.String({
				description:
					"What you observed proving this is done (command + output, passing test, file read back) — " +
					"not a changelog of changes made. Shown to the user for spot-checking.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const idx = tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) {
				const ids = tasks.map((t) => t.id).join(", ") || "(none)";
				throw new Error(`No task with id "${params.id}". Current ids: ${ids}`);
			}
			if (tasks[idx].done) {
				throw new Error(`Task ${params.id} ("${tasks[idx].text}") is already marked done.`);
			}

			const prevTasks = tasks;
			const updated: Task = { ...tasks[idx], done: true, completedEvidence: params.evidence };
			tasks = tasks.map((t, i) => (i === idx ? updated : t));
			stats.completeCalls++;
			recordActivity();
			updateStatus(ctx);

			const diff = buildTasksDiff(prevTasks, tasks);
			const remaining = tasks.filter((t) => !t.done).length;

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Completed ${updated.id} — ${updated.text}. ` +
							`(${tasks.length - remaining}/${tasks.length} done, ${remaining} remaining)`,
					},
				],
				details: { tasks, diff, task: updated },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			if (!context.isPartial) {
				text.setText("");
				return text;
			}

			const id = typeof (args as { id?: unknown } | undefined)?.id === "string" ? (args as { id: string }).id : "";
			// Only the id streams in, so resolve it to the task's text — ids are a
			// model-facing handle and aren't shown to the user.
			const label = id ? (tasks.find((t) => t.id === id)?.text ?? "") : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("complete_task"))} ${theme.fg("accent", label)}`);
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

			const details = result.details as { tasks?: Task[]; diff?: string; task?: Task } | undefined;
			const all = details?.tasks ?? [];
			const remaining = all.filter((t) => !t.done).length;
			const done = all.length - remaining;
			const completed = details?.task;

			let output = `${theme.fg("toolTitle", theme.bold("complete_task"))} ${theme.fg("accent", `(${done}/${all.length} done)`)}`;

			if (completed?.completedEvidence) {
				output += `\n${theme.fg("success", "✓")} ${completed.text}\n  ${theme.fg("muted", completed.completedEvidence)}`;
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
		name: "tasks_blocked",
		label: "Tasks Blocked",
		description:
			"Stop the task auto-continue loop because it is structurally impossible to proceed — not because " +
			"you are uncertain or want to check in. Provide a specific, concrete reason and the ids of the " +
			"tasks you're blocked on.",
		parameters: Type.Object({
			reason: Type.String({
				description: "The specific structural or unresolvable blocker preventing further progress",
			}),
			ids: Type.Array(Type.String(), { description: "IDs of the tasks you are blocked on" }),
		}),
		async execute(_toolCallId, params) {
			blockedReason = params.reason;
			blockedIds = params.ids;
			const idList = params.ids.map((id) => id).join(", ") || "(none)";
			return {
				content: [{ type: "text" as const, text: `Stopped: ${params.reason} (blocked on: ${idList})` }],
				details: { reason: params.reason, ids: params.ids },
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("error", theme.bold("tasks_blocked")));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as { reason?: string; ids?: string[] } | undefined;
			const reason = details?.reason ?? "";
			const names = (details?.ids ?? [])
				.map((id) => {
					const t = tasks.find((task) => task.id === id);
					return t ? t.text : id;
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
		const remaining = tasks.filter((t) => !t.done).length;
		// Nothing pending means nothing to remind about — the reminder lists only
		// pending tasks, so with an all-done list it would just be a header.
		if (remaining === 0) return;
		if (turnsSinceReminder < REMINDER_EVERY_N_TURNS) return;

		turnsSinceReminder = 0;
		stats.remindersSent++;

		const list = renderPendingChecklistForModel(tasks);

		const reminder = {
			role: "user" as const,
			timestamp: Date.now(),
			content: [
				{
					type: "text" as const,
					text:
						`<system-reminder>\n` +
						`Tasks (${remaining} remaining):\n${list}\n\n` +
						`Keep working autonomously, no confirmation needed. As each task ends, run its evidence check and ` +
						`call complete_task with what you observed — one task at a time, not a batch at the end. Call ` +
						`add_tasks if you discover more work.\n` +
						`</system-reminder>`,
				},
			],
		};

		return { messages: [...event.messages, reminder] };
	});

	// The agent stopped and is about to go idle — if tasks remain, push it to
	// keep going instead of waiting for the user. Bails out after a few stalled
	// attempts in a row (no change in task state) so a genuinely stuck or
	// blocked model doesn't spin forever unattended.
	pi.on("agent_end", async (event, ctx) => {
		// The user hit escape: this run was interrupted, not finished. Auto-continue
		// exists to stop the model from going idle on its own — overriding an
		// explicit interrupt would make escape unusable while a list is active.
		// Leave the list and the stall counters untouched, so whenever the user
		// does resume, the loop picks up exactly where it was.
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		if (lastAssistant?.stopReason === "aborted") return;

		if (blockedReason) {
			stats.blockedStops++;
			const names = blockedIds.map((id) => tasks.find((t) => t.id === id)?.text ?? id).join(", ");
			ctx.ui.notify(`tasks_blocked: ${blockedReason}${names ? ` (blocked on: ${names})` : ""}`, "error");
			blockedReason = null;
			blockedIds = [];
			stalledContinues = 0;
			lastContinueSignature = null;
			return;
		}

		const remaining = tasks.filter((t) => !t.done).length;
		if (remaining === 0) {
			stalledContinues = 0;
			lastContinueSignature = null;
			return;
		}

		const signature = JSON.stringify(tasks);
		if (signature === lastContinueSignature) {
			stalledContinues++;
		} else {
			stalledContinues = 0;
		}
		lastContinueSignature = signature;

		if (stalledContinues >= MAX_STALLED_CONTINUES) {
			stats.stallGiveUps++;
			ctx.ui.notify(
				`tasks: stopped auto-continuing — ${remaining} task(s) still pending with no progress in the last ${MAX_STALLED_CONTINUES} attempts.`,
				"warning",
			);
			return;
		}

		stats.autoContinues++;
		turnsSinceReminder = 0;
		const list = renderPendingChecklistForModel(tasks);

		pi.sendMessage(
			{
				customType: "tasks-continue",
				content:
					`<system-reminder>\n` +
					`${remaining} task${remaining === 1 ? "" : "s"} not done:\n${list}\n\n` +
					`Keep going — take the next task, run its evidence check as its last step, and call ` +
					`\`complete_task\` (id, evidence) with what you observed before starting the one after it. Call ` +
					`\`add_tasks\` if you discover more work.\n\n` +
					`Only call \`tasks_blocked\` (reason, ids) iff truly stuck — missing/unobtainable credentials, an ` +
					`unreachable dependency, contradictory requirements, a decision only a human can make, or an ` +
					`irreversible action needing authorization. Uncertainty, wanting confirmation, or asking whether ` +
					`to continue long-running work are not blocks — keep working.\n` +
					`</system-reminder>`,
				display: true,
				details: { remaining, tasks } as TasksContinueDetails,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
