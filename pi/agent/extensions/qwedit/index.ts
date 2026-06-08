/**
 * Single-file edit tool — one edit per tool call.
 * Each call targets exactly one file with one text replacement.
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

const parameters = Type.Object(
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

// ── Helpers ───────────────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  if (isAbsolute(filePath)) return filePath;
  return resolve(cwd, filePath);
}

function normText(s: string): string {
  return (s
    // NFKC normalization (decomposes compatibility characters)
    .normalize("NFKC")
    // Strip trailing whitespace per line
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    // Smart single quotes → '
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    // Smart double quotes → "
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Various dashes/hyphens → -
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // Special spaces → regular space
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " "));
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(content: string): string {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: string): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return Infinity;
  let count = 0, pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function findText(
  content: string,
  oldText: string,
): { found: boolean; index: number; length: number; occurrences: number; fuzzy: boolean } {
  // Try exact match first
  const idx = content.indexOf(oldText);
  if (idx !== -1) {
    const occ = countOccurrences(content, oldText);
    return { found: true, index: idx, length: oldText.length, occurrences: occ, fuzzy: false };
  }

  // Try fuzzy match in normalized space
  const nContent = normText(content);
  const nOldText = normText(oldText);
  const fIdx = nContent.indexOf(nOldText);
  if (fIdx !== -1) {
    const occ = countOccurrences(nContent, nOldText);
    return { found: true, index: fIdx, length: nOldText.length, occurrences: occ, fuzzy: true };
  }

  return { found: false, index: -1, length: 0, occurrences: 0, fuzzy: false };
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

function buildResultBox(
  path: string,
  ok: boolean,
  diff: string | undefined,
  error: string | undefined,
  theme: Theme,
): Box {
  const box = new Box(1, 1, (text) => text);
  const bgFn = ok
    ? (text: string) => theme.bg("toolSuccessBg", text)
    : (text: string) => theme.bg("toolErrorBg", text);
  box.setBgFn(bgFn);

  const header = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}`;
  box.addChild(new Text(header, 0, 0));
  box.addChild(new Spacer(1));

  if (ok && diff) {
    box.addChild(new Text(renderDiff(diff, theme), 0, 0));
  }

  if (error) {
    box.addChild(new Text(theme.fg("error", error), 0, 0));
  }

  return box;
}

// ── Test exports (not part of public API) ──────────────────────────────

export {
  resolvePath,
  findText,
  generateDiffString,
  replaceTabs,
  parseDiffLine,
  mergeAdjacentChanges,
  normalizeToLF,
  detectLineEnding,
  restoreLineEndings,
  stripBom,
  countOccurrences,
  normText,
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit a file using exact text replacement. One edit per tool call. " +
      "Each call targets a single file with one oldText/newText pair. " +
      "The oldText must match a unique, non-overlapping region of the file. " +
      "Keep oldText as small as possible while still being unique. " +
      "Do not pad with large unchanged regions.",
    promptSnippet:
      "Make precise file edits with exact text replacement. One edit per tool call.",
    promptGuidelines: [
      "Use edit for precise changes (oldText must match exactly)",
      "Each tool call edits one file with one replacement",
      "Keep oldText as small as possible while still being unique",
      "Do not include large unchanged regions just to connect changes",
    ],
    parameters,
    renderShell: "self",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { path, oldText, newText } = params;

      if (!oldText) {
        throw new Error("oldText must not be empty.");
      }

      const absPath = resolvePath(path, ctx.cwd);

      try {
        const { baseContent, newContent, errorMsg } = await withFileMutationQueue(
          absPath,
          async () => {
            try {
              await access(absPath, constants.R_OK | constants.W_OK);
            } catch (err: any) {
              const code = err?.code ?? String(err);
              throw new Error(`Could not edit file: ${path}. ${code}.`);
            }

            if (signal?.aborted) throw new Error("Operation aborted");

            // Read and strip BOM
            const rawBuf = (await readFile(absPath, "utf-8"));
            const { bom, text: noBom } = stripBom(rawBuf);

            if (signal?.aborted) throw new Error("Operation aborted");

            // Detect original line ending, then normalize to LF for matching
            const originalEnding = detectLineEnding(noBom);
            const lfContent = normalizeToLF(noBom);

            // Normalize oldText and newText to LF for matching workspace
            const lfOldText = normalizeToLF(oldText);
            const lfNewText = normalizeToLF(newText);

            const m = findText(lfContent, lfOldText);
            if (!m.found) {
              const snippet = oldText.split("\n")[0].trim().slice(0, 80);
              throw new Error(
                `Could not find exact text in ${path}: "${snippet}${oldText.length > 80 ? '…' : ''}" — must match exactly including whitespace and newlines.`,
              );
            }

            if (m.occurrences > 1) {
              const snippet = oldText.split("\n")[0].trim().slice(0, 80);
              throw new Error(
                `Found ${m.occurrences} occurrences of "${snippet}${oldText.length > 80 ? '…' : ''}" in ${path}. oldText must be unique — add surrounding context to disambiguate.`,
              );
            }

            // On fuzzy path, work in normalized content and normalize newText too
            const targetContent = m.fuzzy ? normText(lfContent) : lfContent;
            const finalNewText = m.fuzzy ? normText(lfNewText) : lfNewText;
            const newContent =
              targetContent.slice(0, m.index) + finalNewText + targetContent.slice(m.index + m.length);

            if (newContent === targetContent) {
              throw new Error(
                `No changes made to ${path}. The replacement produced identical content.`,
              );
            }

            // Restore original line endings and re-add BOM before writing
            const output = bom + restoreLineEndings(newContent, originalEnding);
            await writeFile(absPath, output, "utf-8");

            // Return LF-normalized versions for diff generation
            return { baseContent: targetContent, newContent, errorMsg: undefined };
          },
        );

        const diff = generateDiffString(baseContent, newContent);

        return {
          content: [
            {
              type: "text",
              text: `<edit_success path="${path}">\n${diff}\n</edit_success>`,
            },
          ],
          details: { path, ok: true, diff },
        };
      } catch (err: any) {
        const errorMsg = err?.message ?? String(err);
        return {
          content: [
            {
              type: "text",
              text: `<edit_failure path="${path}">\n${errorMsg}\n</edit_failure>`,
            },
          ],
          details: { path, ok: false, error: errorMsg },
        };
      }
    },

    renderCall(args, theme, context) {
      // When result is complete, return empty so only renderResult shows
      if (!context.isPartial) {
        return new Container();
      }
      // Pending: show file path
      const path = args?.path ?? "...";
      const headerBox = new Box(1, 1, (text) => text);
      headerBox.setBgFn((text) => theme.bg("toolPendingBg", text));
      const header = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}`;
      headerBox.addChild(new Text(header, 0, 0));
      return headerBox;
    },

    renderResult(result, _options, theme, context) {
      const details = (result as any).details ?? {};
      const path = details.path ?? "...";
      const ok = details.ok ?? false;
      const diff = details.diff;
      const error = details.error;

      // If the tool threw an exception (not caught), show it as failure
      if (context.isError) {
        const errText = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n");
        const isAborted = errText.toLowerCase().includes("abort") || errText.toLowerCase().includes("cancel");
        return buildResultBox(
          path,
          false,
          undefined,
          isAborted ? "Cancelled" : (errText || "Unknown error"),
          theme,
        );
      }

      return buildResultBox(path, ok, diff, error, theme);
    },
  });
}
