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
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { requestSummaryText } from "../lib/summary-status.ts";

// ── Types ──────────────────────────────────────────────────────────────────

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── llama.cpp subagent slot-cache fix ───────────────────────────────────────
// The server (local-llm/llama/compose/qwen3.6-27b-llama-q5km-mtp.yml) runs a
// single slot (-np 1) with --cache-ram: a host-RAM FIFO cache that snapshots
// the idle slot's KV state on every handoff so the parent session doesn't
// need a full reprefill when it resumes. Subagent snapshots pile into that
// same FIFO and can evict the parent's own entry before it's ever reused
// (observed: a ~163K-token full reprefill). Since subagents are one-shot and
// never resumed, erasing the slot right after a subagent exits — before the
// server's idle-scan can snapshot it — keeps it out of the cache entirely.
// Toggle via /seqagent-llama-cache-fix; state persists across sessions.

const LLAMA_SLOT_BASE_URL = "http://localhost:11434"; // direct to llama-server; Bifrost (:11435) can't forward /slots/*
const LLAMA_SLOT_ID = 0; // server runs -np 1 — only ever one slot
const LLAMA_ERASE_TIMEOUT_MS = 2000;
// The only model actually served by the --slot-save-path-patched llama.cpp
// config (qwen3.6-27b-llama-q5km-mtp.yml). Other entries in models.json that
// also resolve to :11434/:11435 (bonsai-ternary-27b, qwen3.6-27b-autoround —
// the latter is a *real* vLLM engine, not llama.cpp, when its stack is
// toggled active) run different containers/engines that don't support
// /slots at all — matched by substring since agent.model/currentModel can
// come through as e.g. "vllm/qwen3.6-27b-q5km-mtp" (direct) or
// "bifrost/vllm/qwen3.6-27b-q5km-mtp" (via gateway).
const LLAMA_LOCAL_MODEL_ID = "qwen3.6-27b-q5km-mtp";
const CACHE_FIX_STATE_FILE = path.join(__dirname, "llama-cache-fix-state.json");

function loadCacheFixState(): boolean {
  try {
    const raw = fs.readFileSync(CACHE_FIX_STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.enabled === "boolean") return parsed.enabled;
  } catch {
    // missing/corrupt/unreadable — fall through to default
  }
  return true; // default on
}

let cacheFixEnabled = loadCacheFixState();

async function saveCacheFixState(enabled: boolean): Promise<void> {
  try {
    await withFileMutationQueue(CACHE_FIX_STATE_FILE, () =>
      fs.promises.writeFile(
        CACHE_FIX_STATE_FILE,
        JSON.stringify({ enabled }),
        { encoding: "utf-8", mode: 0o600 },
      ),
    );
  } catch {
    // best-effort; in-memory state still reflects the toggle for this process
  }
}

