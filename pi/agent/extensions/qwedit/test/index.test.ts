import { describe, it, expect, beforeEach } from "vitest";
import {
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
} from "../index";

// ── resolvePath ────────────────────────────────────────────────────────────

describe("resolvePath", () => {
  it("returns absolute paths as-is", () => {
    expect(resolvePath("/foo/bar.txt", "/cwd")).toBe("/foo/bar.txt");
  });

  it("resolves relative paths against cwd", () => {
    expect(resolvePath("foo/bar.txt", "/cwd")).toBe("/cwd/foo/bar.txt");
  });

  it("resolves ~ to home directory", () => {
    expect(resolvePath("~", "/cwd")).toBe(process.env.HOME);
  });

  it("resolves ~/subpath to home directory", () => {
    expect(resolvePath("~/foo/bar.txt", "/cwd")).toBe(
      process.env.HOME + "/foo/bar.txt",
    );
  });
});

// ── findText ───────────────────────────────────────────────────────────────

describe("findText", () => {
  it("finds exact match", () => {
    const result = findText("hello world", "hello");
    expect(result.found).toBe(true);
    expect(result.index).toBe(0);
    expect(result.length).toBe(5);
  });

  it("returns not found for missing text", () => {
    const result = findText("hello world", "goodbye");
    expect(result.found).toBe(false);
    expect(result.index).toBe(-1);
  });

  it("normalizes trailing whitespace", () => {
    const result = findText("hello   \nworld", "hello\nworld");
    expect(result.found).toBe(true);
  });

  it("normalizes curly quotes to straight quotes", () => {
    const result = findText('She said "hello"', "She said \u201chello\u201d");
    expect(result.found).toBe(true);
  });

  it("normalizes curly single quotes", () => {
    const result = findText("He said 'world'", "He said \u2018world\u2019");
    expect(result.found).toBe(true);
  });

  it("finds multi-line text", () => {
    const content = "line1\nline2\nline3\nline4";
    const result = findText(content, "line2\nline3");
    expect(result.found).toBe(true);
    expect(result.index).toBe(6);
  });

  it("prefers exact match over normalized match", () => {
    const result = findText("hello world", "hello");
    expect(result.found).toBe(true);
    expect(result.index).toBe(0);
  });

  it("handles empty content", () => {
    const result = findText("", "anything");
    expect(result.found).toBe(false);
  });

  it("handles empty oldText", () => {
    const result = findText("hello", "");
    expect(result.found).toBe(true);
    expect(result.index).toBe(0);
  });

  it("returns occurrences count for exact match", () => {
    const result = findText("hello world hello", "hello");
    expect(result.found).toBe(true);
    expect(result.occurrences).toBe(2);
  });

  it("returns occurrences of 1 for unique match", () => {
    const result = findText("hello world", "hello");
    expect(result.found).toBe(true);
    expect(result.occurrences).toBe(1);
  });

  it("returns occurrences count for fuzzy match", () => {
    const result = findText("hello   \nworld   \nhello   \nworld   ", "hello\nworld");
    expect(result.found).toBe(true);
    expect(result.occurrences).toBe(2);
    expect(result.fuzzy).toBe(true);
  });

  it("sets fuzzy flag to false for exact match", () => {
    const result = findText("hello world", "hello");
    expect(result.fuzzy).toBe(false);
  });

  it("sets fuzzy flag to true for fuzzy match", () => {
    const result = findText("hello   \nworld", "hello\nworld");
    expect(result.fuzzy).toBe(true);
  });
});

// ── normalizeToLF ──────────────────────────────────────────────────────────

