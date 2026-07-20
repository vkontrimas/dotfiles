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
import { Type } from "typebox";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { platform } from "os";

interface PlanState {
	mode: boolean;
	description: string;
}

const state: PlanState = { mode: false, description: "" };

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

			state.mode = true;
			state.description = description;

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
				display: true,
			},
		};
	});
}
