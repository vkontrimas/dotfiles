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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { platform } from "os";

interface PlanState {
	mode: boolean;
	description: string;
	slug: string;
}

const state: PlanState = { mode: false, description: "", slug: "" };

// --- Slugify helper ---

function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			// Replace spaces and common separators with hyphens
			.replace(/[\s/_]+/g, "-")
			// Strip non-alphanumeric except hyphens
			.replace(/[^a-z0-9-]/g, "")
			// Collapse multiple hyphens
			.replace(/-+/g, "-")
			// Trim leading/trailing hyphens
			.replace(/^-+|-+$/g, "")
	);
}

// --- Planning instructions ---

const PLANNING_INSTRUCTIONS = `You are in **plan mode**. Follow this workflow:

1. **Research**: Read relevant files, run grep/bash/find to understand the codebase.
2. **Write the plan**: Create a detailed plan using the format below.
3. **Save**: Call \`save_plan\` with the complete plan content.
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

// --- Extension ---

export default function (pi: ExtensionAPI): void {
	// Register /plan command
	pi.registerCommand("plan", {
		description: "Start planning — research, write a plan to .pi/plans/, and open your editor",
		handler: async (args, ctx) => {
			const description = args.trim();
			if (!description) {
				ctx.ui.notify("Usage: /plan <description>", "warning");
				return;
			}

			const slug = slugify(description);
			state.mode = true;
			state.description = description;
			state.slug = slug;

			// Confirmation message (visible in chat)
			pi.sendMessage(
				{
					customType: "plan-mode",
					content: `📋 **Plan mode** — researching and planning: *${description}*\n\nPlan will be saved to \`.pi/plans/${slug}.md\``,
					display: true,
				},
				{ triggerTurn: false },
			);

			// Send the planning prompt to the agent
			pi.sendUserMessage(`Create a plan for: ${description}`);
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
			slug: Type.Optional(Type.String({ description: "Filename slug (without .md extension)" })),
			content: Type.String({ description: "Full markdown content of the plan" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const slug = params.slug ?? state.slug ?? `plan-${Date.now()}`;
			const planDir = join(ctx.cwd, ".pi", "plans");
			const filePath = join(planDir, `${slug}.md`);

			// Ensure directory exists
			mkdirSync(planDir, { recursive: true });

			// Write plan file
			writeFileSync(filePath, params.content, "utf-8");

			// Open external editor
			const editorOpened = spawnEditor(filePath, ctx.cwd);

			return {
				content: [
					{
						type: "text",
						text: [
							`✅ Plan saved to \`.pi/plans/${slug}.md\``,
							editorOpened ? `\nOpened in external editor (\`${resolveEditor()}\`)` : `\nEditor spawn skipped — open \`.pi/plans/${slug}.md\` manually`,
						].join(""),
					},
				],
				details: { path: filePath },
			};
		},
	});

	// Inject planning instructions when plan mode is active
	pi.on("before_agent_start", async (event) => {
		if (!state.mode) return;

		// Reset immediately so this fires only once per /plan invocation
		state.mode = false;

		return {
			message: {
				customType: "plan-instructions",
				content: PLANNING_INSTRUCTIONS,
				display: false,
			},
		};
	});
}
