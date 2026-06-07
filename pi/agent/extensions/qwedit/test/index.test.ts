import { describe, it, expect, beforeEach } from "vitest";
import {
  resolvePath,
  groupByPath,
  findText,
  applyEdits,
  generateDiffString,
  replaceTabs,
  parseDiffLine,
  mergeAdjacentChanges,
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

// ── groupByPath ────────────────────────────────────────────────────────────

describe("groupByPath", () => {
  it("groups edits by resolved path", () => {
    const edits = [
      { path: "/foo/a.txt", oldText: "x", newText: "y" },
      { path: "/foo/b.txt", oldText: "p", newText: "q" },
      { path: "/foo/a.txt", oldText: "z", newText: "w" },
    ];
    const groups = groupByPath(edits, "/cwd");
    expect(groups.size).toBe(2);
    expect(groups.get("/foo/a.txt")!.edits.length).toBe(2);
    expect(groups.get("/foo/b.txt")!.edits.length).toBe(1);
  });

  it("preserves original path in group metadata", () => {
    const edits = [
      { path: "relative.txt", oldText: "x", newText: "y" },
    ];
    const groups = groupByPath(edits, "/cwd");
    const group = groups.get("/cwd/relative.txt")!;
    expect(group.originalPath).toBe("relative.txt");
  });

  it("merges edits for the same file from different path forms", () => {
    const home = process.env.HOME!;
    const edits = [
      { path: "~/file.txt", oldText: "a", newText: "b" },
      { path: `${home}/file.txt`, oldText: "c", newText: "d" },
    ];
    const groups = groupByPath(edits, "/cwd");
    expect(groups.size).toBe(1);
    expect(groups.get(`${home}/file.txt`)!.edits.length).toBe(2);
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
    // If exact match exists, use it (indexOf finds it first)
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
});

// ── applyEdits ─────────────────────────────────────────────────────────────

describe("applyEdits", () => {
  it("applies a single edit", () => {
    const result = applyEdits("hello world", [{ oldText: "world", newText: "universe" }], "test.txt");
    expect(result.content).toBe("hello universe");
    expect(result.errors).toHaveLength(0);
  });

  it("applies multiple non-overlapping edits", () => {
    const content = "alpha beta gamma delta";
    const result = applyEdits(content, [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "gamma", newText: "GAMMA" },
      { oldText: "delta", newText: "DELTA" },
    ], "test.txt");
    expect(result.content).toBe("ALPHA beta GAMMA DELTA");
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty oldText", () => {
    const result = applyEdits("hello", [{ oldText: "", newText: "world" }], "test.txt");
    expect(result.content).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("[edit 1]");
    expect(result.errors[0]).toContain("oldText must not be empty");
  });

  it("reports not-found with snippet", () => {
    const result = applyEdits("hello world", [{ oldText: "goodbye", newText: "replaced" }], "test.txt");
    expect(result.content).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("[edit 1]");
    expect(result.errors[0]).toContain("goodbye");
  });

  it("truncates long oldText in error snippet", () => {
    const longText = "a".repeat(100);
    const result = applyEdits("hello", [{ oldText: longText, newText: "replaced" }], "test.txt");
    expect(result.errors[0]).toContain("…");
    // Snippet should be first line trimmed, max 80 chars + …
    const snippetMatch = result.errors[0].match(/"([^"]+)"/);
    expect(snippetMatch![1].length).toBe(81); // 80 chars + …
  });

  it("reports multi-line oldText with first line only", () => {
    const result = applyEdits("hello", [{ oldText: "very long first line that exceeds eighty characters so it should be truncated\nsecond line\nthird line", newText: "replaced" }], "test.txt");
    expect(result.errors[0]).toContain("very long first line that exceeds eighty characters so it should be tr");
    expect(result.errors[0]).toContain("…");
    expect(result.errors[0]).not.toContain("second line");
  });

  it("detects overlapping edits", () => {
    const content = "lineA\nlineB\nlineC\nlineD";
    const result = applyEdits(content, [
      { oldText: "lineA\nlineB\nlineC", newText: "X\nlineB\nY" },
      { oldText: "lineB\nlineC\nlineD", newText: "M\nlineC\nN" },
    ], "test.txt");
    expect(result.content).not.toBeNull(); // first edit applied
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("[edit 1, 2]");
    expect(result.errors[0]).toContain("overlap");
  });

  it("applies non-overlapping edits when some overlap", () => {
    const content = "lineA\nlineB\nlineC\nlineD\nlineE";
    const result = applyEdits(content, [
      { oldText: "lineA", newText: "REPLACED_A" },
      { oldText: "lineB\nlineC\nlineD", newText: "X\nlineB\nY" },
      { oldText: "lineC\nlineD\nlineE", newText: "M\nlineC\nN" },
    ], "test.txt");
    expect(result.content).toBe("REPLACED_A\nX\nlineB\nY\nlineE");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("[edit 2, 3]");
  });

  it("handles partial failure (not-found + success)", () => {
    const content = "alpha beta gamma";
    const result = applyEdits(content, [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "does not exist", newText: "replaced" },
      { oldText: "gamma", newText: "GAMMA" },
    ], "test.txt");
    expect(result.content).toBe("ALPHA beta GAMMA");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("[edit 2]");
  });

  it("rejects no-op edits", () => {
    const content = "hello world";
    const result = applyEdits(content, [{ oldText: "hello", newText: "hello" }], "test.txt");
    expect(result.content).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("identical content");
  });

  it("applies edits from back to front (preserves positions)", () => {
    const content = "a b c d e";
    const result = applyEdits(content, [
      { oldText: "e", newText: "E" },
      { oldText: "a", newText: "A" },
      { oldText: "c", newText: "C" },
    ], "test.txt");
    expect(result.content).toBe("A b C d E");
  });

  it("reports all errors when all edits fail", () => {
    const content = "hello";
    const result = applyEdits(content, [
      { oldText: "not here", newText: "replaced" },
      { oldText: "also not here", newText: "replaced" },
    ], "test.txt");
    expect(result.content).toBeNull();
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("[edit 1]");
    expect(result.errors[1]).toContain("[edit 2]");
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
    // Line numbers should be padded to 3 chars for 100 lines
    expect(diff).toMatch(/ {2}\d{2}/);  // space-padded to 3 chars
    expect(diff).toContain("...\n");  // context truncation
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
