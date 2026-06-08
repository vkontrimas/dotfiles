/**
 * Multi-file edit tool — each edit specifies its own path.
 * Lets agents batch edits across multiple files in one call.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-tui";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { diffLines, diffWords } from "diff";

// ── Schema ────────────────────────────────────────────────────────────────

const editItemSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the file to edit (relative or absolute)",
    }),
    oldText: Type.String({
      description:
        "Exact text to find and replace. Must be unique in the file.",
    }),
    newText: Type.String({
      description: "Replacement text.",
    }),
  },
  { additionalProperties: false },
);

const parameters = Type.Object({
  edits: Type.Array(editItemSchema, {
    description:
      "One or more targeted replacements across one or more files. Each edit is matched against the original file (not incrementally). Do not include overlapping edits. Merge nearby changes into one edit.",
  }),
});

// ── Types ─────────────────────────────────────────────────────────────────

interface EditItem {
  path: string;
  oldText: string;
  newText: string;
}

interface FileGroup {
  originalPath: string;
  edits: Array<{ oldText: string; newText: string }>;
}

interface FileResult {
  path: string;
  ok: boolean;
  diff?: string;
  error?: string;
  errors?: string[];
  count?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  if (isAbsolute(filePath)) return filePath;
  return resolve(cwd, filePath);
}

function groupByPath(
  edits: EditItem[],
  cwd: string,
): Map<string, FileGroup> {
  const groups = new Map<string, FileGroup>();
  for (const e of edits) {
    const abs = resolvePath(e.path, cwd);
    if (!groups.has(abs))
      groups.set(abs, { originalPath: e.path, edits: [] });
    groups.get(abs)!.edits.push({
      oldText: e.oldText,
      newText: e.newText,
    });
  }
  return groups;
}

function findText(
  content: string,
  oldText: string,
): { found: boolean; index: number; length: number } {
  const idx = content.indexOf(oldText);
  if (idx !== -1)
    return { found: true, index: idx, length: oldText.length };

  const norm = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"');

  const fIdx = norm(content).indexOf(norm(oldText));
  if (fIdx !== -1)
    return { found: true, index: fIdx, length: norm(oldText).length };

  return { found: false, index: -1, length: 0 };
}

function applyEdits(
  content: string,
  edits: Array<{ oldText: string; newText: string }>,
  filePath: string,
): { content: string | null; errors: string[] } {
  const matches: Array<{
    editIndex: number;
    index: number;
    length: number;
    newText: string;
  }> = [];
  const errors: string[] = [];

  // Phase 1: find matches for each edit
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e.oldText) {
      errors.push(`[edit ${i + 1}] oldText must not be empty in ${filePath}.`);
      continue;
    }
    const m = findText(content, e.oldText);
    if (!m.found) {
      const snippet = e.oldText.split('\n')[0].trim().slice(0, 80);
      errors.push(
        `[edit ${i + 1}] Could not find exact text in ${filePath}: "${snippet}${e.oldText.length > 80 ? '…' : ''}" — must match exactly including whitespace and newlines.`,
      );
      continue;
    }
    matches.push({ editIndex: i, index: m.index, length: m.length, newText: e.newText });
  }

  // Phase 2: check for overlaps among successful matches
  matches.sort((a, b) => a.index - b.index);
  const failedIndices = new Set<number>();
  for (let i = 1; i < matches.length; i++) {
    if (matches[i - 1].index + matches[i - 1].length > matches[i].index) {
      failedIndices.add(matches[i].editIndex);
      const overlapIndices = [matches[i - 1].editIndex, matches[i].editIndex]
        .map((idx) => idx + 1)
        .join(", ");
      errors.push(
        `[edit ${overlapIndices}] Edits overlap in ${filePath}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  // Phase 3: apply non-overlapping matches from back to front
  const valid = matches.filter((m) => !failedIndices.has(m.editIndex));
  if (valid.length === 0) {
    return { content: null, errors };
  }

  let result = content;
  for (let i = valid.length - 1; i >= 0; i--) {
    const { index, length, newText } = valid[i];
    result = result.slice(0, index) + newText + result.slice(index + length);
  }

  if (result === content) {
    errors.push(
      `No changes made to ${filePath}. The replacement produced identical content.`,
    );
    return { content: null, errors };
  }

  return { content: result, errors };
}

// ── Diff ──────────────────────────────────────────────────────────────────

function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines: number = 4,
): string {
  const diffs = diffLines(oldContent, newContent);

  const output: string[] = [];
  const maxLines = Math.max(
    oldContent.split("\n").length,
    newContent.split("\n").length,
  );
  const lineNumWidth = String(maxLines).length;

  let oldLn = 1,
    newLn = 1;
  let lastWasChange = false;

  for (let idx = 0; idx < diffs.length; idx++) {
    const part = diffs[idx];

    if (part.added) {
      const lines = part.value.split("\n");
      // diffLines includes trailing newline, so last element is ""
      const count = lines.length > 1 && lines[lines.length - 1] === ""
        ? lines.length - 1
        : lines.length;
      for (let i = 0; i < count; i++) {
        const ln = String(newLn).padStart(lineNumWidth, " ");
        output.push(`+${ln} ${lines[i]}`);
        newLn++;
      }
      lastWasChange = true;
    } else if (part.removed) {
      const lines = part.value.split("\n");
      const count = lines.length > 1 && lines[lines.length - 1] === ""
        ? lines.length - 1
        : lines.length;
      for (let i = 0; i < count; i++) {
        const ln = String(oldLn).padStart(lineNumWidth, " ");
        output.push(`-${ln} ${lines[i]}`);
        oldLn++;
      }
      lastWasChange = true;
    } else {
      // Context — part.count gives the number of equal lines
      const count = part.count ?? part.value.split("\n").length;
      const lines = part.value.split("\n");
      const lineCount =
        lines.length > 1 && lines[lines.length - 1] === ""
          ? lines.length - 1
          : lines.length;

      const hasLeading = lastWasChange;
      const nextPart = diffs[idx + 1];
      const hasTrailing = nextPart?.added || nextPart?.removed;

      if (hasLeading && hasTrailing) {
        if (lineCount <= contextLines * 2) {
          for (let i = 0; i < lineCount; i++) {
            const ln = String(oldLn).padStart(lineNumWidth, " ");
            output.push(` ${ln} ${lines[i]}`);
            oldLn++;
            newLn++;
          }
        } else {
          for (let i = 0; i < contextLines; i++) {
            const ln = String(oldLn).padStart(lineNumWidth, " ");
            output.push(` ${ln} ${lines[i]}`);
            oldLn++;
            newLn++;
          }
          const skipped = lineCount - contextLines - contextLines;
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLn += skipped;
          newLn += skipped;
          for (let i = lineCount - contextLines; i < lineCount; i++) {
            const ln = String(oldLn).padStart(lineNumWidth, " ");
            output.push(` ${ln} ${lines[i]}`);
            oldLn++;
            newLn++;
          }
        }
      } else if (hasLeading) {
        const shown = Math.min(lineCount, contextLines);
        for (let i = 0; i < shown; i++) {
          const ln = String(oldLn).padStart(lineNumWidth, " ");
          output.push(` ${ln} ${lines[i]}`);
          oldLn++;
          newLn++;
        }
        const skipped = lineCount - shown;
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLn += skipped;
          newLn += skipped;
        }
      } else if (hasTrailing) {
        const shown = Math.min(lineCount, contextLines);
        const skipStart = lineCount - shown;
        if (skipStart > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLn += skipStart;
          newLn += skipStart;
        }
        for (let i = skipStart; i < lineCount; i++) {
          const ln = String(oldLn).padStart(lineNumWidth, " ");
          output.push(` ${ln} ${lines[i]}`);
          oldLn++;
          newLn++;
        }
      } else {
        oldLn += lineCount;
        newLn += lineCount;
      }
      lastWasChange = false;
    }
  }

  return output.join("\n");
}

// ── Rendering ─────────────────────────────────────────────────────────────

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

function parseDiffLine(line: string) {
  const match = line.match(/^([+-\s])(\s*\d*)\s?(.*)$/);
  if (!match) return null;
  return { prefix: match[1], lineNum: match[2], content: match[3] };
}

function renderIntraLineDiff(
  oldContent: string,
  newContent: string,
  theme: Theme,
): { removedLine: string; addedLine: string } {
  let wordDiff = diffWords(oldContent, newContent);

  // Merge consecutive removed/added tokens separated only by whitespace common tokens,
  // so that e.g. "hello world" → "goodbye universe" highlights the entire phrase as one block.
  wordDiff = mergeAdjacentChanges(wordDiff);

  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;
  for (const part of wordDiff) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) removedLine += theme.inverse(value);
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) addedLine += theme.inverse(value);
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }
  return { removedLine, addedLine };
}

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

function mergeAdjacentChanges(parts: DiffPart[]): DiffPart[] {
  const result: DiffPart[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part.added || part.removed) {
      // Merge a run of (removed/added/whitespace-common) tokens into
      // one removed block and one added block.
      let removedValue = "";
      let addedValue = "";
      while (i < parts.length) {
        const p = parts[i];
        if (p.added) {
          addedValue += p.value;
          i++;
        } else if (p.removed) {
          removedValue += p.value;
          i++;
        } else if (!p.added && !p.removed && /^\s+$/.test(p.value)) {
          removedValue += p.value;
          addedValue += p.value;
          i++;
        } else {
          break;
        }
      }
      if (removedValue) {
        result.push({ removed: true, value: removedValue });
      }
      if (addedValue) {
        result.push({ added: true, value: addedValue });
      }
    } else {
      result.push(part);
      i++;
    }
  }
  return result;
}

function renderDiff(diffText: string, theme: Theme): string {
  const lines = diffText.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const parsed = parseDiffLine(line);
    if (!parsed) {
      result.push(theme.fg("toolDiffContext", line));
      i++;
      continue;
    }
    if (parsed.prefix === "-") {
      const removedLines: Array<{ lineNum: string; content: string }> = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "-") break;
        removedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }
      const addedLines: Array<{ lineNum: string; content: string }> = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "+") break;
        addedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }
      if (removedLines.length === 1 && addedLines.length === 1) {
        const { removedLine: rl, addedLine: al } = renderIntraLineDiff(
          replaceTabs(removedLines[0].content),
          replaceTabs(addedLines[0].content),
          theme,
        );
        result.push(
          theme.fg(
            "toolDiffRemoved",
            `-${removedLines[0].lineNum} ${rl}`,
          ),
        );
        result.push(
          theme.fg("toolDiffAdded", `+${addedLines[0].lineNum} ${al}`),
        );
      } else {
        for (const r of removedLines) {
          result.push(
            theme.fg("toolDiffRemoved", `-${r.lineNum} ${replaceTabs(r.content)}`),
          );
        }
        for (const a of addedLines) {
          result.push(
            theme.fg("toolDiffAdded", `+${a.lineNum} ${replaceTabs(a.content)}`),
          );
        }
      }
    } else if (parsed.prefix === "+") {
      result.push(
        theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`),
      );
      i++;
    } else {
      result.push(
        theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`),
      );
      i++;
    }
  }
  return result.join("\n");
}

function buildFileBox(result: FileResult, theme: Theme): Box {
  const box = new Box(1, 1, (text) => text);
  const hasErrors = !result.ok || (result.errors?.length ?? 0) > 0;
  const bgFn = hasErrors
    ? (text: string) => theme.bg("toolErrorBg", text)
    : (text: string) => theme.bg("toolSuccessBg", text);
  box.setBgFn(bgFn);

  const header = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", result.path)}`;
  box.addChild(new Text(header, 0, 0));
  box.addChild(new Spacer(1));

  if (result.ok && result.diff) {
    box.addChild(new Text(renderDiff(result.diff, theme), 0, 0));
  }

  if (result.errors && result.errors.length > 0) {
    box.addChild(new Spacer(1));
    for (const e of result.errors) {
      box.addChild(new Text(theme.fg("error", e), 0, 0));
    }
  } else if (!result.ok && result.error) {
    box.addChild(new Text(theme.fg("error", result.error), 0, 0));
  }

  return box;
}


// ── Test exports (not part of public API) ──────────────────────────────

export {
  resolvePath,
  groupByPath,
  findText,
  applyEdits,
  generateDiffString,
  replaceTabs,
  parseDiffLine,
  mergeAdjacentChanges,
};


export default function (pi: ExtensionAPI) {
  // Module-level state for diff inclusion toggle
  let includeDiffs = true;

  // Reconstruct state from session on startup
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "edit") {
          const details = entry.message.details as any;
          if (details !== undefined && "includeDiffs" in details) {
            includeDiffs = details.includeDiffs;
          }
        }
      }
    }
  });

  pi.registerCommand("edit-diffs", {
    description: "Toggle whether edit tool includes diffs in LLM context",
    handler: async (_args, ctx) => {
      includeDiffs = !includeDiffs;
      return ctx.ui.notify(`Edit diffs in context: ${includeDiffs ? "on" : "off"}`, "info");
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit files using exact text replacement. Each edit specifies its own path, allowing edits across multiple files in one call. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. If some edits fail, the successful ones are still applied — retry only the failed edits.",
    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple edits across files in one call",
    promptGuidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "Each edit includes its own path — you can edit multiple files in one call",
      "When changing multiple locations in the same file, use multiple edits with the same path",
      "Each edits[].oldText is matched against the original file, not after earlier edits. Do not emit overlapping edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],
    parameters,
    renderShell: "self",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const edits = params.edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error("edits must contain at least one replacement.");
      }

      const groups = groupByPath(edits, ctx.cwd);
      const results: FileResult[] = [];

      for (const [absPath, { originalPath, edits: fileEdits }] of groups) {
        if (signal?.aborted) throw new Error("Operation aborted");

        try {
          const originalContent = await withFileMutationQueue(
            absPath,
            async () => {
              try {
                await access(absPath, constants.R_OK | constants.W_OK);
              } catch (err: any) {
                const code = err?.code ?? String(err);
                throw new Error(
                  `Could not edit file: ${originalPath}. ${code}.`,
                );
              }

              if (signal?.aborted) throw new Error("Operation aborted");

              const raw = (await readFile(absPath, "utf-8")).replace(
                /^\uFEFF/,
                "",
              );

              if (signal?.aborted) throw new Error("Operation aborted");

              const { content: newContent, errors: editErrors } = applyEdits(raw, fileEdits, absPath);

              if (signal?.aborted) throw new Error("Operation aborted");

              if (newContent !== null) {
                await writeFile(absPath, newContent, "utf-8");
              }
              return { raw, newContent, editErrors };
            },
          );

          const diff =
            originalContent.newContent !== null
              ? generateDiffString(originalContent.raw, originalContent.newContent)
              : undefined;

          results.push({
            path: originalPath,
            ok: originalContent.newContent !== null,
            diff,
            count: fileEdits.length,
            errors: originalContent.editErrors,
          });
        } catch (err: any) {
          results.push({
            path: originalPath,
            ok: false,
            error: err?.message ?? String(err),
          });
        }
      }

      // Store in context.state for same-session reuse; also return in details for reload survival
      if (!ctx.state) ctx.state = {};
      ctx.state.results = results;

      const success = results.filter((r) => r.ok);
      const allEditErrors: string[] = [];
      for (const r of results) {
        if (r.error) allEditErrors.push(`${r.path}: ${r.error}`);
        if (r.errors) {
          for (const e of r.errors) {
            allEditErrors.push(`${r.path}: ${e}`);
          }
        }
      }

      const lines: string[] = [];
      lines.push(`${success.length} file(s) edited`);

      if (allEditErrors.length > 0) {
        lines.push("");
        lines.push(`${allEditErrors.length} edit(s) failed:`);
        for (const e of allEditErrors) {
          lines.push(`- ${e}`);
        }
      } else {
        lines.push(`0 edit(s) failed`);
      }

      // Append diffs for LLM context
      if (includeDiffs) {
        for (const r of results) {
          if (r.ok && r.diff) {
            lines.push("");
            lines.push(`<diff path="${r.path}">`);
            lines.push(r.diff);
            lines.push(`</diff>`);
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { results, includeDiffs },
      };
    },

    renderCall(args, theme, context) {
      // When result is complete, return empty so only renderResult shows
      if (!context.isPartial) {
        return new Container();
      }
      // Pending: show file paths only
      const edits = Array.isArray(args?.edits) ? args.edits : [];
      const groups = groupByPath(edits as EditItem[], context.cwd);
      const paths = [...groups.values()].map((g) => g.originalPath);
      const headerBox = new Box(1, 1, (text) => text);
      headerBox.setBgFn((text) => theme.bg("toolPendingBg", text));
      const header = `${theme.fg("toolTitle", theme.bold("edit"))}... ${paths.map((p) => theme.fg("accent", p)).join(", ")}`;
      headerBox.addChild(new Text(header, 0, 0));
      return headerBox;
    },

    renderResult(result, _options, theme, context) {
      // Get results: result.details (execute return, survives reload) > context.state (same-session fallback)
      const details = (result as any).details ?? {};
      let results: FileResult[] | undefined =
        details.results ?? (context.state as any)?.results;

      if (context.isError || !results || results.length === 0) {
        const errText = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n");
        const isAborted = errText.toLowerCase().includes("abort") || errText.toLowerCase().includes("cancel");
        const path = Array.isArray((context?.args as any)?.edits)
          ? (context.args as any).edits[0]?.path ?? "..."
          : "...";
        results = [{ path, ok: false, error: isAborted ? "Cancelled" : (errText || "Unknown error") }];
      }

      const container = new Container();
      for (const r of results) {
        container.addChild(buildFileBox(r, theme));
        container.addChild(new Spacer(1));
      }

      return container;
    },
  });
}
