import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // /exit command — alias for /quit
  pi.registerCommand("exit", {
    description: "Quit pi (alias for /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  // Intercept bare "exit" or "quit" (no leading slash) to quit
  pi.on("input", async (event, ctx) => {
    if (event.text === "exit" || event.text === "quit") {
      ctx.shutdown();
      return { action: "handled" };
    }
  });
}
