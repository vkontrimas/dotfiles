/**
 * seqagent — Spawn multiple subagents sequentially.
 *
 * Each agent runs in its own `pi` process (headless JSON mode) so VRAM
 * frees between agents. Progress is streamed via onUpdate and rendered
 * as a clean status list.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getMarkdownTheme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";

// ── Types ──────────────────────────────────────────────────────────────────

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface StepResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: {
    input: number;
    output: number;
    turns: number;
    toolCalls: number;
    model?: string;
  };
  stopReason?: string;
  errorMessage?: string;
}

type StepStatus = "pending" | "running" | "done" | "error";

interface SeqagentDetails {
  steps: Array<StepResult & { status: StepStatus }>;
  currentIndex: number;
  frame: number;          // animation frame counter
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsage(u: StepResult["usage"]): string {
  const parts: string[] = [];
  if (u.toolCalls) parts.push(`${u.toolCalls} calls`);
  if (u.input || u.output) parts.push(`${formatTokens(u.input + u.output)} tok`);
  return parts.join(" ");
}

function formatTotalStats(steps: Array<{ usage: StepResult["usage"] }>, errors: number): string {
  const parts: string[] = [];
  const totalCalls = steps.reduce((a, s) => a + s.usage.toolCalls, 0);
  const totalTok = steps.reduce((a, s) => a + s.usage.input + s.usage.output, 0);
  if (totalCalls) parts.push(`${totalCalls} calls`);
  if (totalTok) parts.push(`${formatTokens(totalTok)} tok`);
  if (errors) parts.push(`${errors} failed`);
  return parts.join(" ");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

async function writeTempPrompt(name: string, text: string): Promise<{ file: string; dir: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "seqagent-"));
  const file = path.join(dir, `${name.replace(/[^a-zA-Z0-9.-]/g, "_")}.md`);
  await withFileMutationQueue(file, () =>
    fs.promises.writeFile(file, text, { encoding: "utf-8", mode: 0o600 }),
  );
  return { file, dir };
}

// ── Run a single agent ─────────────────────────────────────────────────────

interface RunOptions {
  agent: AgentConfig;
  task: string;
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: (result: StepResult) => void;
}

async function runAgent({ agent, task, cwd, signal, onUpdate }: RunOptions): Promise<StepResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--exclude-tools", "seqagent"];
  if (agent.model) args.push("--model", agent.model);

  let tmpFile: string | undefined;
  let tmpDir: string | undefined;
  if (agent.systemPrompt.trim()) {
    const tmp = await writeTempPrompt(agent.name, agent.systemPrompt);
    tmpFile = tmp.file;
    tmpDir = tmp.dir;
    args.push("--append-system-prompt", tmpFile);
  }
  args.push(`Task: ${task}`);

  const result: StepResult = {
    agent: agent.name,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, turns: 0, toolCalls: 0 },
  };

  const emit = () => onUpdate?.(result);

  try {
    result.exitCode = await new Promise<number>((resolve) => {
      const inv = getPiInvocation(args);
      const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      let aborted = false;

      const parse = (line: string) => {
        if (!line.trim()) return;
        let ev: any;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === "message_end" && ev.message) {
          const msg = ev.message as Message;
          result.messages.push(msg);
          if (msg.role === "assistant") {
            result.usage.turns++;
            // Count tool calls in this assistant message
            for (const part of msg.content) {
              if (part.type === "toolCall") result.usage.toolCalls++;
            }
            const u = msg.usage;
            if (u) {
              result.usage.input += u.input || 0;
              result.usage.output += u.output || 0;
              result.usage.model ??= msg.model;
            }
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          }
          emit();
        }
        if (ev.type === "tool_result_end" && ev.message) {
          result.messages.push(ev.message as Message);
          emit();
        }
      };

      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) parse(l);
      });
      proc.stderr.on("data", (d) => { result.stderr += d.toString(); });
      proc.on("close", (code) => { if (buf.trim()) parse(buf); resolve(code ?? 0); });
      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => { aborted = true; proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 5000); };
        if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
      }
    });
    if (result.stopReason === "aborted") throw new Error("Aborted");
    return result;
  } finally {
    try { if (tmpFile) await fs.promises.unlink(tmpFile); } catch { /* */ }
    try { if (tmpDir) await fs.promises.rm(tmpDir, { force: true }); } catch { /* */ }
  }
}

