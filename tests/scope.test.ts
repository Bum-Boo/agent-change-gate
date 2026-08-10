import { describe, expect, it } from "vitest";

import {
  applyReplacement,
  captureScope,
  findFrontmatterRange,
  isSnapshotCurrent,
  resolveScopeRange,
  scopeContextKey,
} from "../src/core/scope";

describe("note scope capture", () => {
  it("separates YAML frontmatter from the body", () => {
    const text = "---\ntitle: Test\n---\n# Heading\nBody";
    expect(findFrontmatterRange(text)).toEqual({ from: 0, to: 20 });
    expect(resolveScopeRange(text, "body")).toEqual({ from: 20, to: text.length });
    expect(resolveScopeRange(text, "frontmatter")).toEqual({ from: 0, to: 20 });
  });

  it("supports CRLF and a YAML ellipsis terminator", () => {
    const text = "---\r\ntitle: Test\r\n...\r\nBody";
    const range = findFrontmatterRange(text);
    expect(range).not.toBeNull();
    expect(text.slice(range?.to)).toBe("Body");
  });

  it("requires a non-empty explicit selection", () => {
    expect(() => resolveScopeRange("hello", "selection", { from: 2, to: 2 })).toThrow(/Select/);
    expect(resolveScopeRange("hello", "selection", { from: 4, to: 1 })).toEqual({ from: 1, to: 4 });
  });

  it("applies only the captured scope", () => {
    const text = "---\ntitle: Keep\n---\nOld body";
    const snapshot = captureScope("A.md", text, "body");
    expect(applyReplacement(snapshot, "New body")).toBe("---\ntitle: Keep\n---\nNew body");
  });

  it("binds a snapshot to both note path and exact content", () => {
    const snapshot = captureScope("A.md", "alpha", "body");
    expect(isSnapshotCurrent(snapshot, "A.md", "alpha")).toBe(true);
    expect(isSnapshotCurrent(snapshot, "B.md", "alpha")).toBe(false);
    expect(isSnapshotCurrent(snapshot, "A.md", "alpha changed")).toBe(false);
  });

  it("adds a line break before a new body when frontmatter ends at EOF", () => {
    const snapshot = captureScope("Note.md", "---\ntitle: A\n---", "body");
    expect(applyReplacement(snapshot, "Body")).toBe("---\ntitle: A\n---\nBody");
  });

  it("keeps repeated selection text in different ranges out of exact-scope history", () => {
    const text = "TODO then TODO";
    const first = captureScope("A.md", text, "selection", { from: 0, to: 4 });
    const second = captureScope("A.md", text, "selection", { from: 10, to: 14 });
    expect(first.originalScope).toBe(second.originalScope);
    expect(scopeContextKey(first)).not.toBe(scopeContextKey(second));
  });
});
