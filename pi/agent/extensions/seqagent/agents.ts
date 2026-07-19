/**
 * Agent discovery — load .md files from the bundled agents/ directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  systemPrompt: string;
}

const AGENTS_DIR = path.join(__dirname, "agents");

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  const fm: Record<string, string> = {};
  m[1].trim().split("\n").forEach((line) => {
    const idx = line.indexOf(":");
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return { frontmatter: fm, body: m[2].trim() };
}

export function discoverAgents(): AgentConfig[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const content = fs.readFileSync(path.join(AGENTS_DIR, entry.name), "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      model: frontmatter.model,
      systemPrompt: body,
    });
  }
  return agents;
}
