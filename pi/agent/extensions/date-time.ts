/**
 * Injects the current date and time into the system prompt on every turn.
 *
 * Places the timestamp at the top of the system prompt so the model always
 * knows the current date, time, and timezone.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const now = new Date();
    const date = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const iso = now.toISOString().slice(0, 10);

    return {
      systemPrompt: `${event.systemPrompt}\n\nCurrent date: ${date} (${iso})`,
    };
  });
}
