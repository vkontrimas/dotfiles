/**
 * Some local models (seen so far with the qwen3.6-27b vLLM setup) occasionally
 * emit a turn that's *only* thinking/reasoning content — no text reply, no
 * tool call — with stopReason "stop". Pi treats that as a normal, deliberate
 * end of turn and goes idle, so the agent silently stops mid-task with
 * nothing visible to the user and no further action taken. Bifrost's log for
 * one such turn showed the model had actually composed a tool call, but it
 * stayed embedded as literal `<tool_call>...</tool_call>` text inside the
 * `reasoning` field instead of being parsed out into a real tool call — a
 * parser/serving quirk, not a deliberate "I'm done" from the model.
 *
 * This extension detects that pattern on `agent_end` and pushes a follow-up
 * turn nudging the model to either continue the tool call it was clearly
 * mid-thought on, or — if it really is done — say so with an actual reply to
 * the user. It only fires when the last assistant message has thinking
 * content but no text and no tool call; a normal completed turn (text and/or
 * tool calls present) or an explicit user interrupt (stopReason "aborted")
 * are left alone.
 *
 * Capped at a few consecutive retries so a model that's genuinely stuck in
 * this failure mode doesn't spin forever unattended — after that it notifies
 * the user instead of continuing to auto-retry.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_CONSECUTIVE_NUDGES = 3;

function isThinkingOnlyStall(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;

	let hasThinking = false;
	for (const block of message.content) {
		if (block.type === "thinking" && block.thinking.trim()) hasThinking = true;
		if (block.type === "text" && block.text.trim()) return false;
		if (block.type === "toolCall") return false;
	}
	return hasThinking;
}

export default function (pi: ExtensionAPI): void {
	let consecutiveNudges = 0;

	pi.on("agent_end", async (event, ctx) => {
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant") as
			| AssistantMessage
			| undefined;
		if (!lastAssistant) return;
		if (!isThinkingOnlyStall(lastAssistant)) {
			consecutiveNudges = 0;
			return;
		}

		if (consecutiveNudges >= MAX_CONSECUTIVE_NUDGES) {
			ctx.ui.notify(
				`thinking-stall: gave up after ${MAX_CONSECUTIVE_NUDGES} turns that ended in thinking only, no reply or tool call.`,
				"warning",
			);
			return;
		}

		consecutiveNudges++;

		pi.sendMessage(
			{
				customType: "thinking-stall-nudge",
				content:
					`<system-reminder>\n` +
					`Last turn ended on thinking only — no reply, no tool call. Take the next step, or reply if done.\n` +
					`</system-reminder>`,
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