describe("normalizeToLF", () => {
  it("converts CRLF to LF", () => {
    expect(normalizeToLF("hello\r\nworld\r\n")).toBe("hello\nworld\n");
  });

  it("converts lone CR to LF", () => {
    expect(normalizeToLF("hello\rworld")).toBe("hello\nworld");
  });

  it("leaves LF-only content unchanged", () => {
    expect(normalizeToLF("hello\nworld")).toBe("hello\nworld");
  });

  it("handles mixed line endings", () => {
    expect(normalizeToLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

// ── detectLineEnding ───────────────────────────────────────────────────────

describe("detectLineEnding", () => {
  it("detects CRLF when it appears first", () => {
    expect(detectLineEnding("hello\r\nworld\n")).toBe("\r\n");
  });

  it("detects LF when only LF present", () => {
    expect(detectLineEnding("hello\nworld")).toBe("\n");
  });

  it("returns LF when no line endings", () => {
    expect(detectLineEnding("hello")).toBe("\n");
  });

  it("returns LF when LF appears before CRLF", () => {
    expect(detectLineEnding("hello\nworld\r\n")).toBe("\n");
  });
});

// ── restoreLineEndings ─────────────────────────────────────────────────────

describe("restoreLineEndings", () => {
  it("converts LF to CRLF", () => {
    expect(restoreLineEndings("hello\nworld\n", "\r\n")).toBe("hello\r\nworld\r\n");
  });

  it("leaves content unchanged for LF ending", () => {
    expect(restoreLineEndings("hello\nworld\n", "\n")).toBe("hello\nworld\n");
  });
});

// ── stripBom ───────────────────────────────────────────────────────────────

describe("stripBom", () => {
  it("strips UTF-8 BOM", () => {
    const result = stripBom("\uFEFFhello");
    expect(result.bom).toBe("\uFEFF");
    expect(result.text).toBe("hello");
  });

  it("leaves content without BOM unchanged", () => {
    const result = stripBom("hello");
    expect(result.bom).toBe("");
    expect(result.text).toBe("hello");
  });
});

// ── countOccurrences ───────────────────────────────────────────────────────

describe("countOccurrences", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("aaa", "aa")).toBe(1);
  });

  it("counts multiple occurrences", () => {
    expect(countOccurrences("hello world hello", "hello")).toBe(2);
  });

  it("returns 0 for no matches", () => {
    expect(countOccurrences("hello", "goodbye")).toBe(0);
  });

  it("returns Infinity for empty needle", () => {
    expect(countOccurrences("hello", "")).toBe(Infinity);
  });
});

// ── normText ───────────────────────────────────────────────────────────────

describe("normText", () => {
  it("strips trailing whitespace per line", () => {
    expect(normText("hello   \nworld  ")).toBe("hello\nworld");
  });

  it("normalizes smart quotes", () => {
    expect(normText("\u201chello\u201d")).toBe('"hello"');
    expect(normText("\u2018world\u2019")).toBe("'world'");
  });

  it("normalizes unicode dashes to hyphen", () => {
    expect(normText("a\u2013b\u2014c")).toBe("a-b-c");
  });

  it("normalizes special spaces", () => {
    expect(normText("a\u00A0b\u3000c")).toBe("a b c");
  });
});

// ── generateDiffString ─────────────────────────────────────────────────────

describe("generateDiffString", () => {
  it("generates a simple diff", () => {
    const diff = generateDiffString("hello world\n", "hello universe\n");
    expect(diff).toContain("-1 hello world");
    expect(diff).toContain("+1 hello universe");
  });

  it("shows context around changes", () => {
    const old = "line1\nline2\nline3\nline4\nline5\n";
    const nw = "line1\nline2\nMODIFIED\nline4\nline5\n";
    const diff = generateDiffString(old, nw);
    expect(diff).toContain("line2");
    expect(diff).toContain("-3 line3");
    expect(diff).toContain("+3 MODIFIED");
    expect(diff).toContain("line4");
  });

  it("handles no changes", () => {
    const content = "hello world\n";
    const diff = generateDiffString(content, content);
    expect(diff).toBe("");
  });

  it("handles multi-line changes", () => {
    const old = "line1\nline2\nline3\nline4\nline5\n";
    const nw = "line1\nline2\nMODIFIED_A\nMODIFIED_B\nline5\n";
    const diff = generateDiffString(old, nw);
    expect(diff).toContain("-3 line3");
    expect(diff).toContain("-4 line4");
    expect(diff).toContain("+3 MODIFIED_A");
    expect(diff).toContain("+4 MODIFIED_B");
  });

  it("truncates large context with ...", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
    const old = lines.join("\n") + "\n";
    const nw = lines.map((l, i) => i === 50 ? "MODIFIED" : l).join("\n") + "\n";
    const diff = generateDiffString(old, nw);
    expect(diff).toContain("...");
    expect(diff).toContain("MODIFIED");
  });

  it("handles line number width padding", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
    const old = lines.join("\n") + "\n";
    const nw = lines.map((l, i) => i === 50 ? "MODIFIED" : l).join("\n") + "\n";
    const diff = generateDiffString(old, nw);
    expect(diff).toMatch(/ {2}\d{2}/);
    expect(diff).toContain("...\n");
  });
});

