/**
 * Plan Extension
 *
 * Global extension that provides a /plan command for structured planning.
 *
 * Flow:
 *   1. User types `/plan <description>`
 *   2. Extension injects planning instructions into the next agent turn
 *   3. Agent researches, writes a plan, and calls save_plan
 *   4. save_plan writes to <cwd>/.pi/plans/<slug>.md and opens the external editor
 *
 * Plan format follows a generic structure: Problem, Solution, numbered areas,
 * tests table, files list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { platform } from "os";

// --- Planning instructions ---

const PLANNING_INSTRUCTIONS = `**Plan Mode**

You are in plan mode. Follow this workflow:

1. **Research**: Read relevant files, run grep/bash/find to understand the codebase.
2. **Write the plan**: Create a detailed plan using the format below.
3. **Save**: Call \`save_plan\` with the complete plan content. Choose a descriptive kebab-case filename slug (e.g. \`add-utf-8-slicing\`, \`refactor-event-bus\`).
4. End your response with "Want me to proceed?"

### Plan Format

\`\`\`markdown
# <Title>

**Problem**: 1-2 sentences on what's broken or what's needed.

**Solution**: 1-2 sentences on the approach.

---

#### 1. Area: description

Numbered steps or bullet points. Be specific about struct changes, new functions, enum values, etc.

#### 2. Area: description

...

#### N. Tests

| Test | Description |

#### N+1. Files

- \`path/to/file\` — one-line summary of changes
\`\`\`

Be thorough. Specificity beats brevity.`;

// --- Editor resolution ---

function resolveEditor(): string {
	if (process.env.VISUAL) return process.env.VISUAL;
	if (process.env.EDITOR) return process.env.EDITOR;
	return platform() === "win32" ? "notepad" : "nano";
}

function spawnEditor(filePath: string, cwd: string): boolean {
	try {
		const editorCmd = resolveEditor();
		// Handle commands with arguments (e.g. "code --wait")
		const [cmd, ...args] = editorCmd.split(/\s+/);
		const child = spawn(cmd, [...args, filePath], {
			detached: true,
			stdio: "ignore",
			cwd,
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

// --- Banner data type ---

interface PlanBannerData {
	content: string;
}

// --- Extension ---

export default function (pi: ExtensionAPI): void {
	// Register renderer for plan banner (visible in chat, hidden from tree)
	pi.registerEntryRenderer<PlanBannerData>("plan-banner", (entry, _options, theme) => {
		const data = entry.data ?? { content: "" };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(data.content, 0, 0));
		return box;
	});

	// Register /plan command
	pi.registerCommand("plan", {
		description: "Start planning — research, write a plan to .pi/plans/, and open your editor",
		handler: async (args, ctx) => {
			const description = args.trim();
			if (!description) {
				ctx.ui.notify("Usage: /plan <description>", "warning");
				return;
			}

			// Truncate long descriptions for the confirmation banner
			const MAX_DESC = 80;
			const shortDesc = description.length > MAX_DESC ? `${description.slice(0, MAX_DESC)}…` : description;

			// 1. Confirmation banner (visible in chat, hidden from tree, not sent to LLM)
			pi.appendEntry<PlanBannerData>("plan-banner", {
				content: `📋 **Plan mode** — researching and planning: *${shortDesc}*\n\nPlan will be saved to \`.pi/plans/\``,
			});

			// 2. Skill / guidance (in context, hidden from UI)
			pi.sendMessage(
				{
					customType: "plan-instructions",
					content: PLANNING_INSTRUCTIONS,
					display: false,
				},
				{ triggerTurn: false },
			);

			// 3. Prompt (in context, hidden from UI) — triggers the agent turn.
			// Content is the original command so /tree rewind restores it.
			pi.sendMessage(
				{
					customType: "plan-prompt",
					content: `/plan ${description}`,
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});

	// Register save_plan tool
	pi.registerTool({
		name: "save_plan",
		label: "Save Plan",
		description:
			"Save the plan to .pi/plans/<slug>.md and open it in the external editor. " +
			"Call this with the complete plan content once planning is done.",
		parameters: Type.Object({
			slug: Type.String({ description: "Filename slug (without .md extension). Choose a descriptive, kebab-case name like 'add-utf-8-slicing'." }),
			content: Type.String({ description: "Full markdown content of the plan" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const slug = params.slug ?? `plan-${Date.now()}`;
			const planDir = join(ctx.cwd, ".pi", "plans");
			const filePath = join(planDir, `${slug}.md`);

			// Ensure directory exists
			mkdirSync(planDir, { recursive: true });

			// Write plan file
			writeFileSync(filePath, params.content, "utf-8");

			// Open editor inline (same window as Pi) — TUI stop/spawn/start
			let editorOpened = false;

			if (ctx.mode === "tui" && ctx.hasUI) {
				const editorCmd = resolveEditor();
				const [cmd, ...args] = editorCmd.split(/\s+/);

				let tuiRef: { stop: () => void; start: () => void; requestRender: (full?: boolean) => void } | undefined;

				await ctx.ui.custom((tui, _theme, _keybindings, done) => {
					tuiRef = tui as { stop: () => void; start: () => void; requestRender: (full?: boolean) => void };

					setImmediate(async () => {
						try {
							tuiRef?.stop();

							const child = spawn(cmd, [...args, filePath], {
								stdio: "inherit",
								cwd: ctx.cwd,
							});

							await new Promise<void>((resolve) => {
								child.on("close", () => resolve());
								child.on("error", () => resolve());
							});

							tuiRef?.start();
							tuiRef?.requestRender(true);
						} catch {
							try { tuiRef?.start(); tuiRef?.requestRender(true); } catch {}
						} finally {
							done();
						}
					});

					const { Container } = require("@earendil-works/pi-tui");
					return new Container();
				}, { overlay: true });

				editorOpened = true;
			} else {
				editorOpened = spawnEditor(filePath, ctx.cwd);
			}

			return {
				content: [
					{
						type: "text",
						text: [
							`✅ Plan saved to \`.pi/plans/${slug}.md\``,
							editorOpened ? `\nOpened in editor (\`${resolveEditor()}\`)` : `\nEditor spawn skipped — open \`.pi/plans/${slug}.md\` manually`,
						].join(""),
					},
				],
				details: { path: filePath },
			};
		},
		renderCall(args, theme, context) {
			const slug = typeof args?.slug === "string" ? args.slug : "unknown";
			const content = typeof args?.content === "string" ? args.content : null;
			const path = `.pi/plans/${slug}.md`;

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			let output = `${theme.fg("toolTitle", theme.bold("save_plan"))} ${path}`;

			if (content !== null && content) {
				const lang = getLanguageFromPath(".md");
				const lines = lang
					? highlightCode(content, lang)
					: content.split("\n");

				const totalLines = lines.length;
				const maxLines = context.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				output += `\n\n${displayLines.join("\n")}`;

				if (remaining > 0) {
					output += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
				}
			}

			text.setText(output);
			return text;
		},
	});

}
