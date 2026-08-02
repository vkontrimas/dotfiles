/**
 * Plan Extension
 *
 * Global extension that provides a /plan command for structured planning.
 *
 * Flow:
 *   1. User types `/plan <description>`
 *   2. Extension injects planning instructions into the next agent turn
 *   3. Agent researches, writes the plan to <cwd>/.pi/plans/<slug>.md with its normal write/edit tools
 *   4. Agent calls present_plan, which opens the file in the external editor and shows it in chat
 *   5. Agent can keep editing the file directly and call present_plan again to re-show it —
 *      no need to round-trip the whole plan content through a tool call each time
 *   6. present_plan tracks the content it last showed (per file, in-memory for the
 *      session) and, on every call, diffs the on-disk content against that baseline
 *      before doing anything else (ignoring line-ending and trailing-newline
 *      differences, which editors introduce on write without the user touching
 *      anything). If it differs — because the user edited it in the
 *      inline editor during a prior call, or touched the file some other way between
 *      calls — the tool result says so and includes a short summary, so the agent
 *      doesn't blindly assume the file still matches what it last wrote or read.
 *
 * The actual instructions live in `pi/agent/skills/planning.md` — a skill with
 * `disable-model-invocation: true` so it never surfaces in the model's own
 * `<available_skills>` listing (this flow assumes /plan's scaffolding — the
 * confirmation banner, the plan-prompt message — is already driving it; letting
 * the model self-invoke it outside that scaffolding would be half-wired). It's
 * read once at module load and injected verbatim, frontmatter stripped.
 *
 * Before any of that, `/plan` also decides what to do with a task list left
 * over from a previous plan (see `maybeClearStaleTasks` below) — a fully
 * finished list is cleared automatically, a partial one is either confirmed
 * or left alone depending on what's available. This is a soft dependency on
 * two other extensions, done with real imports/APIs rather than string-based
 * detection:
 *   - `pi-tasks` (the `tasks` extension) is a local, first-party package —
 *     declared as an `optionalDependency` in package.json (`file:../tasks`)
 *     and imported directly via a dynamic `import("pi-tasks")` at module
 *     load. If it's not linked/installed, `tasksApi` stays `null` and this
 *     whole feature is skipped, no `/plan` behavior changes.
 *   - `pi-ask-user` (the `ask_user` tool) is a vendored third-party npm
 *     package with no exports at all — nothing beyond its default Pi-loader
 *     factory function is importable without forking it. So instead of
 *     using its tool (which would mean going through the LLM), this calls
 *     `ctx.ui.confirm` directly — the same first-party
 *     `@earendil-works/pi-coding-agent` SDK primitive `ask_user` itself is
 *     built on — gated on `pi.getActiveTools().includes("ask_user")` as a
 *     presence signal for whether the user wants this kind of interactive
 *     prompt at all.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, getMarkdownTheme, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { platform } from "os";

// Soft dependency on the local `pi-tasks` extension — see the module-level
// comment above. A dynamic import (not a static one) so a missing/unlinked
// package degrades to `null` instead of throwing at module load and taking
// this whole extension down with it.
let tasksApi: typeof import("pi-tasks") | null = null;
try {
	tasksApi = await import("pi-tasks");
} catch {
	tasksApi = null;
}

// Decides what to do with a task list left over from a previous plan, before
// a new one starts. Never blocks `/plan` itself — it only decides whether to
// clear, ask, or leave the list alone first.
async function maybeClearStaleTasks(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!tasksApi) return;

	const { total, remaining } = tasksApi.getTaskCounts();
	if (total === 0) return;

	if (remaining === 0) {
		// Fully done (or cancelled) — nothing a user would want to review, so
		// this is the one case that's silent and automatic.
		tasksApi.clearAllTasks(ctx);
		return;
	}

	if (pi.getActiveTools().includes("ask_user")) {
		const shouldClear = await ctx.ui.confirm(
			"Pending tasks",
			`${remaining} task${remaining === 1 ? "" : "s"} still pending from a previous list. Clear them before starting this plan?`,
		);
		if (shouldClear) tasksApi.clearAllTasks(ctx);
		return;
	}

	// No interactive-prompt extension available — don't guess, just say so.
	ctx.ui.notify(
		`${remaining} task${remaining === 1 ? "" : "s"} pending from a previous list — run /tasks-clear to clear them manually.`,
		"info",
	);
}

// --- Planning instructions (loaded from the planning skill) ---

function stripFrontmatter(content: string): string {
	const m = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
	return (m ? m[1] : content).trim();
}

const SKILL_PATH = join(__dirname, "..", "..", "skills", "planning.md");
const PLANNING_INSTRUCTIONS = stripFrontmatter(readFileSync(SKILL_PATH, "utf-8"));

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

// --- Presented-content tracking ---
//
// Keyed by absolute plan file path, holds the content as of the end of the
// last present_plan call for that file. In-memory only (per session) — good
// enough since a fresh process has no prior presentation to compare against.
const presentedContent = new Map<string, string>();

// Editors normalize on write, and that normalization is not a user edit.
// Neovim's 'fixendofline' (default on) appends a final newline to a file that
// lacks one, so a bare `:wq` over an agent-written plan that ended without a
// trailing newline changes a byte and would otherwise be reported as feedback
// — once per plan, the first time it's opened. Comparisons run on this form;
// the baseline and everything shown to the agent stay as the raw file content.
function normalizeForCompare(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

// Short, human-readable description of where two versions of a file first
// diverge. Not a real diff — just enough for the agent to know something
// changed and roughly where, without spending tokens on a full unified diff.
function summarizeChange(oldContent: string, newContent: string): string {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	let i = 0;
	while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) i++;
	return `first difference at line ${i + 1} (was ${oldLines.length} lines, now ${newLines.length} lines)`;
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
		box.addChild(new Markdown(data.content, 0, 0, getMarkdownTheme()));
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

			await maybeClearStaleTasks(pi, ctx);

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

	// Register present_plan tool
	pi.registerTool({
		name: "present_plan",
		label: "Present Plan",
		description:
			"Present a plan you've already written to .pi/plans/<slug>.md with your normal write/edit tools. " +
			"Opens it in the external editor and shows it in chat. Call this again after editing the file " +
			"directly to re-present a revised version — you don't need to pass the plan content through this tool. " +
			"If the file changed since it was last presented (e.g. the user edited it in the editor), the result " +
			"flags that and returns the current on-disk content — re-read it before assuming the plan still says " +
			"what you last wrote.",
		parameters: Type.Object({
			slug: Type.String({ description: "Filename slug (without .md extension) of the plan file you wrote, e.g. 'add-utf-8-slicing'." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const slug = params.slug;
			const planDir = join(ctx.cwd, ".pi", "plans");
			const filePath = join(planDir, `${slug}.md`);

			let content: string;
			try {
				content = readFileSync(filePath, "utf-8");
			} catch {
				throw new Error(
					`Could not read ${filePath}. Write the plan there with your normal write tool first, then call present_plan.`,
				);
			}

			// Content differing from what this tool last showed means someone (most
			// likely the user, via the inline editor from a prior call) touched the
			// file since then. Note it now; the editor session below can still change
			// things further, so the final comparison happens after that.
			const previouslyPresented = presentedContent.get(filePath);
			const editedBeforeThisCall =
				previouslyPresented !== undefined && normalizeForCompare(previouslyPresented) !== normalizeForCompare(content);
			const editedBeforeThisCallSummary = editedBeforeThisCall ? summarizeChange(previouslyPresented!, content) : null;

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
							done(undefined);
						}
					});

					const { Container } = require("@earendil-works/pi-tui");
					return new Container();
				}, { overlay: true });

				editorOpened = true;
			} else {
				editorOpened = spawnEditor(filePath, ctx.cwd);
			}

			// The TUI branch blocks until the editor closes, so re-read now to pick up
			// anything the user changed and saved during this call's editing session.
			// (The detached spawnEditor branch doesn't block, so this is a no-op there —
			// any edits made in that background editor will only surface on the *next*
			// present_plan call, via the editedBeforeThisCall check above.)
			let finalContent = content;
			if (ctx.mode === "tui" && ctx.hasUI) {
				try {
					finalContent = readFileSync(filePath, "utf-8");
				} catch {
					finalContent = content;
				}
			}
			const editedDuringThisCall = normalizeForCompare(finalContent) !== normalizeForCompare(content);

			presentedContent.set(filePath, finalContent);

			const editNotes: string[] = [];
			if (editedBeforeThisCall) {
				editNotes.push(`⚠️ This plan was edited since it was last presented (${editedBeforeThisCallSummary}).`);
			}
			if (editedDuringThisCall) {
				editNotes.push(`⚠️ The plan was edited in the editor just now (${summarizeChange(content, finalContent)}). The content below reflects those edits.`);
			}

			return {
				content: [
					{
						type: "text",
						text: [
							`📋 Presenting \`.pi/plans/${slug}.md\``,
							editorOpened ? `\nOpened in editor (\`${resolveEditor()}\`)` : `\nEditor spawn skipped — open \`.pi/plans/${slug}.md\` manually`,
							...editNotes.map((note) => `\n\n${note}`),
						].join(""),
					},
				],
				details: { path: filePath, content: finalContent },
			};
		},
		renderCall(args, theme, context) {
			const slug = typeof args?.slug === "string" ? args.slug : "unknown";
			const path = `.pi/plans/${slug}.md`;

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${theme.fg("toolTitle", theme.bold("present_plan"))} ${path}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			const resultText = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text || "")
				.join("\n");

			if (context.isError) {
				text.setText(resultText ? `\n${theme.fg("error", resultText)}` : "");
				return text;
			}

			const content = typeof (result.details as { content?: unknown } | undefined)?.content === "string"
				? (result.details as { content: string }).content
				: null;

			let output = `\n${resultText}`;

			if (content) {
				const lang = getLanguageFromPath(".md");
				const lines = lang ? highlightCode(content, lang) : content.split("\n");

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