// ── replaceTabs ────────────────────────────────────────────────────────────

describe("replaceTabs", () => {
  it("replaces tabs with spaces", () => {
    expect(replaceTabs("hello\tworld")).toBe("hello   world");
  });

  it("handles multiple tabs", () => {
    expect(replaceTabs("\t\tindented")).toBe("      indented");
  });

  it("handles no tabs", () => {
    expect(replaceTabs("no tabs here")).toBe("no tabs here");
  });
});

// ── parseDiffLine ──────────────────────────────────────────────────────────

describe("parseDiffLine", () => {
  it("parses removed lines", () => {
    const parsed = parseDiffLine("-5 hello world");
    expect(parsed).toEqual({ prefix: "-", lineNum: "5", content: "hello world" });
  });

  it("parses added lines", () => {
    const parsed = parseDiffLine("+5 hello world");
    expect(parsed).toEqual({ prefix: "+", lineNum: "5", content: "hello world" });
  });

  it("parses context lines", () => {
    const parsed = parseDiffLine(" 5 hello world");
    expect(parsed).toEqual({ prefix: " ", lineNum: "5", content: "hello world" });
  });

  it("returns null for invalid lines", () => {
    expect(parseDiffLine("invalid line")).toBeNull();
  });

  it("handles empty content", () => {
    const parsed = parseDiffLine("-5 ");
    expect(parsed).toEqual({ prefix: "-", lineNum: "5", content: "" });
  });

  it("handles lines without numbers", () => {
    const parsed = parseDiffLine("+ ...");
    expect(parsed).toEqual({ prefix: "+", lineNum: " ", content: "..." });
  });
});

// ── mergeAdjacentChanges ───────────────────────────────────────────────────

describe("mergeAdjacentChanges", () => {
  it("merges adjacent removed/added with whitespace", () => {
    const parts = [
      { removed: true, value: "hello" },
      { value: " " },
      { added: true, value: "goodbye" },
    ];
    const result = mergeAdjacentChanges(parts);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ removed: true, value: "hello " });
    expect(result[1]).toEqual({ added: true, value: " goodbye" });
  });

  it("leaves non-adjacent changes separate", () => {
    const parts = [
      { removed: true, value: "old" },
      { value: " middle " },
      { added: true, value: "new" },
    ];
    const result = mergeAdjacentChanges(parts);
    expect(result).toHaveLength(3);
  });

  it("handles empty input", () => {
    expect(mergeAdjacentChanges([])).toEqual([]);
  });

  it("handles only common tokens", () => {
    const parts = [
      { value: "common1" },
      { value: "common2" },
    ];
    const result = mergeAdjacentChanges(parts);
    expect(result).toEqual(parts);
  });

  it("merges consecutive removed tokens", () => {
    const parts = [
      { removed: true, value: "hello" },
      { removed: true, value: " world" },
    ];
    const result = mergeAdjacentChanges(parts);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ removed: true, value: "hello world" });
  });
});
