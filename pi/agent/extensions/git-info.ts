import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  let lastHash = "";

  // Render a short summary in the chat log
  pi.registerMessageRenderer("git-status", (message, _options, theme) => {
    const status = (message.details as any)?.status || "";
    const branch = (message.details as any)?.branch || "";

    const prefix = theme.fg("muted", " Git status updated");
    return new Text(prefix, 0, 0);
  });

  pi.on("before_agent_start", (event, ctx) => {
    let status = "";
    try {
      status = execSync("git status --short 2>/dev/null", {
        cwd: ctx.cwd,
        encoding: "utf-8",
      }).trim();
    } catch {
      return;
    }

    const hash = createHash("md5").update(status).digest("hex");
    if (hash === lastHash) return;
    lastHash = hash;

    let branch = "";
    let name = "";
    let email = "";
    try {
      branch = execSync("git branch --show-current 2>/dev/null", {
        cwd: ctx.cwd,
        encoding: "utf-8",
      }).trim();
      name = execSync("git config user.name 2>/dev/null", {
        cwd: ctx.cwd,
        encoding: "utf-8",
      }).trim();
      email = execSync("git config user.email 2>/dev/null", {
        cwd: ctx.cwd,
        encoding: "utf-8",
      }).trim();
    } catch {
      // branch/name/email optional
    }

    return {
      message: {
        customType: "git-status",
        content: `# Git Status Updated
current user: ${name} (${email})
${status || "(clean)"}`,
        display: true,
        details: { branch, status },
      },
    };
  });
}