// Erases the (only) llama.cpp slot so a just-finished subagent's KV state
// never gets snapshotted into --cache-ram. Must never throw, hang, or block
// seqagent's orchestration — swallows an offline/unreachable server, a
// timeout, or a non-2xx response (e.g. if --slot-save-path isn't set)
// silently, since this is a best-effort optimization, not a required step.
async function eraseSubagentSlot(model: string | undefined): Promise<void> {
  if (!cacheFixEnabled) return;
  if (process.env.SEQAGENT_SUBAGENT === "1") return; // only the parent process does this
  if (!model || !model.includes(LLAMA_LOCAL_MODEL_ID)) return; // not the patched llama-server
  if (process.env.SEQAGENT_DEBUG_ERASE) console.error(`[seqagent] erasing slot for model=${model}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLAMA_ERASE_TIMEOUT_MS);
  try {
    const res = await fetch(`${LLAMA_SLOT_BASE_URL}/slots/${LLAMA_SLOT_ID}?action=erase`, {
      method: "POST",
      signal: controller.signal,
    });
    if (process.env.SEQAGENT_DEBUG_ERASE) console.error(`[seqagent] erase response status=${res.status} body=${await res.text()}`);
  } catch (err) {
    if (process.env.SEQAGENT_DEBUG_ERASE) console.error(`[seqagent] erase failed: ${err}`);
    // server offline, connection refused, DNS failure, timeout — all fine to ignore
  } finally {
    clearTimeout(timer);
  }
}

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
  summary?: string;
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

// Task text and model-written summaries can be multi-line; the status list is
// one line per step, so flatten whitespace before truncating.
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
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
  return parts.join(", ");
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
  currentModel?: string;  // provider/id of the parent session's model, e.g. "anthropic/claude-sonnet-4-5"
}

async function runAgent({ agent, task, cwd, signal, onUpdate, currentModel }: RunOptions): Promise<StepResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.tools && agent.tools.length) {
    // Allowlist mode already excludes anything not listed (including seqagent), but
    // strip it explicitly as a safeguard against a future agent .md accidentally
    // including it and causing recursive spawning.
    const restricted = agent.tools.filter((t) => t !== "seqagent");
    args.push("--tools", restricted.join(","));
  } else {
    args.push("--exclude-tools", "seqagent");
  }
  // Use agent's hardcoded model if set, otherwise use the parent session's currently selected model
  const model = agent.model ?? currentModel;
  if (model) args.push("--model", model);

  let tmpFile: string | undefined;
  let tmpDir: string | undefined;
  if (agent.systemPrompt.trim()) {
    const wrapped = `<agent_instructions name="${agent.name}">\nYou are running as a subagent — an isolated pi process spawned to complete a specific task. You do not share context with the parent session.\n\n${agent.systemPrompt}\n</agent_instructions>`;
    const tmp = await writeTempPrompt(agent.name, wrapped);
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
      const proc = spawn(inv.command, inv.args, {
        cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SEQAGENT_SUBAGENT: "1" },
      });
      let buf = "";
      let errBuf = "";
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

      // Live activity summaries come through stderr, not stdout — pi's own
      // --mode json writer owns stdout, and console.log()'d summary lines
      // from the child's SEQAGENT_SUBAGENT hook get raced/dropped by it in
      // practice. stderr is untouched by pi in JSON mode, so it's the only
      // reliable side channel. Each line is either our JSON marker (consumed,
      // not shown as an error) or genuine diagnostic text (kept in result.stderr).
      const parseErrLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "seqagent_summary" && typeof ev.text === "string") {
            result.summary = ev.text;
            emit();
            return;
          }
        } catch {
          // not our marker — fall through to raw diagnostic text
        }
        result.stderr += `${line}\n`;
      };

      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) parse(l);
      });
      proc.stderr.on("data", (d) => {
        errBuf += d.toString();
        const lines = errBuf.split("\n");
        errBuf = lines.pop() || "";
        for (const l of lines) parseErrLine(l);
      });
      proc.on("close", (code) => {
        if (buf.trim()) parse(buf);
        if (errBuf.trim()) parseErrLine(errBuf);
        resolve(code ?? 0);
      });
      proc.on("error", () => {
        resolve(1);
      });

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
    if (process.env.SEQAGENT_SUBAGENT !== "1") {
      await eraseSubagentSlot(model);
    }
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

  pi.registerCommand("seqagent-llama-cache-fix", {
    description:
      "Toggle erasing a subagent's llama.cpp slot after it finishes, to protect the " +
      "parent conversation's KV cache entry (on/off/toggle; no arg toggles)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") cacheFixEnabled = true;
      else if (arg === "off") cacheFixEnabled = false;
      else if (arg === "" || arg === "toggle") cacheFixEnabled = !cacheFixEnabled;
      else {
        ctx.ui.notify("Usage: /seqagent-llama-cache-fix [on|off|toggle]", "warning");
        return;
      }
      await saveCacheFixState(cacheFixEnabled);
      ctx.ui.notify(`Subagent slot-erase fix ${cacheFixEnabled ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.registerTool({
    name: "seqagent",
    label: "Seqagent",
    description:
      "Run multiple subagents sequentially, one at a time. Each runs in an isolated pi process. " +
      "Agents are defined as markdown files. Use this to delegate focused tasks and save context.",
    promptSnippet: "Delegate tasks to subagents that run sequentially in isolated processes",
    promptGuidelines: [
      `Delegate focused work to subagents. Each runs in a fresh, isolated context and they share no state — pass several tasks to run them one after another. Available agents: ${agentList || "none"}.`,
      "- Spawn when the task needs 3+ files, a search across directories, or more than ~5 tool calls here, and for broad questions: 'how does X work?', 'map the codebase', 'find all uses of Y'",
      "- Skip for narrow lookups (one known file, a function signature, a simple grep) and for anything that depends on context from this conversation",
      "- Example: 'how does the retry logic work?' → spawn explore. 'what does retry.ts:34 do?' → read it yourself, it's one file",
      "- Spawn when you're stuck: the same fix tried twice, or two failed attempts at one bug. A fresh context isn't anchored to your wrong theory — hand `investigate` the symptom and what you already ruled out",
      "- Example: added a null check, still crashes, tried a different guard, still crashes → spawn investigate with the crash and both attempts, not a third guess",
      "- Use explore/investigate before planning changes; research for external info; review only for large changes (10+ files, ~10k+ LOC, architectural shifts), scoped to the relevant area rather than 'review everything'",
      "- Example: 'review my 3-file auth change' → do it yourself. 'review this 12-file PR that adds a new module' → spawn review scoped to 'the new module', not 'review everything'",
      "- `worker` is the only agent that can change anything; the rest are read-only, so asking them to edit, delete, or run a build gets you a plan, not the work",
      "- Delegate self-contained work to `worker`: a fix you've already diagnosed, a mechanical refactor, removing a feature, adding tests. Do narrow edits yourself. It has no context from here, so spell out which files, what to do, and how to verify",
      "- Example: 'add a null guard at auth.ts:42' (one line, already diagnosed) → do it yourself. 'apply that same guard pattern across all 9 handlers in api/' (diagnosed but mechanical and multi-file) → worker",
      "- Batch worker tasks only if they're independent — a later task can't build on an earlier one's output, so staged work (investigate, then fix) needs a second call once you've read the first report",
      "- Example: two unrelated typo fixes → one seqagent call, two worker tasks. 'find the leak, then fix it' → two separate seqagent calls, since the fix needs the investigation's output first",
      "- Example: this is getting complex - let me try a simpler fix → one seqagent call to investigate the issue and another to implement a solution",
      "- Example: this is getting complex - time to stop and present what's been done so far → one seqagent call to investigate the issue and another to implement a solution",
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

        // Pass the parent session's currently selected model as fallback
        const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const result = await runAgent({
          agent, task: t.task, cwd, signal,
          onUpdate: (live) => {
            md.steps[i] = { ...live, status: "running" };
            emit();
          },
          currentModel,
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
        const preview = oneLine(t.task, 50);
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
            `${icon(s.status, details.frame)} ${theme.fg("accent", s.agent)}${theme.fg("muted", ` — ${oneLine(s.task, 120)}`)}`,
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
        const u = formatUsage(s.usage);
        if (u) text += theme.fg("dim", " · ") + theme.fg("accent", u);
        const message = oneLine(s.summary ?? s.task, 80);
        if (message) text += theme.fg("dim", ` · ${message}`);
      }
      // Blank line then expand hint
      if (!expanded && running === 0) text += `\n\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });

  // ── Live activity summaries (subagent-side only) ──────────────────────────
  // Runs inside the spawned child process (see SEQAGENT_SUBAGENT env var set
  // by runAgent's spawn() call above) since this same extension module is
  // loaded globally for every `pi` invocation, including seqagent's children.

  if (process.env.SEQAGENT_SUBAGENT === "1") {
    // AgentMessage[], not Message[]. The `context` event fires upstream of
    // convertToLlm, so these still hold pi-internal roles (`custom`,
    // `bashExecution`, `branchSummary`, `compactionSummary`). This was
    // previously a bare `as Message[]` cast, which silently dropped every one
    // of those — costing the whole transcript under `/plan`, where both
    // messages pi sends are `role: "custom"`. Typed off convertToLlm's own
    // parameter so the distinction can't drift (same fix as working-status).
    let lastMessages: Parameters<typeof convertToLlm>[0] = [];
    let agentEnded = false;
    let lastSummaryText: string | undefined;
    // Fire-and-forget bookkeeping — same hazards as working-status/index.ts,
    // which carries the full rationale. The UI-specific one doesn't apply here
    // (there's no status line, just a JSON line on stderr that the parent
    // reads), but a late summary would still mislabel a finished step in the
    // parent's rendered list, and a reply from a previous run must not leak
    // into the next.
    let runController: AbortController | undefined;
    let runGeneration = 0;
    let summaryInFlight = false;

    const requestSummary = async (ctx: ExtensionContext) => {
      if (summaryInFlight) return;
      summaryInFlight = true;
      const generation = runGeneration;
      const signal = runController?.signal;
      try {
        const text = await requestSummaryText(pi, ctx, convertToLlm(lastMessages), lastSummaryText, signal);
        if (!text) return;
        if (generation !== runGeneration || agentEnded || signal?.aborted) return;
        lastSummaryText = text;
        console.error(JSON.stringify({ type: "seqagent_summary", text }));
      } catch {
        // best-effort; the parent just shows the step's task text instead
      } finally {
        summaryInFlight = false;
      }
    };

    // `context` both captures the messages and triggers the summary; it fires
    // before every LLM call, so this reports once per turn and reports the
    // opening step from the task text itself rather than after the subagent's
    // first turn has already run. See working-status/index.ts for the full
    // rationale — same change, same reasons. Registered after requestSummary
    // so it isn't referencing a const declared below it, and kept synchronous
    // because handlers here can rewrite the outgoing message list and are
    // awaited by the runner.
    //
    // The cadence counters this used to keep are gone rather than set to 1.
    // Note they also used to survive across runs in a reused child process,
    // which silently suppressed a second run's opening summary; with no
    // counters left there is nothing to reset and that whole class of bug
    // goes with them.
    pi.on("context", (event, ctx) => {
      lastMessages = event.messages;
      if (agentEnded) return;
      // Not awaited — the original single-slot reason is gone. This goes to a
      // separate 2B server (:11437, -np 2), sized with two slots precisely so
      // a subagent's poll and the parent's can't queue behind each other, so
      // there's nothing to serialise against and no reason to delay the
      // subagent's next turn on a status line. requestSummary owns the
      // late-landing and ordering guards.
      void requestSummary(ctx);
    });

    // Reset state when the agent starts. The first summary now fires from the
    // `context` event immediately after this, ahead of the first turn's call.
    pi.on("agent_start", () => {
      agentEnded = false;
      lastSummaryText = undefined;
      runGeneration++;
      runController?.abort();
      runController = new AbortController();
    });

    // Abort rather than let a request finish into a void: the child process
    // exits shortly after the run ends, and one still on the wire just delays
    // that. agent_settled is the backstop for runs that end without agent_end
    // (an aborted run, say) — without it, a late reply could still print a
    // seqagent_summary line for a step the parent has already finished
    // rendering.
    const stopRunSummaries = () => {
      agentEnded = true;
      runController?.abort();
    };

    pi.on("agent_end", stopRunSummaries);
    pi.on("agent_settled", stopRunSummaries);
  }
}