// ── Tool ───────────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name, e.g. 'explore'" }),
  task: Type.String({ description: "Task description for the agent." }),
});

export default function (pi: ExtensionAPI) {
  const agents = discoverAgents();
  const agentList = agents.map((a) => `${a.name}: ${a.description}`).join("; ");

  pi.registerTool({
    name: "seqagent",
    label: "Seqagent",
    description:
      "Run multiple subagents sequentially, one at a time. Each runs in an isolated pi process. " +
      "Agents are defined as markdown files. Use this to delegate focused tasks and save context.",
    promptSnippet: "Delegate tasks to subagents that run sequentially in isolated processes",
    promptGuidelines: [
      `Use seqagent to delegate focused work to subagents. Each runs in a fresh context — saves tokens and keeps this conversation lean. Available agents: ${agentList || "none"}.`,
      "Pass multiple tasks to seqagent to run several agents one after another. Each agent is independent — they do not share context.",
      "- Spawn a subagent when the task requires browsing 3+ files, searching across directories, or would take more than ~5 tool calls here",
      "- Spawn for broad questions: 'how does X work?', 'map the codebase', 'find all uses of Y', 'review these changes'",
      "- Skip seqagent for narrow lookups: reading one known file, checking a function signature, a simple grep",
      "- Skip seqagent when the task depends on context from this conversation",
      "- Use explore/investigate before planning changes; use research for external info",
      "- Use review only for large changes: 10+ files, ~10k+ LOC, or architectural shifts. Skip it for smaller work.",
      "- If the user asks for a review and the codebase is large (10+ files, ~10k+ LOC), use review scoped to the relevant area — e.g. 'review the auth module' not 'review everything'.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(TaskItem, {
        minItems: 1,
        maxItems: 8,
        description: "Ordered list of tasks. Each runs to completion before the next starts.",
      }),
      cwd: Type.Optional(Type.String({ description: "Working directory. Default: current." })),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const agents = discoverAgents();
      const tasks = params.tasks;
      const cwd = params.cwd ?? ctx.cwd;
      const results: StepResult[] = [];
      const md: SeqagentDetails = { steps: [], currentIndex: 0, frame: 0 };

      // Initialize pending steps
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const agent = agents.find((a) => a.name === t.agent);
        if (!agent) {
          const avail = agents.map((a) => `"${a.name}"`).join(", ") || "none";
          return {
            content: [{ type: "text", text: `Unknown agent "${t.agent}" for task ${i + 1}. Available: ${avail}` }],
            details: md,
            isError: true,
          };
        }
        md.steps.push({
          agent: t.agent, task: t.task, exitCode: 0, messages: [], stderr: "",
          usage: { input: 0, output: 0, turns: 0, toolCalls: 0 }, status: "pending",
        });
      }

      const emit = () => {
        const running = md.steps.filter((s) => s.status === "running").length;
        const totalCalls = md.steps.reduce((a, s) => a + s.usage.toolCalls, 0);
        const totalTok = md.steps.reduce((a, s) => a + s.usage.input + s.usage.output, 0);
        const summary = `${md.currentIndex}/${tasks.length} done`;
        const live = running > 0 ? ` · ${totalCalls} calls ${formatTokens(totalTok)} tok` : "";
        onUpdate?.({
          content: [{ type: "text", text: summary + live }],
          details: md,
        });
      };

      // Animation ticker — bumps frame while any step is running
      let animFrame = 0;
      const timer = setInterval(() => {
        const hasRunning = md.steps.some((s) => s.status === "running");
        if (!hasRunning) { clearInterval(timer); return; }
        animFrame++;
        md.frame = animFrame;
        emit();
      }, 120);

      emit();

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const agent = agents.find((a) => a.name === t.agent)!;
        md.currentIndex = i;
        md.steps[i].status = "running";
        emit();

        const result = await runAgent({
          agent, task: t.task, cwd, signal,
          onUpdate: () => emit(),
        }).catch((err) => {
          md.steps[i].status = "error";
          emit();
          throw err;
        });

        results.push(result);
        const failed = result.exitCode !== 0 || result.stopReason === "error";
        md.steps[i] = { ...result, status: failed ? "error" : "done" };
        md.currentIndex = i + 1;
        emit();

        if (failed) {
          const msg = result.errorMessage || result.stderr || "Agent failed";
          return {
            content: [{ type: "text", text: `Agent "${result.agent}" (task ${i + 1}) failed: ${msg}` }],
            details: md,
            isError: true,
          };
        }
      }

      // Build combined output
      const summaries = results.map((r, i) =>
        `### ${r.agent} (task ${i + 1})\n\n${getFinalOutput(r.messages) || "(no output)"}`,
      );
      const usageTotal = results.reduce((a, r) => ({
        input: a.input + r.usage.input,
        output: a.output + r.usage.output,
        turns: a.turns + r.usage.turns,
      }), { input: 0, output: 0, turns: 0 });

      return {
        content: [{
          type: "text",
          text: `${results.length} agent${results.length > 1 ? "s" : ""} completed\n\n${summaries.join("\n\n---\n\n")}`,
        }],
        details: { ...md, usageTotal },
      };
    },

    // ── Render tool call ─────────────────────────────────────────────────

    renderCall(args, theme) {
      const tasks = args.tasks as Array<{ agent: string; task: string }> | undefined;
      if (!tasks?.length) return new Text(theme.fg("toolTitle", theme.bold("seqagent")), 0, 0);

      let text = theme.fg("toolTitle", theme.bold("seqagent ")) + theme.fg("accent", `(${tasks.length} task${tasks.length > 1 ? "s" : ""})`);
      for (let i = 0; i < Math.min(tasks.length, 4); i++) {
        const t = tasks[i];
        const preview = t.task.length > 50 ? t.task.slice(0, 50) + "…" : t.task;
        text += `\n  ${theme.fg("muted", `${i + 1}.`) + " "}${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
      }
      if (tasks.length > 4) text += `\n  ${theme.fg("muted", `… +${tasks.length - 4} more`)}`;
      return new Text(text, 0, 0);
    },

    // ── Render result ────────────────────────────────────────────────────

    renderResult(result, { expanded }, theme) {
      const details = result.details as SeqagentDetails | undefined;
      if (!details?.steps?.length) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
      }

      const icon = (s: StepStatus, frame: number) => {
        if (s === "running") return theme.fg("accent", RUNNING_FRAMES[frame % RUNNING_FRAMES.length]);
        if (s === "error") return theme.fg("error", "✗");
        if (s === "done") return theme.fg("success", "✓");
        return theme.fg("muted", "◦");
      };

      const done = details.steps.filter((s) => s.status === "done").length;
      const err = details.steps.filter((s) => s.status === "error").length;
      const running = details.steps.filter((s) => s.status === "running").length;
      const status = running > 0
        ? `${done + err}/${details.steps.length} done, ${running} running`
        : `${done}/${details.steps.length} task${details.steps.length > 1 ? "s" : ""}`;

      // Expanded view
      if (expanded && running === 0) {
        const mdTheme = getMarkdownTheme();
        const container = new Container();
        container.addChild(new Text(
          theme.fg("toolTitle", theme.bold("seqagent ")) + theme.fg("accent", status),
          0, 0,
        ));

        for (const s of details.steps) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(
            `${icon(s.status, details.frame)} ${theme.fg("accent", s.agent)}${theme.fg("muted", ` — ${s.task}`)}`,
            0, 0,
          ));
          const output = getFinalOutput(s.messages);
          if (output) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
          }
          const usage = formatUsage(s.usage);
          if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
        }
        return container;
      }

      // Collapsed view (or still running)
      const totalStats = formatTotalStats(details.steps, err);
      let header = theme.fg("toolTitle", theme.bold("seqagent ")) + theme.fg("accent", status);
      if (totalStats) header += theme.fg("dim", ` · ${totalStats}`);

      let text = `\n${header}`;  // blank line to separate from renderCall above
      for (let i = 0; i < details.steps.length; i++) {
        const s = details.steps[i];
        text += `\n  ${icon(s.status, details.frame)} ${theme.fg("muted", `${i + 1}.`) + " "}${theme.fg("accent", s.agent)}`;
        const preview = s.task.length > 40 ? s.task.slice(0, 40) + "…" : s.task;
        text += theme.fg("dim", ` ${preview}`);
        // Stats for all agents
        const u = formatUsage(s.usage);
        if (u) text += theme.fg("accent", ` ${u}`);
      }
      // Blank line then expand hint
      if (!expanded && running === 0) text += `\n\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });
}
