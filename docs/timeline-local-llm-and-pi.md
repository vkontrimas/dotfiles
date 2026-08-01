# Timeline: Local LLM Backend & Pi Agent

Reconstructed from `git log` (dotfiles repo). Dates are commit dates.

## Local LLM Backend

- 2026-06-07: Added a power profile switcher to the bar — first step toward managing GPU load for local inference.
- 2026-06-08: Started routing pi requests through **Bifrost** as an LLM gateway; enabled persistent LLM logs; showed both GPUs in the status bar.
- 2026-06-15: Tore down the LLM service on sleep to free VRAM.
- 2026-06-19: Killed vLLM on suspend and restored it on resume.
- 2026-06-24: Hardened the LLM systemd service.
- 2026-07-17: **Extracted the vLLM compose files out of club-3090 into dotfiles** — `local-llm/` becomes the home of the stack.
- 2026-07-17: Raised the Bifrost stream idle timeout to 300s (long local generations were being cut off).
- 2026-07-17: Dropped a stale venv python path from the swayidle LLM hooks.
- 2026-07-17: Added **Bonsai Ternary 27B** as the SOLO config; vLLM kept the DUAL-GPU config.
- 2026-07-18: Tuned Bonsai Qwen hyperparameters; removed pricing config from Bifrost.
- 2026-07-18: Added the first **Qwen3.6-27B llama.cpp** configs for an intelligence comparison against vLLM.
- 2026-07-18: Switched to an uncompressed KV cache and optimized the llama.cpp launch settings.
- 2026-07-18: Pushed the vision config to the full **262K native context**; raised the NVIDIA power limit.
- 2026-07-18: Removed the LLM buttons from waybar for the time being.
- 2026-07-19: Added a single-GPU text-only **ik_llama** Qwen3.6-27B config at 213K context.
- 2026-07-19: Added a **Qwen3.6-35B-A3B MoE "scout"** model on GPU0 with CPU expert offload, plus a combined compose stack, to serve subagents.
- 2026-07-19: Replaced the 35B-A3B MoE scout with a **Qwen3.5-4B dense** model to get real `-np` concurrency.
- 2026-07-19: Fixed scout looping via a Q6_K quant with reasoning turned off.
- 2026-07-19: Split the scout into 2 MTP-enabled replicas for concurrency; reverted 27B MTP `n_max` back to 2.
- 2026-07-19: Consolidated the 2x ik_llama scout replicas into a single mainline `llama-server` with `np=4`.
- 2026-07-19: **Moved the main 27B to mainline llama.cpp** — Q6_K + MTP, dual-GPU, full context.
- 2026-07-19: Traded Q6_K weights for **Q5_K_M** to afford a q8_0 KV cache instead of q4_0.
- 2026-07-19: Bumped MTP `n_max` to 3; added the `local-llm/README.md`.
- 2026-07-19: Removed the presence penalty from sampling.
- 2026-07-19: Retired the scout experiment; archived the old 27B and stack configs.
- 2026-07-21: Enabled **vision** on the Qwen3.6-27B Q5_K_M + MTP config.
- 2026-07-31: Raised the host prompt cache to **16GB**.

## Pi Agent & Extensions

