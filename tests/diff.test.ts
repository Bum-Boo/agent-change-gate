import { describe, expect, it } from "vitest";

import { diffLines, type LineDiffOperation } from "../src/core/diff";

function operationText(operation: LineDiffOperation): string {
  return operation.lines.map((line) => `${line.text}${line.ending}`).join("");
}

function compact(operations: LineDiffOperation[]): Array<[string, string]> {
  return operations.map((operation) => [operation.kind, operationText(operation)]);
}

function reconstructBefore(operations: LineDiffOperation[]): string {
  return operations
    .filter((operation) => operation.kind !== "add")
    .map(operationText)
    .join("");
}

function reconstructAfter(operations: LineDiffOperation[]): string {
  return operations
    .filter((operation) => operation.kind !== "remove")
    .map(operationText)
    .join("");
}

describe("bounded line diff", () => {
  it("finds a line insertion and retains usable line positions", () => {
    const result = diffLines("alpha\ngamma\n", "alpha\nbeta\ngamma\n");

    expect(result.exact).toBe(true);
    expect(compact(result.operations)).toEqual([
      ["equal", "alpha\n"],
      ["add", "beta\n"],
      ["equal", "gamma\n"],
    ]);
    expect(result.operations.map(({ kind, oldStart, newStart }) => ({ kind, oldStart, newStart }))).toEqual([
      { kind: "equal", oldStart: 0, newStart: 0 },
      { kind: "add", oldStart: 1, newStart: 1 },
      { kind: "equal", oldStart: 1, newStart: 2 },
    ]);
  });

  it("finds a deletion", () => {
    const result = diffLines("alpha\nbeta\ngamma", "alpha\ngamma");

    expect(compact(result.operations)).toEqual([
      ["equal", "alpha\n"],
      ["remove", "beta\n"],
      ["equal", "gamma"],
    ]);
  });

  it("represents a changed line as removal followed by addition", () => {
    const before = "heading\nold value\nfooter";
    const after = "heading\nnew value\nfooter";
    const result = diffLines(before, after);

    expect(compact(result.operations)).toEqual([
      ["equal", "heading\n"],
      ["remove", "old value\n"],
      ["add", "new value\n"],
      ["equal", "footer"],
    ]);
    expect(reconstructBefore(result.operations)).toBe(before);
    expect(reconstructAfter(result.operations)).toBe(after);
  });

  it("preserves CRLF terminators exactly", () => {
    const before = "alpha\r\nbeta\r\n";
    const after = "alpha\r\ngamma\r\n";
    const result = diffLines(before, after);

    expect(compact(result.operations)).toEqual([
      ["equal", "alpha\r\n"],
      ["remove", "beta\r\n"],
      ["add", "gamma\r\n"],
    ]);
    expect(result.operations.flatMap((operation) => operation.lines).every((line) => line.ending === "\r\n")).toBe(true);
    expect(reconstructBefore(result.operations)).toBe(before);
    expect(reconstructAfter(result.operations)).toBe(after);
  });

  it("handles empty inputs without manufacturing an empty line", () => {
    expect(diffLines("", "").operations).toEqual([]);
    expect(compact(diffLines("", "one").operations)).toEqual([["add", "one"]]);
    expect(compact(diffLines("one", "").operations)).toEqual([["remove", "one"]]);
  });

  it("uses a complete coarse replacement when exact LCS work exceeds the bound", () => {
    const before = "keep\na\nb\nc\ntail";
    const after = "keep\nx\ny\nz\ntail";
    const result = diffLines(before, after, { maxCells: 4 });

    expect(result).toMatchObject({
      exact: false,
      truncated: false,
      fallbackReason: "complexity",
    });
    expect(compact(result.operations)).toEqual([
      ["equal", "keep\n"],
      ["remove", "a\nb\nc\n"],
      ["add", "x\ny\nz\n"],
      ["equal", "tail"],
    ]);
    expect(reconstructBefore(result.operations)).toBe(before);
    expect(reconstructAfter(result.operations)).toBe(after);
  });

  it("omits payloads before tokenization when input exceeds the size bound", () => {
    const result = diffLines("123456", "abcdef", { maxInputCharacters: 10 });

    expect(result).toMatchObject({
      exact: false,
      truncated: true,
      fallbackReason: "input-size",
    });
    expect(result.operations).toEqual([
      { kind: "remove", oldStart: 0, newStart: 0, lines: [], omittedCharacters: 6 },
      { kind: "add", oldStart: 0, newStart: 0, lines: [], omittedCharacters: 6 },
    ]);
  });

  it("stops line tokenization at the configured line bound", () => {
    const result = diffLines("a\nb\nc\n", "a\nb\nd\n", { maxLines: 4 });

    expect(result).toMatchObject({
      exact: false,
      truncated: true,
      fallbackReason: "line-count",
    });
    expect(result.operations.every((operation) => operation.lines.length === 0)).toBe(true);
  });
});