- 2026-05-20: **Added pi agent config and extensions** to dotfiles; fixed git spacing and disabled thinking blocks by default.
- 2026-05-31: Disabled the `git-info` extension; nudged the agent toward brief output.
- 2026-06-06: Added **qwedit**, a more Qwen-friendly edit tool.
- 2026-06-07: Made edits ~-expansion aware; reported edit failures back into context.
- 2026-06-08: Added caveman-lite mode; added `/edit-context` to include edits in context; simplified qwedit to one edit per tool call; routed requests through Bifrost.
- 2026-06-21: Saved the dark-mode part of the pi config.
- 2026-07-17: **Defaulted pi to the local vLLM backend via Bifrost.**
- 2026-07-18: Added the first **subagents** extension; iterated on reliability; adjusted agent instructions.
- 2026-07-19: Routed subagents through Bifrost rather than the direct vllm-scout provider; experimented with async subagents (reverted), scout-only tool budgets (reverted), and a concurrency cap of 2 — then disabled subagents as too slow.
- 2026-07-19: **Replaced it with `seqagent`, a sequential subagent runner.** Dropped tool allowlisting in favour of `--exclude-tools seqagent`.
- 2026-07-19: seqagent UX — animated spinner, aggregate + live stats in the header, accent-coloured stats, spacing fixes.
- 2026-07-19: seqagent personas — `explore`, `research`, `review`, `investigate`; added prompt snippets, guidelines, and usage examples.
- 2026-07-19: Tuned the review-spawn threshold repeatedly (5+ files/500+ LOC → 15+/15k → 10+/10k), and scoped review to the relevant area on large codebases.
- 2026-07-19: Wrapped agent prompts in XML tags with a subagent context prefix.
- 2026-07-20: **Added the global `/plan` extension** — plan-mode context as header + guidance + user message, AI-chosen plan filename, inline editor with live write progress, truncated confirmation banners, hidden skill/prompt messages, and `/plan` restoration on tree rewind.
- 2026-07-21: Plan approval moved to `ask_user` with Yes/No/Make changes; banner rendered through the Markdown component with the correct theme.
- 2026-07-21: seqagent falls back to the parent session's model instead of the pi default; added git rules to the agent instructions.
- 2026-07-26: **Added the `objectives` extension** for tracking long-running tasks, then iterated hard: single-line call/result headers, live-streaming checklist, `/objectives`, `/objectives-stats`, `/objectives-clear`, auto-continue on stop, reload/resume survival, a `objectives_blocked` escape hatch, real diffs on update, and a split of `update_objectives` into `add_objectives`/`complete_objective`.
- 2026-07-26: `save_plan` → `present_plan`; the agent writes plans directly.
- 2026-07-26: Extracted `PLANNING_INSTRUCTIONS` into a **skill** and fixed six gaps; added a **debug skill** for focused bug fixing.
- 2026-07-26: seqagent restricts subagent toolsets and warns on malformed agent files.
- 2026-07-26: Added a **date-time extension** injecting the current date into the system prompt.
- 2026-07-26: **Renamed `objectives` → `tasks`**, splitting reason from evidence; plan "Areas" renamed to "Tasks" with a tabular Test/Verify section.
- 2026-07-27: `task_N` id format instead of bare integers; `complete_task` evidence scoped to verification rather than a changelog.
- 2026-07-27: Footer task count and pending-only reminders; `/tasks-clear` now clears the model's view too; no auto-continue on a user-aborted run.
- 2026-07-27: Agent forbidden from discarding changes it didn't make; spawns a subagent when stuck in a fix loop; debug skill requires a regression test in its verify step.
- 2026-07-31: Added a **worker agent** persona to seqagent for making changes (not just read-only exploration); dropped the request timeout slightly.
- 2026-08-01: Added a **thinking-stall** nudge when a turn ends on thinking only.
- 2026-08-01: Planning asks clarifying questions before writing a plan, with a "discuss" option in `ask_user` prompts.
- 2026-08-01: `cancel_task`, auto-clear of tasks on `/plan`, and end-of-run task visibility.
- 2026-08-01: Added a **concise** extension steering output toward low-filler replies; trimmed tasks/seqagent prompt guidelines to what the model can't infer.

## Major Milestones

- **2026-05-20** — Pi agent enters the dotfiles repo. Everything after this is iteration on one agent.
- **2026-06-06/08** — Qwen-friendly tooling (`qwedit`) and Bifrost as the gateway: the agent stops assuming a frontier model and starts being built for local ones.
- **2026-07-17** — The whole local LLM stack moves into dotfiles, and pi defaults to local vLLM via Bifrost. This is the switch to self-hosted as the daily driver.
- **2026-07-18/19** — The great backend bake-off: vLLM vs. Bonsai vs. ik_llama vs. mainline llama.cpp, ending with mainline llama.cpp + Qwen3.6-27B Q5_K_M + MTP on dual GPUs at full context with a q8_0 KV cache. Still the config today.
- **2026-07-19** — The scout-model / parallel-subagent experiment is tried and abandoned; `subagents` is replaced by the sequential `seqagent`.
- **2026-07-20** — `/plan` lands; the agent gains an explicit planning phase.
- **2026-07-26** — Two structural shifts on one day: skills (planning, debug) as first-class units, and the objectives/tasks system for long-running work.
- **2026-07-31 → 08-01** — seqagent gets a writing worker, and the focus shifts to prompt discipline: concise output, stall detection, clarifying questions before planning.
